import type { DuckDBConnection, DuckDBInstance, DuckDBResultReader } from '@duckdb/node-api'
import { lstatSync, readdirSync } from 'node:fs'
import { isAbsolute, join, sep } from 'node:path'
import { duckdbDialect } from '../dialect.js'
import { checkAffected, elapsed, QueryCancelledError, ReadOnlyViolationError, type DatabaseDriver, type IntrospectOptions, type StreamBatch, type StreamOptions } from '../driver.js'
import type { BuiltQuery } from '../filters.js'
import type { CellValue, ConnectionConfig, QueryOptions, QueryResult, SchemaSnapshot, ServerInfo, TableInfo, TransactionState } from '../types.js'
import { normalizeValue } from '../values.js'

type DuckDBModule = typeof import('@duckdb/node-api')

let modulePromise: Promise<DuckDBModule> | undefined

/** Loaded on first use: the native binding is large and missing on some platforms. */
function loadDuckDB(): Promise<DuckDBModule> {
  modulePromise ??= import('@duckdb/node-api').catch((err: unknown) => {
    modulePromise = undefined
    throw new Error(`DuckDB is not available on this platform (${err instanceof Error ? err.message : String(err)})`)
  })
  return modulePromise
}

const RESULT_QUERY = 3
const RESULT_CHANGED_ROWS = 1

/**
 * DuckDB, in process: a `.duckdb` file or an in-memory database. Besides its own tables it queries CSV,
 * Parquet and JSON files directly (`SELECT * FROM 'sales.csv'`).
 */
export class DuckDBDriver implements DatabaseDriver {
  readonly dialect = duckdbDialect
  private instance?: DuckDBInstance
  private sessions = new Map<string, DuckDBConnection>()
  /**
   * SQL nobody confirmed runs on an instance of its own: the database file opened read-only (an in-memory
   * connection: an empty one), external access off, extensions neither loaded nor installed, and the configuration
   * locked, with exactly the files this connection was given still readable: its `files` (saved with the connection:
   * "Query a file" and dropped files in the app, --allow-files for dbmastermind-mcp and dbm) and those handed to it
   * while it is open (allowFile). DuckDB can't turn external access back on in a running instance, so the user's own
   * instance is never touched.
   */
  private guarded?: { instance: DuckDBInstance; files: string }
  private allowed = new Set<string>()

  /** A file or folder the user handed to this connection: SQL nobody confirmed may read it too. */
  allowFile(path: string): void {
    this.allowed.add(path)
  }

  private async guardedInstance(): Promise<DuckDBInstance> {
    const entries = allowedEntries([...this.allowed])
    const files = JSON.stringify(entries)
    if (this.guarded?.files === files) return this.guarded.instance
    this.guarded?.instance.closeSync()
    this.guarded = undefined
    const duckdb = await loadDuckDB()
    const path = this.config.filePath?.trim() || ':memory:'
    const instance = await duckdb.DuckDBInstance.create(path, path === ':memory:' ? {} : { access_mode: 'READ_ONLY' })
    const conn = await instance.connect()
    try {
      const list = (items: string[]) => items.map((f) => `'${f.replaceAll("'", "''")}'`).join(', ')
      for (const sql of [`SET allowed_paths = [${list(entries.paths)}]`, `SET allowed_directories = [${list(entries.dirs)}]`, 'SET autoload_known_extensions = false', 'SET autoinstall_known_extensions = false', 'SET enable_external_access = false', 'SET lock_configuration = true']) await conn.run(sql)
    } finally {
      conn.closeSync()
    }
    this.guarded = { instance, files }
    return instance
  }

  constructor(readonly config: ConnectionConfig) {
    for (const f of config.files ?? []) this.allowed.add(f)
  }

  async connect(): Promise<void> {
    const duckdb = await loadDuckDB()
    const path = this.config.filePath?.trim() || ':memory:'
    const options: Record<string, string> = {}
    if (this.config.readOnly && path !== ':memory:') options.access_mode = 'READ_ONLY'
    // Checkpoint after every commit: the file is always complete for other readers, and no WAL is left to replay.
    else if (path !== ':memory:') options.checkpoint_threshold = '0b'
    this.instance = await duckdb.DuckDBInstance.create(path, options)
    const probe = await this.instance.connect()
    probe.closeSync()
  }

  async close(): Promise<void> {
    this.guarded?.instance.closeSync()
    this.guarded = undefined
    for (const c of this.sessions.values()) c.closeSync()
    this.sessions.clear()
    if (this.instance && this.config.filePath?.trim() && !this.config.readOnly) {
      // Leave no WAL behind: replaying some WAL entries (comments on tables with nextval defaults) fails in DuckDB 1.4.
      const conn = await this.instance.connect()
      await conn.run('CHECKPOINT').catch(() => {})
      conn.closeSync()
    }
    this.instance?.closeSync()
    this.instance = undefined
  }

  private get db(): DuckDBInstance {
    if (!this.instance) throw new Error('Not connected')
    return this.instance
  }

  /** One connection per statement keeps cancellation (interrupt) from hitting other queries. */
  private async acquire(session?: string): Promise<{ conn: DuckDBConnection; release: () => void }> {
    if (!session) {
      const conn = await this.db.connect()
      return { conn, release: () => conn.closeSync() }
    }
    let conn = this.sessions.get(session)
    if (!conn) {
      conn = await this.db.connect()
      this.sessions.set(session, conn)
    }
    return { conn, release: () => {} }
  }

  /**
   * Outside a transaction every statement gets a new id; inside one the id stays. Any error inside a DuckDB
   * transaction aborts it (even a second BEGIN, so that can't be the probe).
   */
  async transactionState(session: string): Promise<TransactionState> {
    const conn = this.sessions.get(session)
    if (!conn) return 'none'
    try {
      const id = async () => String((await conn.runAndReadAll('SELECT txid_current()')).getRows()[0]?.[0])
      return (await id()) === (await id()) ? 'open' : 'none'
    } catch (err) {
      return /transaction is aborted/i.test(String((err as Error).message)) ? 'failed' : 'none'
    }
  }

  async releaseSession(session: string): Promise<void> {
    const conn = this.sessions.get(session)
    this.sessions.delete(session)
    if (!conn) return
    await conn.run('ROLLBACK').catch(() => {})
    conn.closeSync()
  }

  async execute(sql: string, options: QueryOptions = {}): Promise<QueryResult[]> {
    if (options.signal?.aborted) throw new QueryCancelledError()
    // (SQL nobody confirmed: a connection of the guarded instance, closed afterwards.)
    const { conn, release } = options.unconfirmed ? await (async () => {
      const c = await (await this.guardedInstance()).connect()
      return { conn: c, release: () => c.closeSync() }
    })() : await this.acquire(options.session)
    let cancelled = false
    const onAbort = () => {
      cancelled = true
      conn.interrupt()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const start = process.hrtime.bigint()
    try {
      const params = options.params as Parameters<DuckDBConnection['run']>[1]
      // DuckDB's own parser decides: one statement, and one that reads (a SELECT, which SHOW, DESCRIBE, SUMMARIZE
      // and FROM … are to it, or an EXPLAIN).
      if (options.unconfirmed) {
        const duckdb = await loadDuckDB()
        const statements = await conn.extractStatements(sql)
        if (statements.count !== 1) throw new ReadOnlyViolationError('Only one statement at a time is allowed here.')
        const prepared = await statements.prepare(0)
        if (prepared.statementType !== duckdb.StatementType.SELECT && prepared.statementType !== duckdb.StatementType.EXPLAIN) throw new ReadOnlyViolationError(`Only reads are allowed here (read-only): DuckDB reads this as ${duckdb.StatementType[prepared.statementType] ?? 'a statement that is not a query'}.`)
      }
      const result: DuckDBResultReader =
        options.maxRows === undefined ? await conn.runAndReadAll(sql, params) : await conn.runAndReadUntil(sql, options.maxRows + 1, params)
      return [this.toResult(result, options.maxRows, elapsed(start))]
    } catch (err) {
      if (cancelled) throw new QueryCancelledError()
      throw options.unconfirmed ? fileRefusal(err) : err
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      release()
    }
  }

  async *stream(sql: string, options: StreamOptions = {}): AsyncGenerator<StreamBatch> {
    if (options.signal?.aborted) throw new QueryCancelledError()
    const duckdb = await loadDuckDB()
    // SQL nobody confirmed streams from the guarded instance, after DuckDB's parser said it is one read.
    const conn = options.unconfirmed ? await (await this.guardedInstance()).connect() : await this.db.connect()
    if (options.unconfirmed) {
      try {
        const statements = await conn.extractStatements(sql)
        if (statements.count !== 1) throw new ReadOnlyViolationError('Only one statement at a time is allowed here.')
        const prepared = await statements.prepare(0)
        if (prepared.statementType !== duckdb.StatementType.SELECT && prepared.statementType !== duckdb.StatementType.EXPLAIN) throw new ReadOnlyViolationError(`Only reads are allowed here (read-only): DuckDB reads this as ${duckdb.StatementType[prepared.statementType] ?? 'a statement that is not a query'}.`)
      } catch (err) {
        conn.closeSync()
        throw fileRefusal(err)
      }
    }
    let cancelled = false
    const onAbort = () => {
      cancelled = true
      conn.interrupt()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await conn.stream(sql, options.params as Parameters<DuckDBConnection['run']>[1])
      const types = result.columnTypes().map(String)
      const fields = result.columnNames().map((name, i) => ({ name, dataType: types[i] }))
      // DuckDB hands out vectors of ~2048 rows; that is the batch.
      for (let first = true; ; first = false) {
        const chunk = await result.fetchChunk()
        if (!chunk || chunk.rowCount === 0) {
          if (first && fields.length) yield { fields, rows: [] }
          return
        }
        yield { fields, rows: withBlobs(chunk.convertRows(duckdb.JsonDuckDBValueConverter) as unknown[][], types, () => chunk.getRows() as unknown[][]).map((r) => r.map((v) => normalizeValue(v) as CellValue)) }
      }
    } catch (err) {
      if (cancelled) throw new QueryCancelledError()
      throw options.unconfirmed ? fileRefusal(err) : err
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      conn.closeSync()
    }
  }

  private toResult(result: DuckDBResultReader, maxRows: number | undefined, durationMs: number): QueryResult {
    const command = statementName(result.statementType)
    if (result.returnType !== RESULT_QUERY) {
      const affected = result.returnType === RESULT_CHANGED_ROWS ? Number(result.rowsChanged) : undefined
      return { fields: [], rows: [], rowCount: affected ?? 0, affectedRows: affected, command, truncated: false, durationMs }
    }
    const names = result.columnNames()
    const types = result.columnTypes().map(String)
    let rows = withBlobs(result.getRowsJson() as unknown[][], types, () => result.getRows() as unknown[][])
    const truncated = maxRows !== undefined && rows.length > maxRows
    if (truncated) rows = rows.slice(0, maxRows)
    return {
      fields: names.map((name, i) => ({ name, dataType: types[i] })),
      rows: rows.map((r) => r.map((v) => normalizeValue(v) as CellValue)),
      rowCount: rows.length,
      command,
      truncated,
      durationMs,
    }
  }

  async transaction(statements: BuiltQuery[]): Promise<number[]> {
    const conn = await this.db.connect()
    try {
      await conn.run('BEGIN TRANSACTION')
      const affected: number[] = []
      for (const s of statements) {
        const r = await conn.run(s.sql, s.params as Parameters<DuckDBConnection['run']>[1])
        affected.push(checkAffected(s, Number(r.rowsChanged)))
      }
      await conn.run('COMMIT')
      return affected
    } catch (err) {
      await conn.run('ROLLBACK').catch(() => {})
      throw err
    } finally {
      conn.closeSync()
    }
  }

  private async rows(sql: string): Promise<Record<string, unknown>[]> {
    const conn = await this.db.connect()
    try {
      const r = await conn.runAndReadAll(sql)
      const names = r.columnNames()
      return (r.getRowsJson() as unknown[][]).map((row) => Object.fromEntries(names.map((n, i) => [n, row[i]])))
    } finally {
      conn.closeSync()
    }
  }

  async serverInfo(): Promise<ServerInfo> {
    const [r] = await this.rows('SELECT version() AS v')
    return { product: 'DuckDB', version: String(r?.v ?? '').replace(/^v/, '') }
  }

  async listDatabases(): Promise<string[]> {
    const rows = await this.rows('SELECT database_name FROM duckdb_databases() WHERE NOT internal ORDER BY database_name')
    return rows.map((r) => String(r.database_name))
  }

  async introspect(options: IntrospectOptions = {}): Promise<SchemaSnapshot> {
    const [{ db, schema: currentSchema } = { db: 'memory', schema: 'main' }] = (await this.rows('SELECT current_database() AS db, current_schema() AS schema')) as {
      db: string
      schema: string
    }[]
    const inDb = `database_name = '${db.replaceAll("'", "''")}'`
    const wanted = options.schemas?.length ? new Set(options.schemas) : null
    const [schemaRows, tableRows, viewRows, columnRows, constraintRows, indexRows, macroRows] = await Promise.all([
      this.rows(`SELECT DISTINCT schema_name FROM duckdb_schemas() WHERE ${inDb} AND schema_name NOT IN ('information_schema', 'pg_catalog') ORDER BY 1`),
      this.rows(`SELECT schema_name, table_name, comment, estimated_size FROM duckdb_tables() WHERE ${inDb} AND NOT internal`),
      this.rows(`SELECT schema_name, view_name, comment, sql FROM duckdb_views() WHERE ${inDb} AND NOT internal`),
      this.rows(
        `SELECT schema_name, table_name, column_name, column_index, data_type, is_nullable, column_default, comment
           FROM duckdb_columns() WHERE ${inDb} AND NOT internal ORDER BY schema_name, table_name, column_index`,
      ),
      this.rows(
        `SELECT schema_name, table_name, constraint_type, constraint_name, constraint_column_names, referenced_table, referenced_column_names
           FROM duckdb_constraints() WHERE ${inDb} AND constraint_type IN ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')`,
      ),
      this.rows(`SELECT schema_name, table_name, index_name, is_unique, expressions FROM duckdb_indexes() WHERE ${inDb}`),
      this.rows(`SELECT schema_name, function_name, function_type, parameters FROM duckdb_functions() WHERE ${inDb} AND NOT internal`),
    ])
    const keep = (schema: unknown) => !wanted || wanted.has(String(schema))
    const tables = new Map<string, TableInfo>()
    const key = (schema: unknown, name: unknown) => `${String(schema)}.${String(name)}`
    for (const t of tableRows.filter((r) => keep(r.schema_name))) {
      tables.set(key(t.schema_name, t.table_name), {
        schema: String(t.schema_name),
        name: String(t.table_name),
        type: 'table',
        comment: (t.comment as string | null) ?? null,
        rowEstimate: t.estimated_size == null ? null : Number(t.estimated_size),
        columns: [],
        primaryKey: [],
        foreignKeys: [],
        indexes: [],
      })
    }
    for (const v of viewRows.filter((r) => keep(r.schema_name))) {
      const body = String(v.sql ?? '').replace(/^\s*CREATE\s+(OR\s+REPLACE\s+)?VIEW\s+.+?\s+AS\s+/is, '').replace(/;\s*$/, '')
      tables.set(key(v.schema_name, v.view_name), {
        schema: String(v.schema_name),
        name: String(v.view_name),
        type: 'view',
        comment: (v.comment as string | null) ?? null,
        definition: body,
        columns: [],
        primaryKey: [],
        foreignKeys: [],
        indexes: [],
      })
    }
    for (const c of columnRows) {
      const t = tables.get(key(c.schema_name, c.table_name))
      if (!t) continue
      const def = c.column_default == null ? null : String(c.column_default)
      t.columns.push({
        name: String(c.column_name),
        ordinal: Number(c.column_index),
        dataType: String(c.data_type),
        nullable: Boolean(c.is_nullable),
        defaultValue: def,
        isPrimaryKey: false,
        isIdentity: !!def && /^nextval\(/i.test(def),
        comment: (c.comment as string | null) ?? null,
      })
    }
    for (const k of constraintRows) {
      const t = tables.get(key(k.schema_name, k.table_name))
      if (!t) continue
      const columns = (k.constraint_column_names as string[] | null) ?? []
      const name = String(k.constraint_name ?? `${t.name}_${columns.join('_')}`)
      if (k.constraint_type === 'PRIMARY KEY') {
        t.primaryKey = columns
        for (const c of t.columns) if (columns.includes(c.name)) c.isPrimaryKey = true
        t.indexes.push({ name, columns, unique: true, primary: true, constraint: true })
      } else if (k.constraint_type === 'UNIQUE') {
        t.indexes.push({ name, columns, unique: true, primary: false, constraint: true })
      } else {
        t.foreignKeys.push({ name, columns, refSchema: t.schema, refTable: String(k.referenced_table), refColumns: (k.referenced_column_names as string[] | null) ?? [] })
      }
    }
    for (const ix of indexRows) {
      const t = tables.get(key(ix.schema_name, ix.table_name))
      if (!t) continue
      const columns = String(ix.expressions ?? '')
        .replace(/^\[|\]$/g, '')
        .split(',')
        // A name that needs quotes (a keyword such as `name`) comes as '"name"'.
        .map((s) => s.trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1').replaceAll('""', '"'))
        .filter(Boolean)
      t.indexes.push({ name: String(ix.index_name), columns, unique: Boolean(ix.is_unique), primary: false })
    }
    return {
      database: this.config.filePath?.trim() || 'memory',
      defaultSchema: currentSchema,
      schemas: schemaRows.map((r) => String(r.schema_name)).filter(keep),
      tables: [...tables.values()].sort((a, b) => (a.schema ?? '').localeCompare(b.schema ?? '') || a.name.localeCompare(b.name)),
      routines: macroRows
        .filter((r) => keep(r.schema_name))
        .map((r) => ({
          schema: String(r.schema_name),
          name: String(r.function_name),
          kind: 'function' as const,
          arguments: ((r.parameters as string[] | null) ?? []).join(', '),
          returnType: r.function_type === 'table_macro' ? 'TABLE' : null,
        })),
      capturedAt: new Date().toISOString(),
    }
  }
}

const STATEMENTS = ['INVALID', 'SELECT', 'INSERT', 'UPDATE', 'EXPLAIN', 'DELETE', 'PREPARE', 'CREATE', 'EXECUTE', 'ALTER', 'TRANSACTION', 'COPY', 'ANALYZE', 'SET']

function statementName(type: number): string | undefined {
  return STATEMENTS[type]
}

/**
 * The files and folders SQL nobody confirmed may read, as DuckDB's allowed_paths and allowed_directories. The same
 * discipline as the project-folder reader: absolute paths only, no `..`, no links (a link inside an allowed folder
 * would be followed by DuckDB, so a folder with a link anywhere in it is not allowed at all), and what doesn't
 * exist is left out. A folder is looked through up to 5000 entries; a bigger one is not allowed (allow its files).
 */
export function allowedEntries(list: string[]): { paths: string[]; dirs: string[] } {
  const paths = new Set<string>()
  const dirs = new Set<string>()
  for (const path of list) {
    if (!isAbsolute(path) || path.split(/[\\/]/).includes('..')) continue
    let stat
    try {
      stat = lstatSync(path)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) continue
    if (stat.isFile()) paths.add(path)
    else if (stat.isDirectory() && folderWithoutLinks(path)) dirs.add(path.endsWith(sep) ? path : path + sep)
  }
  return { paths: [...paths].sort(), dirs: [...dirs].sort() }
}

function folderWithoutLinks(dir: string): boolean {
  let seen = 0
  const queue = [dir]
  while (queue.length) {
    const current = queue.pop()!
    let items
    try {
      items = readdirSync(current, { withFileTypes: true })
    } catch {
      return false
    }
    for (const item of items) {
      if (++seen > 5000 || item.isSymbolicLink()) return false
      if (item.isDirectory()) queue.push(join(current, item.name))
    }
  }
  return true
}

/**
 * DuckDB's refusal of a file the guarded instance may not read, as one sentence that says what to do (an agent
 * and a person read it). Other errors pass as they are.
 */
export function fileRefusal(err: unknown): unknown {
  const m = /Permission Error: Cannot access (?:file|directory) "([^"]*)"/.exec((err as Error)?.message ?? '')
  if (!m) return err
  return new ReadOnlyViolationError(`"${m[1]}" can't be read here: open it in DB Mastermind with Query a file, or allow it with --allow-files (dbmastermind-mcp, dbm).`)
}

/**
 * BLOB columns as their bytes: DuckDB's JSON form of a blob is its escaped text (`\x27`, `\\`), which can't be told
 * apart from text and isn't the value.
 */
function withBlobs(rows: unknown[][], types: string[], raw: () => unknown[][]): unknown[][] {
  const blobs = types.flatMap((t, i) => (/^BLOB$/i.test(t) ? [i] : []))
  if (!blobs.length || !rows.length) return rows
  const values = raw()
  return rows.map((r, k) => {
    const out = [...r]
    for (const i of blobs) {
      const v = values[k]?.[i] as { bytes?: Uint8Array } | null | undefined
      out[i] = v?.bytes ?? null
    }
    return out
  })
}

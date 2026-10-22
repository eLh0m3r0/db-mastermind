import type { DuckDBConnection, DuckDBInstance, DuckDBResultReader } from '@duckdb/node-api'
import { duckdbDialect } from '../dialect.js'
import { elapsed, QueryCancelledError, type DatabaseDriver, type IntrospectOptions, type StreamBatch, type StreamOptions } from '../driver.js'
import type { BuiltQuery } from '../filters.js'
import type { CellValue, ConnectionConfig, QueryOptions, QueryResult, SchemaSnapshot, ServerInfo, TableInfo } from '../types.js'
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

  constructor(readonly config: ConnectionConfig) {}

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

  async releaseSession(session: string): Promise<void> {
    const conn = this.sessions.get(session)
    this.sessions.delete(session)
    if (!conn) return
    await conn.run('ROLLBACK').catch(() => {})
    conn.closeSync()
  }

  async execute(sql: string, options: QueryOptions = {}): Promise<QueryResult[]> {
    if (options.signal?.aborted) throw new QueryCancelledError()
    const { conn, release } = await this.acquire(options.session)
    let cancelled = false
    const onAbort = () => {
      cancelled = true
      conn.interrupt()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const start = process.hrtime.bigint()
    try {
      const params = options.params as Parameters<DuckDBConnection['run']>[1]
      const result: DuckDBResultReader =
        options.maxRows === undefined ? await conn.runAndReadAll(sql, params) : await conn.runAndReadUntil(sql, options.maxRows + 1, params)
      return [this.toResult(result, options.maxRows, elapsed(start))]
    } catch (err) {
      if (cancelled) throw new QueryCancelledError()
      throw err
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      release()
    }
  }

  async *stream(sql: string, options: StreamOptions = {}): AsyncGenerator<StreamBatch> {
    if (options.signal?.aborted) throw new QueryCancelledError()
    const duckdb = await loadDuckDB()
    const conn = await this.db.connect()
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
      for (;;) {
        const chunk = await result.fetchChunk()
        if (!chunk || chunk.rowCount === 0) return
        yield { fields, rows: chunk.convertRows(duckdb.JsonDuckDBValueConverter).map((r) => r.map((v) => normalizeValue(v) as CellValue)) }
      }
    } catch (err) {
      if (cancelled) throw new QueryCancelledError()
      throw err
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
    let rows = result.getRowsJson() as unknown[][]
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
        affected.push(Number(r.rowsChanged))
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
        .map((s) => s.trim().replace(/^"|"$/g, ''))
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

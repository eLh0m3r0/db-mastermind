import pg from 'pg'
import Cursor from 'pg-cursor'
import { postgresDialect } from '../dialect.js'
import { elapsed, QueryCancelledError, type DatabaseDriver, type IntrospectOptions } from '../driver.js'
import type { BuiltQuery } from '../filters.js'
import { openSshTunnel, type SshTunnel } from '../ssh.js'
import type {
  ColumnInfo,
  ConnectionConfig,
  ObjectType,
  QueryOptions,
  QueryResult,
  RoutineInfo,
  SchemaSnapshot,
  ServerInfo,
  TableInfo,
} from '../types.js'
import { normalizeValue } from '../values.js'

/** Types parsed into JS values; everything else stays as the exact text Postgres sent. */
const PARSED_TYPES = new Set([16, 17, 21, 23, 26, 700, 701])
const identity = (v: string) => v

const typeOverrides = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (PARSED_TYPES.has(oid)) return pg.types.getTypeParser(oid, format as 'text')
    return identity
  },
}

const SYSTEM_SCHEMA_FILTER = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'`

export class PostgresDriver implements DatabaseDriver {
  readonly dialect = postgresDialect
  private pool?: pg.Pool
  private tunnel?: SshTunnel
  private typeNames = new Map<number, string>()

  constructor(readonly config: ConnectionConfig) {}

  async connect(): Promise<void> {
    let host = this.config.host ?? 'localhost'
    let port = this.config.port ?? 5432
    if (this.config.ssh?.enabled) {
      this.tunnel = await openSshTunnel(this.config.ssh, host, port)
      host = this.tunnel.localHost
      port = this.tunnel.localPort
    }
    const ssl = this.config.ssl
    const sslMode = ssl?.mode ?? 'disable'
    this.pool = new pg.Pool({
      host,
      port,
      database: this.config.database || 'postgres',
      user: this.config.user,
      password: this.config.password,
      ssl:
        sslMode === 'disable'
          ? false
          : {
              rejectUnauthorized: sslMode === 'verify-ca' || sslMode === 'verify-full',
              ca: ssl?.ca || undefined,
              cert: ssl?.cert || undefined,
              key: ssl?.key || undefined,
              ...(sslMode === 'verify-ca' ? { checkServerIdentity: () => undefined } : {}),
            },
      application_name: 'DB Mastermind',
      connectionTimeoutMillis: 15_000,
      idleTimeoutMillis: 60_000,
      max: 6,
      keepAlive: true,
      types: typeOverrides,
      options: this.config.readOnly ? '-c default_transaction_read_only=on' : undefined,
    })
    // Idle clients can error when the server goes away; without a listener this crashes the process.
    this.pool.on('error', () => {})
    const client = await this.pool.connect()
    try {
      const types = await client.query<{ oid: number; name: string }>(
        `SELECT oid::int AS oid, format_type(oid, NULL) AS name FROM pg_type WHERE typtype IN ('b','e','r','d','m') OR typelem <> 0`,
      )
      for (const t of types.rows) this.typeNames.set(Number(t.oid), t.name)
    } finally {
      client.release()
    }
  }

  async close(): Promise<void> {
    await this.pool?.end()
    this.pool = undefined
    await this.tunnel?.close()
    this.tunnel = undefined
  }

  private get activePool(): pg.Pool {
    if (!this.pool) throw new Error('Not connected')
    return this.pool
  }

  private sessions = new Map<string, pg.PoolClient>()

  /** Sticky client per editor session so BEGIN … COMMIT across executions works. */
  private async acquire(session?: string): Promise<{ client: pg.PoolClient; release: () => void }> {
    if (!session) {
      const client = await this.activePool.connect()
      return { client, release: () => client.release() }
    }
    let client = this.sessions.get(session)
    if (!client) {
      client = await this.activePool.connect()
      const c = client
      c.on('error', () => {
        this.sessions.delete(session)
        c.release(true)
      })
      this.sessions.set(session, client)
    }
    return { client, release: () => {} }
  }

  async releaseSession(session: string): Promise<void> {
    const client = this.sessions.get(session)
    this.sessions.delete(session)
    if (!client) return
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }

  async execute(sql: string, options: QueryOptions = {}): Promise<QueryResult[]> {
    const { client, release } = await this.acquire(options.session)
    const pid = (client as unknown as { processID: number }).processID
    let cancelled = false
    const onAbort = () => {
      cancelled = true
      this.activePool.query('SELECT pg_cancel_backend($1)', [pid]).catch(() => {})
    }
    if (options.signal?.aborted) throw new QueryCancelledError()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const start = process.hrtime.bigint()
    try {
      if (options.maxRows === undefined) {
        const res = await client.query({ text: sql, values: options.params, rowMode: 'array', types: typeOverrides })
        const results = (Array.isArray(res) ? res : [res]) as pg.QueryArrayResult[]
        const durationMs = elapsed(start)
        return results.map((r) => this.toResult(r, r.rows, false, durationMs))
      }
      const cursor = client.query(new Cursor(sql, options.params, { rowMode: 'array', types: typeOverrides }))
      const { rows, result } = await new Promise<{ rows: unknown[][]; result: pg.QueryArrayResult }>((resolve, reject) => {
        cursor.read(options.maxRows! + 1, (err, rows, result) => (err ? reject(err) : resolve({ rows, result })))
      })
      await cursor.close().catch(() => {})
      const truncated = rows.length > options.maxRows
      return [this.toResult(result, truncated ? rows.slice(0, options.maxRows) : rows, truncated, elapsed(start))]
    } catch (err) {
      if (cancelled) throw new QueryCancelledError()
      throw err
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      release()
    }
  }

  private toResult(r: pg.QueryArrayResult, rows: unknown[][], truncated: boolean, durationMs: number): QueryResult {
    const fields = (r.fields ?? []).map((f) => ({ name: f.name, dataType: this.typeNames.get(f.dataTypeID) }))
    const hasRows = fields.length > 0
    return {
      fields,
      rows: rows.map((row) => row.map(normalizeValue)),
      rowCount: hasRows ? rows.length : (r.rowCount ?? 0),
      affectedRows: hasRows ? undefined : (r.rowCount ?? undefined),
      command: r.command,
      truncated,
      durationMs,
    }
  }

  async transaction(statements: BuiltQuery[]): Promise<number[]> {
    const client = await this.activePool.connect()
    try {
      await client.query('BEGIN')
      const affected: number[] = []
      for (const s of statements) {
        const r = await client.query(s.sql, s.params)
        affected.push(r.rowCount ?? 0)
      }
      await client.query('COMMIT')
      return affected
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  async serverInfo(): Promise<ServerInfo> {
    const r = await this.activePool.query<{ v: string }>('SELECT version() AS v')
    const full = r.rows[0]?.v ?? ''
    const m = /^(\S+)\s+([\d.]+\w*)/.exec(full)
    return { product: m?.[1] ?? 'PostgreSQL', version: m?.[2] ?? full }
  }

  async listDatabases(): Promise<string[]> {
    const r = await this.activePool.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname',
    )
    return r.rows.map((x) => x.datname)
  }

  async introspect(options: IntrospectOptions = {}): Promise<SchemaSnapshot> {
    const active = this.activePool
    // Catalog queries use pg's default parsers (text[] → string[]), unlike user queries.
    const pool = {
      query: <R extends pg.QueryResultRow>(text: string, values: unknown[] = []) =>
        active.query<R>({ text, values, types: pg.types }),
    }
    const schemaFilter = options.schemas?.length ? ' AND n.nspname = ANY($1::text[])' : ''
    const params = options.schemas?.length ? [options.schemas] : []

    const [meta, schemas, tables, columns, constraints, indexes, routines] = await Promise.all([
      pool.query<{ db: string; schema: string }>('SELECT current_database() AS db, current_schema() AS schema'),
      pool.query<{ nspname: string }>(
        `SELECT n.nspname FROM pg_namespace n WHERE ${SYSTEM_SCHEMA_FILTER}${schemaFilter} ORDER BY n.nspname`,
        params,
      ),
      pool.query<{ schema: string; name: string; relkind: string; comment: string | null; estimate: string }>(
        `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind,
                obj_description(c.oid, 'pg_class') AS comment, c.reltuples::bigint AS estimate
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition AND ${SYSTEM_SCHEMA_FILTER}${schemaFilter}
          ORDER BY n.nspname, c.relname`,
        params,
      ),
      pool.query<{
        schema: string
        table: string
        name: string
        ordinal: number
        type: string
        nullable: boolean
        default: string | null
        identity: string
        generated: string
        comment: string | null
      }>(
        `SELECT n.nspname AS schema, c.relname AS table, a.attname AS name, a.attnum AS ordinal,
                format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
                pg_get_expr(d.adbin, d.adrelid) AS default, a.attidentity::text AS identity,
                a.attgenerated::text AS generated, col_description(c.oid, a.attnum) AS comment
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m','f')
            AND NOT c.relispartition AND ${SYSTEM_SCHEMA_FILTER}${schemaFilter}
          ORDER BY n.nspname, c.relname, a.attnum`,
        params,
      ),
      pool.query<{
        schema: string
        table: string
        name: string
        type: string
        columns: string[]
        ref_schema: string | null
        ref_table: string | null
        ref_columns: string[] | null
        on_update: string
        on_delete: string
      }>(
        `SELECT n.nspname AS schema, c.relname AS table, con.conname AS name, con.contype::text AS type,
                ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(num, ord)
                       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.num ORDER BY k.ord)::text[] AS columns,
                fn.nspname AS ref_schema, fc.relname AS ref_table,
                ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(num, ord)
                       JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.num ORDER BY k.ord)::text[] AS ref_columns,
                con.confupdtype::text AS on_update, con.confdeltype::text AS on_delete
           FROM pg_constraint con
           JOIN pg_class c ON c.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN pg_class fc ON fc.oid = con.confrelid
           LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
          WHERE con.contype IN ('p','f') AND ${SYSTEM_SCHEMA_FILTER}${schemaFilter}
          ORDER BY n.nspname, c.relname, con.conname`,
        params,
      ),
      pool.query<{
        schema: string
        table: string
        name: string
        unique: boolean
        primary: boolean
        method: string
        columns: string[]
      }>(
        `SELECT n.nspname AS schema, t.relname AS table, i.relname AS name, ix.indisunique AS unique,
                ix.indisprimary AS primary, am.amname AS method,
                ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k, true) FROM generate_series(1, ix.indnkeyatts) k ORDER BY k)::text[] AS columns
           FROM pg_index ix
           JOIN pg_class i ON i.oid = ix.indexrelid
           JOIN pg_class t ON t.oid = ix.indrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
           JOIN pg_am am ON am.oid = i.relam
          WHERE ${SYSTEM_SCHEMA_FILTER}${schemaFilter}
          ORDER BY n.nspname, t.relname, i.relname`,
        params,
      ),
      pool.query<{ schema: string; name: string; kind: string; result: string | null; args: string | null }>(
        `SELECT n.nspname AS schema, p.proname AS name, p.prokind::text AS kind,
                pg_get_function_result(p.oid) AS result, pg_get_function_arguments(p.oid) AS args
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.prokind IN ('f','p') AND ${SYSTEM_SCHEMA_FILTER}${schemaFilter}
            AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
          ORDER BY n.nspname, p.proname`,
        params,
      ),
    ])

    const key = (schema: string, name: string) => `${schema}\u0000${name}`
    const byKey = new Map<string, TableInfo>()
    const kinds: Record<string, ObjectType> = { r: 'table', p: 'table', v: 'view', m: 'materialized_view', f: 'foreign_table' }
    for (const t of tables.rows) {
      const info: TableInfo = {
        schema: t.schema,
        name: t.name,
        type: kinds[t.relkind] ?? 'table',
        comment: t.comment,
        rowEstimate: Number(t.estimate) >= 0 ? Number(t.estimate) : null,
        columns: [],
        primaryKey: [],
        foreignKeys: [],
        indexes: [],
      }
      byKey.set(key(t.schema, t.name), info)
    }
    const fkAction: Record<string, string> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' }
    for (const con of constraints.rows) {
      const t = byKey.get(key(con.schema, con.table))
      if (!t) continue
      if (con.type === 'p') t.primaryKey = con.columns
      else
        t.foreignKeys.push({
          name: con.name,
          columns: con.columns,
          refSchema: con.ref_schema ?? undefined,
          refTable: con.ref_table ?? '',
          refColumns: con.ref_columns ?? [],
          onUpdate: fkAction[con.on_update],
          onDelete: fkAction[con.on_delete],
        })
    }
    for (const c of columns.rows) {
      const t = byKey.get(key(c.schema, c.table))
      if (!t) continue
      const column: ColumnInfo = {
        name: c.name,
        ordinal: c.ordinal,
        dataType: c.type,
        nullable: c.nullable,
        defaultValue: c.default,
        isPrimaryKey: t.primaryKey.includes(c.name),
        isIdentity: c.identity !== '' || /^nextval\(/.test(c.default ?? ''),
        isGenerated: c.generated !== '',
        comment: c.comment,
      }
      t.columns.push(column)
    }
    for (const ix of indexes.rows) {
      byKey.get(key(ix.schema, ix.table))?.indexes.push({
        name: ix.name,
        columns: ix.columns,
        unique: ix.unique,
        primary: ix.primary,
        method: ix.method,
      })
    }
    const routineInfos: RoutineInfo[] = routines.rows.map((r) => ({
      schema: r.schema,
      name: r.name,
      kind: r.kind === 'p' ? 'procedure' : 'function',
      returnType: r.result,
      arguments: r.args,
    }))

    return {
      database: meta.rows[0]?.db,
      defaultSchema: meta.rows[0]?.schema ?? 'public',
      schemas: schemas.rows.map((s) => s.nspname),
      tables: [...byKey.values()],
      routines: routineInfos,
      capturedAt: new Date().toISOString(),
    }
  }
}

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import sql from 'mssql'
import { mssqlDialect } from '../dialect.js'
import { batchesFromEvents, ConnectionLostError, elapsed, QueryCancelledError, SessionTransactions, type DatabaseDriver, type IntrospectOptions, type StreamBatch, type StreamOptions } from '../driver.js'
import type { BuiltQuery } from '../filters.js'
import { isReadOnlyScript } from '../sql-split.js'
import { openSshTunnel, type SshTunnel } from '../ssh.js'
import type { ConnectionConfig, QueryOptions, QueryResult, ResultField, SchemaSnapshot, ServerInfo, TableInfo } from '../types.js'
import { normalizeValue } from '../values.js'

type RawRow = Record<string, unknown>
type SqlModule = typeof sql

let odbcDriver: Promise<string> | undefined

/** Newest installed Microsoft ODBC driver for SQL Server (Windows registry), used for integrated auth. */
export function detectOdbcDriver(): Promise<string> {
  odbcDriver ??= (async () => {
    try {
      const { stdout } = await promisify(execFile)('reg', ['query', 'HKLM\\SOFTWARE\\ODBC\\ODBCINST.INI\\ODBC Drivers'], { timeout: 5000 })
      const installed = [...stdout.matchAll(/^\s+(.+?)\s+REG_SZ\s+Installed/gim)].map((m) => m[1]!.trim())
      const preferred = ['ODBC Driver 18 for SQL Server', 'ODBC Driver 17 for SQL Server', 'ODBC Driver 13 for SQL Server', 'SQL Server Native Client 11.0', 'SQL Server']
      const found = preferred.find((d) => installed.includes(d)) ?? installed.find((d) => /sql server/i.test(d))
      if (found) return found
    } catch {
      // Not Windows or no registry access: fall through.
    }
    throw new Error('Windows authentication needs the Microsoft ODBC Driver for SQL Server (17 or 18). Install it from Microsoft and reconnect.')
  })()
  return odbcDriver
}

const odbcEscape = (v: string) => (/[;{}]/.test(v) ? `{${v.replaceAll('}', '}}')}}` : v)

/** Renders a SQL Server column type the way SSMS shows it, e.g. nvarchar(50), decimal(10,2). */
export function formatMssqlType(type: string, maxLength: number, precision: number, scale: number): string {
  const t = type.toLowerCase()
  if (['varchar', 'char', 'varbinary', 'binary'].includes(t)) return `${t}(${maxLength === -1 ? 'max' : maxLength})`
  if (['nvarchar', 'nchar'].includes(t)) return `${t}(${maxLength === -1 ? 'max' : maxLength / 2})`
  if (['decimal', 'numeric'].includes(t)) return `${t}(${precision},${scale})`
  if (['datetime2', 'time', 'datetimeoffset'].includes(t) && scale !== 7) return `${t}(${scale})`
  return t
}

export class MssqlDriver implements DatabaseDriver {
  readonly dialect = mssqlDialect
  private pool?: sql.ConnectionPool
  private tunnel?: SshTunnel
  private sessions = new Map<string, sql.ConnectionPool>()
  private poolConfig?: sql.config
  /** tedious (default) or msnodesqlv8 (Windows integrated authentication); same API. */
  private sql: SqlModule = sql

  constructor(readonly config: ConnectionConfig) {}

  async connect(): Promise<void> {
    let server = this.config.host ?? 'localhost'
    const opts = this.config.options ?? {}
    const instanceName = opts.instanceName ? String(opts.instanceName) : undefined
    let port: number | undefined = this.config.port ?? (instanceName ? undefined : 1433)
    if (this.config.ssh?.enabled) {
      this.tunnel = await openSshTunnel(this.config.ssh, server, port ?? 1433)
      server = this.tunnel.localHost
      port = this.tunnel.localPort
    }
    const sslMode = this.config.ssl?.mode ?? 'prefer'
    const domain = opts.domain ? String(opts.domain) : undefined
    if (opts.authentication === 'windows') {
      // Integrated security (the logged-in Windows account) is only available through ODBC.
      if (process.platform !== 'win32') throw new Error('Windows authentication is only available on Windows')
      const mod = (await import('mssql/msnodesqlv8')) as unknown as { default?: SqlModule } & SqlModule
      this.sql = mod.default ?? mod
      const driver = opts.odbcDriver ? String(opts.odbcDriver) : await detectOdbcDriver()
      const serverPart = instanceName ? `${server}\\${instanceName}` : `${server},${port ?? 1433}`
      const trust = opts.trustServerCertificate !== undefined ? Boolean(opts.trustServerCertificate) : sslMode !== 'verify-ca' && sslMode !== 'verify-full'
      const parts = [
        `Driver={${driver}}`,
        `Server=${odbcEscape(serverPart)}`,
        this.config.database ? `Database=${odbcEscape(this.config.database)}` : '',
        'Trusted_Connection=yes',
        `Encrypt=${sslMode === 'disable' ? 'no' : 'yes'}`,
        `TrustServerCertificate=${trust ? 'yes' : 'no'}`,
        'APP=DB Mastermind',
        this.config.readOnly ? 'ApplicationIntent=ReadOnly' : '',
      ].filter(Boolean)
      this.poolConfig = {
        server,
        connectionString: parts.join(';'),
        connectionTimeout: 15_000,
        requestTimeout: Number(opts.requestTimeout ?? 0),
        pool: { max: 6, min: 0, idleTimeoutMillis: 60_000 },
        options: {},
      } as sql.config
      this.pool = new this.sql.ConnectionPool(this.poolConfig)
      this.pool.on('error', () => {})
      await this.pool.connect()
      return
    }
    this.poolConfig = {
      server,
      port,
      database: this.config.database || undefined,
      ...(domain
        ? {
            authentication: {
              type: 'ntlm',
              options: { domain, userName: this.config.user ?? '', password: this.config.password ?? '' },
            },
          }
        : { user: this.config.user, password: this.config.password }),
      connectionTimeout: 15_000,
      requestTimeout: Number(opts.requestTimeout ?? 0),
      pool: { max: 6, min: 0, idleTimeoutMillis: 60_000 },
      options: {
        encrypt: sslMode !== 'disable',
        trustServerCertificate:
          opts.trustServerCertificate !== undefined
            ? Boolean(opts.trustServerCertificate)
            : sslMode !== 'verify-ca' && sslMode !== 'verify-full',
        instanceName: this.tunnel ? undefined : instanceName,
        appName: 'DB Mastermind',
        useUTC: true,
        readOnlyIntent: Boolean(this.config.readOnly),
        enableArithAbort: true,
      },
    }
    this.pool = new this.sql.ConnectionPool(this.poolConfig)
    this.pool.on('error', () => {})
    await this.pool.connect()
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((p) => p.close().catch(() => {})))
    this.sessions.clear()
    await this.pool?.close()
    this.pool = undefined
    await this.tunnel?.close()
    this.tunnel = undefined
  }

  private get activePool(): sql.ConnectionPool {
    if (!this.pool) throw new Error('Not connected')
    return this.pool
  }

  /** A session is a single-connection pool, so SET options and open transactions persist. */
  private async sessionPool(session?: string): Promise<sql.ConnectionPool> {
    if (!session) return this.activePool
    this.transactions.check(session)
    let pool = this.sessions.get(session)
    if (!pool) {
      pool = new this.sql.ConnectionPool({ ...this.poolConfig!, pool: { max: 1, min: 0, idleTimeoutMillis: 3_600_000 } })
      pool.on('error', () => this.transactions.dropped(session))
      await pool.connect()
      this.sessions.set(session, pool)
    }
    return pool
  }

  async releaseSession(session: string): Promise<void> {
    this.transactions.released(session)
    const pool = this.sessions.get(session)
    this.sessions.delete(session)
    if (!pool) return
    await pool.request().batch('IF @@TRANCOUNT > 0 ROLLBACK').catch(() => {})
    await pool.close().catch(() => {})
  }

  private transactions = new SessionTransactions()

  async execute(text: string, options: QueryOptions = {}): Promise<QueryResult[]> {
    try {
      return await this.executeTracked(text, options)
    } catch (err) {
      throw this.tunnel?.explain(err) ?? err
    }
  }

  private async executeTracked(text: string, options: QueryOptions = {}): Promise<QueryResult[]> {
    const session = options.session
    // A session is a one-connection pool that quietly reconnects when the server or network drops it (and SPIDs are
    // reused). A transaction open on the old connection is gone then, and the next statements would autocommit
    // unnoticed: while one should be open, check that the server still has it.
    if (session && this.transactions.isOpen(session)) {
      const pool = await this.sessionPool(session)
      const r = await pool.request().query<{ n: number }>('SELECT @@TRANCOUNT AS n').catch(() => undefined)
      if (!r || Number(r.recordset[0]?.n) === 0) {
        this.transactions.released(session)
        throw new ConnectionLostError('The open transaction is no longer active on the server (the connection was lost, or the server rolled it back). Its uncommitted changes are gone: start the transaction again.')
      }
    }
    const results = await this.executeOnce(text, options)
    if (session) this.transactions.ran(session, text)
    return results
  }

  private async executeOnce(text: string, options: QueryOptions = {}): Promise<QueryResult[]> {
    if (options.signal?.aborted) throw new QueryCancelledError()
    const pool = await this.sessionPool(options.session)
    const request = pool.request()
    request.stream = true
    request.arrayRowMode = true
    options.params?.forEach((value, i) => request.input(`p${i + 1}`, value))
    const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY
    // Past maxRows, cancelling saves fetching rows nobody sees, but it stops the whole batch: in one that also writes
    // or ends a transaction (`SELECT * FROM big; UPDATE …; COMMIT`) the rest would silently not run. Such a batch
    // runs to the end and the extra rows are dropped.
    const canStopEarly = Number.isFinite(maxRows) && isReadOnlyScript(text, 'mssql')
    const start = process.hrtime.bigint()

    return new Promise<QueryResult[]>((resolve, reject) => {
      const results: QueryResult[] = []
      let current: QueryResult | undefined
      let cancelled = false
      let stoppedEarly = false
      let settled = false
      const errors: Error[] = []

      const onAbort = () => {
        cancelled = true
        request.cancel()
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      const finish = () => {
        if (settled) return
        settled = true
        options.signal?.removeEventListener('abort', onAbort)
        if (cancelled && !stoppedEarly) return reject(new QueryCancelledError())
        if (errors.length && !stoppedEarly) return reject(errors[0])
        const durationMs = elapsed(start)
        for (const r of results) r.durationMs = durationMs
        resolve(results)
      }

      request.on('recordset', (columns: unknown) => {
        const cols = (Array.isArray(columns) ? columns : Object.values(columns as object)) as {
          name: string
          type?: { declaration?: string; name?: string }
        }[]
        current = {
          fields: cols.map((c) => ({ name: c.name, dataType: c.type?.declaration ?? undefined })),
          rows: [],
          rowCount: 0,
          command: 'SELECT',
          durationMs: 0,
        }
        results.push(current)
      })
      request.on('row', (row: unknown[]) => {
        if (!current) return
        if (current.rows.length < maxRows) {
          // `date` columns arrive as midnight Dates; show them as dates like every other engine.
          current.rows.push(row.map((v, i) => (v instanceof Date && current!.fields[i]?.dataType === 'date' ? String(normalizeValue(v)).slice(0, 10) : normalizeValue(v))))
          current.rowCount = current.rows.length
        } else if (!current.truncated) {
          current.truncated = true
          if (canStopEarly) {
            stoppedEarly = true
            request.cancel()
          }
        }
      })
      request.on('rowsaffected', (count: number) => {
        // Fired for every statement; only DML without a result set is interesting.
        if (current && current.fields.length) {
          current = undefined
          return
        }
        results.push({ fields: [], rows: [], rowCount: count, affectedRows: count, durationMs: 0 })
      })
      request.on('error', (err: Error) => errors.push(err))
      request.on('done', finish)
      // Without parameters, send a real batch like SSMS does: query() wraps text in sp_executesql,
      // where SET options and #temp tables vanish when the call ends.
      if (options.params?.length) void request.query(text)
      else void request.batch(text)
    })
  }

  async *stream(text: string, options: StreamOptions = {}): AsyncGenerator<StreamBatch> {
    if (options.signal?.aborted) throw new QueryCancelledError()
    const request = this.activePool.request()
    request.stream = true
    request.arrayRowMode = true
    options.params?.forEach((value, i) => request.input(`p${i + 1}`, value))
    let cancelled = false
    const onAbort = () => {
      cancelled = true
      request.cancel()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      yield* batchesFromEvents(
        {
          start: (h) => {
            let fields: ResultField[] | undefined
            let ignore = false
            request.on('recordset', (columns: unknown) => {
              // Only the first result set is streamed.
              if (fields) {
                ignore = true
                return
              }
              const cols = (Array.isArray(columns) ? columns : Object.values(columns as object)) as { name: string; type?: { declaration?: string } }[]
              fields = cols.map((c) => ({ name: c.name, dataType: c.type?.declaration ?? undefined }))
              h.fields(fields)
            })
            request.on('row', (row: unknown[]) => {
              if (ignore || !fields) return
              h.row(row.map((v, i) => (v instanceof Date && fields![i]?.dataType === 'date' ? String(normalizeValue(v)).slice(0, 10) : normalizeValue(v))))
            })
            request.on('error', (err: Error) => h.error(cancelled ? new QueryCancelledError() : err))
            request.on('done', () => h.end())
            if (options.params?.length) void request.query(text)
            else void request.batch(text)
          },
          pause: () => request.pause(),
          resume: () => request.resume(),
          cancel: () => request.cancel(),
        },
        options.batchSize ?? 5000,
      )
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  async transaction(statements: BuiltQuery[]): Promise<number[]> {
    const tx = new this.sql.Transaction(this.activePool)
    await tx.begin()
    try {
      const affected: number[] = []
      for (const s of statements) {
        const request = new this.sql.Request(tx)
        s.params.forEach((value, i) => request.input(`p${i + 1}`, value))
        const r = await request.query(s.sql)
        affected.push(r.rowsAffected.reduce((a, b) => a + b, 0))
      }
      await tx.commit()
      return affected
    } catch (err) {
      await tx.rollback().catch(() => {})
      throw err
    }
  }

  private async rows(text: string, params: Record<string, unknown> = {}): Promise<RawRow[]> {
    const request = this.activePool.request()
    for (const [k, v] of Object.entries(params)) request.input(k, v)
    const r = await request.query(text)
    return r.recordset as RawRow[]
  }

  async serverInfo(): Promise<ServerInfo> {
    const [r] = await this.rows(
      `SELECT CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(128)) AS v, CAST(SERVERPROPERTY('Edition') AS NVARCHAR(128)) AS e`,
    )
    return { product: `SQL Server${r?.e ? ` (${String(r.e)})` : ''}`, version: String(r?.v ?? '') }
  }

  async listDatabases(): Promise<string[]> {
    const rows = await this.rows('SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 ORDER BY name')
    return rows.map((r) => String(r.name))
  }

  async introspect(options: IntrospectOptions = {}): Promise<SchemaSnapshot> {
    const params: Record<string, unknown> = {}
    options.schemas?.forEach((s, i) => (params[`s${i}`] = s))
    const schemaFilter = options.schemas?.length
      ? ` AND s.name IN (${options.schemas.map((_, i) => `@s${i}`).join(', ')})`
      : ''
    const userSchema = `s.name NOT IN ('sys', 'INFORMATION_SCHEMA')${schemaFilter}`

    const [meta, schemas, tables, columns, indexes, fks, routines] = await Promise.all([
      this.rows('SELECT DB_NAME() AS db, SCHEMA_NAME() AS sch'),
      this.rows(
        `SELECT s.name FROM sys.schemas s
          WHERE ${userSchema} AND s.name <> 'guest' AND s.name NOT LIKE 'db[_]%'
          ORDER BY s.name`,
        params,
      ),
      this.rows(
        `SELECT s.name AS s, o.name AS t, RTRIM(o.type) AS type, CAST(ep.value AS NVARCHAR(MAX)) AS comment,
                (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)) AS est,
                CASE WHEN o.type = 'V' THEN OBJECT_DEFINITION(o.object_id) END AS definition
           FROM sys.objects o
           JOIN sys.schemas s ON s.schema_id = o.schema_id
           LEFT JOIN sys.extended_properties ep
             ON ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.class = 1 AND ep.name = 'MS_Description'
          WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0 AND ${userSchema}
          ORDER BY s.name, o.name`,
        params,
      ),
      this.rows(
        `SELECT s.name AS s, o.name AS t, c.name AS name, c.column_id AS ord, TYPE_NAME(c.user_type_id) AS type,
                c.max_length, c.precision, c.scale, c.is_nullable, dc.definition AS def, c.is_identity, c.is_computed,
                CAST(ep.value AS NVARCHAR(MAX)) AS comment
           FROM sys.columns c
           JOIN sys.objects o ON o.object_id = c.object_id
           JOIN sys.schemas s ON s.schema_id = o.schema_id
           LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
           LEFT JOIN sys.extended_properties ep
             ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.class = 1 AND ep.name = 'MS_Description'
          WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0 AND ${userSchema}
          ORDER BY s.name, o.name, c.column_id`,
        params,
      ),
      this.rows(
        `SELECT s.name AS s, o.name AS t, i.name AS name, i.is_unique, i.is_primary_key, i.is_unique_constraint, i.type_desc AS method, c.name AS col
           FROM sys.indexes i
           JOIN sys.objects o ON o.object_id = i.object_id
           JOIN sys.schemas s ON s.schema_id = o.schema_id
           JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
           JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
          WHERE o.is_ms_shipped = 0 AND i.name IS NOT NULL AND o.type IN ('U', 'V') AND ${userSchema}
          ORDER BY s.name, o.name, i.name, ic.key_ordinal`,
        params,
      ),
      this.rows(
        `SELECT s.name AS s, t.name AS t, fk.name AS name, c.name AS col, rs.name AS ref_s, rt.name AS ref_t,
                rc.name AS ref_col, fk.update_referential_action_desc AS on_update,
                fk.delete_referential_action_desc AS on_delete
           FROM sys.foreign_keys fk
           JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
           JOIN sys.tables t ON t.object_id = fk.parent_object_id
           JOIN sys.schemas s ON s.schema_id = t.schema_id
           JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
           JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
           JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
           JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
          WHERE ${userSchema}
          ORDER BY s.name, t.name, fk.name, fkc.constraint_column_id`,
        params,
      ),
      this.rows(
        `SELECT s.name AS s, o.name AS name, RTRIM(o.type) AS type
           FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
          WHERE o.type IN ('P', 'FN', 'IF', 'TF') AND o.is_ms_shipped = 0 AND ${userSchema}
          ORDER BY s.name, o.name`,
        params,
      ),
    ])

    const key = (s: unknown, t: unknown) => `${String(s)}\u0000${String(t)}`
    const byKey = new Map<string, TableInfo>()
    for (const t of tables) {
      byKey.set(key(t.s, t.t), {
        schema: String(t.s),
        name: String(t.t),
        type: t.type === 'V' ? 'view' : 'table',
        comment: t.comment ? String(t.comment) : null,
        rowEstimate: t.est === null || t.est === undefined ? null : Number(t.est),
        definition: t.definition ? String(t.definition) : null,
        columns: [],
        primaryKey: [],
        foreignKeys: [],
        indexes: [],
      })
    }
    for (const ix of indexes) {
      const t = byKey.get(key(ix.s, ix.t))
      if (!t) continue
      const name = String(ix.name)
      let entry = t.indexes.find((i) => i.name === name)
      if (!entry) {
        entry = {
          name,
          columns: [],
          unique: Boolean(ix.is_unique),
          primary: Boolean(ix.is_primary_key),
          method: String(ix.method).toLowerCase(),
          constraint: Boolean(ix.is_unique_constraint),
        }
        t.indexes.push(entry)
      }
      entry.columns.push(String(ix.col))
      if (entry.primary) t.primaryKey = entry.columns
    }
    for (const c of columns) {
      const t = byKey.get(key(c.s, c.t))
      if (!t) continue
      const name = String(c.name)
      t.columns.push({
        name,
        ordinal: Number(c.ord),
        dataType: formatMssqlType(String(c.type), Number(c.max_length), Number(c.precision), Number(c.scale)),
        nullable: Boolean(c.is_nullable),
        defaultValue: c.def === null || c.def === undefined ? null : String(c.def),
        isPrimaryKey: t.primaryKey.includes(name),
        isIdentity: Boolean(c.is_identity),
        isGenerated: Boolean(c.is_computed),
        maxLength: Number(c.max_length),
        comment: c.comment ? String(c.comment) : null,
      })
    }
    for (const fk of fks) {
      const t = byKey.get(key(fk.s, fk.t))
      if (!t) continue
      const name = String(fk.name)
      let entry = t.foreignKeys.find((f) => f.name === name)
      if (!entry) {
        entry = {
          name,
          columns: [],
          refSchema: String(fk.ref_s),
          refTable: String(fk.ref_t),
          refColumns: [],
          onUpdate: String(fk.on_update).replaceAll('_', ' '),
          onDelete: String(fk.on_delete).replaceAll('_', ' '),
        }
        t.foreignKeys.push(entry)
      }
      entry.columns.push(String(fk.col))
      entry.refColumns.push(String(fk.ref_col))
    }

    return {
      database: meta[0]?.db ? String(meta[0].db) : undefined,
      defaultSchema: meta[0]?.sch ? String(meta[0].sch) : 'dbo',
      schemas: schemas.map((s) => String(s.name)),
      tables: [...byKey.values()],
      routines: routines.map((r) => ({
        schema: String(r.s),
        name: String(r.name),
        kind: r.type === 'P' ? 'procedure' : 'function',
      })),
      capturedAt: new Date().toISOString(),
    }
  }
}

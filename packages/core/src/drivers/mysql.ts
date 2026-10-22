import type { Connection as CallbackConnection } from 'mysql2'
import mysql from 'mysql2/promise'
import type { FieldPacket, Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { mariadbDialect, mysqlDialect } from '../dialect.js'
import { batchesFromEvents, ConnectionLostError, elapsed, QueryCancelledError, SessionTransactions, type DatabaseDriver, type IntrospectOptions, type StreamBatch, type StreamOptions } from '../driver.js'
import type { BuiltQuery } from '../filters.js'
import { openSshTunnel, type SshTunnel } from '../ssh.js'
import type {
  ConnectionConfig,
  QueryOptions,
  QueryResult,
  ResultField,
  SchemaSnapshot,
  ServerInfo,
  TableInfo,
} from '../types.js'
import { normalizeValue } from '../values.js'

const SYSTEM_SCHEMAS = ['mysql', 'information_schema', 'performance_schema', 'sys']

const TYPE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries((mysql as unknown as { Types: Record<string, number> }).Types ?? {}).map(([name, code]) => [
    code,
    name.toLowerCase(),
  ]),
)

type RawRow = Record<string, unknown>

/** Driver for MySQL and MariaDB (same wire protocol, slightly different catalogs). */
export class MysqlDriver implements DatabaseDriver {
  readonly dialect
  private pool?: Pool
  private tunnel?: SshTunnel
  private sessions = new Map<string, PoolConnection>()

  constructor(readonly config: ConnectionConfig) {
    this.dialect = config.driver === 'mariadb' ? mariadbDialect : mysqlDialect
  }

  async connect(): Promise<void> {
    let host = this.config.host ?? 'localhost'
    let port = this.config.port ?? 3306
    if (this.config.ssh?.enabled) {
      this.tunnel = await openSshTunnel(this.config.ssh, host, port)
      host = this.tunnel.localHost
      port = this.tunnel.localPort
    }
    const ssl = this.config.ssl
    const sslMode = ssl?.mode ?? 'disable'
    this.pool = mysql.createPool({
      host,
      port,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database || undefined,
      ssl:
        sslMode === 'disable'
          ? undefined
          : {
              rejectUnauthorized: sslMode === 'verify-ca' || sslMode === 'verify-full',
              ca: ssl?.ca || undefined,
              cert: ssl?.cert || undefined,
              key: ssl?.key || undefined,
            },
      connectionLimit: 6,
      connectTimeout: 15_000,
      dateStrings: true,
      supportBigNumbers: true,
      decimalNumbers: false,
      multipleStatements: false,
      enableKeepAlive: true,
      charset: 'utf8mb4',
      // Keep JSON as the exact text the server sent (consistent with other drivers, editable).
      typeCast: (field, next) => {
        if (field.type === 'JSON') return field.string('utf8')
        const value = next()
        // MariaDB reports JSON as BLOB with a json format hint, which mysql2 parses into objects.
        if (value !== null && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Date)) {
          return JSON.stringify(value)
        }
        return value
      },
    })
    if (this.config.readOnly) {
      // Raw (callback) connections: enforce read-only before the pool hands them out.
      this.pool.pool.on('connection', (conn) => conn.query('SET SESSION TRANSACTION READ ONLY'))
    }
    const conn = await this.pool.getConnection()
    conn.release()
  }

  async close(): Promise<void> {
    for (const conn of this.sessions.values()) conn.release()
    this.sessions.clear()
    await this.pool?.end()
    this.pool = undefined
    await this.tunnel?.close()
    this.tunnel = undefined
  }

  private get activePool(): Pool {
    if (!this.pool) throw new Error('Not connected')
    return this.pool
  }

  private async acquire(session?: string): Promise<{ conn: PoolConnection; release: () => void }> {
    if (!session) {
      const conn = await this.activePool.getConnection()
      return { conn, release: () => conn.release() }
    }
    this.transactions.check(session)
    let conn = this.sessions.get(session)
    if (!conn) {
      conn = await this.activePool.getConnection()
      const c = conn
      ;(c.connection as unknown as CallbackConnection).on('error', () => {
        if (this.sessions.get(session) !== c) return
        this.sessions.delete(session)
        this.transactions.dropped(session)
        c.destroy()
      })
      this.sessions.set(session, conn)
    }
    return { conn, release: () => {} }
  }

  async releaseSession(session: string): Promise<void> {
    this.transactions.released(session)
    const conn = this.sessions.get(session)
    this.sessions.delete(session)
    if (!conn) return
    await conn.query('ROLLBACK').catch(() => {})
    conn.release()
  }

  private async killQuery(threadId: number): Promise<void> {
    await this.activePool.query(`KILL QUERY ${Number(threadId)}`).catch(() => {})
  }

  private transactions = new SessionTransactions()

  async execute(sql: string, options: QueryOptions = {}): Promise<QueryResult[]> {
    try {
      return await this.executeTracked(sql, options)
    } catch (err) {
      throw this.tunnel?.explain(err) ?? err
    }
  }

  private async executeTracked(sql: string, options: QueryOptions = {}): Promise<QueryResult[]> {
    const session = options.session
    try {
      const results = await this.executeOnce(sql, options)
      if (session) this.transactions.ran(session, sql)
      return results
    } catch (err) {
      if (!session) throw err
      // The connection died under the statement: its transaction is gone; don't let the next one autocommit unnoticed.
      if ((err as { fatal?: boolean }).fatal) {
        const conn = this.sessions.get(session)
        this.sessions.delete(session)
        conn?.destroy()
        const open = this.transactions.isOpen(session)
        this.transactions.released(session)
        if (open) throw new ConnectionLostError()
      } else this.transactions.ran(session, sql)
      throw err
    }
  }

  private async executeOnce(sql: string, options: QueryOptions = {}): Promise<QueryResult[]> {
    if (options.signal?.aborted) throw new QueryCancelledError()
    const { conn, release } = await this.acquire(options.session)
    const threadId = conn.threadId
    const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY
    const start = process.hrtime.bigint()

    try {
      return await new Promise<QueryResult[]>((resolve, reject) => {
        const results: QueryResult[] = []
        let current: QueryResult | undefined
        let settled = false
        let stoppedEarly = false
        let cancelled = false
        let killed: Promise<void> = Promise.resolve()

        const finish = async () => {
          if (settled) return
          settled = true
          // Never hand the connection back before a pending KILL QUERY has landed,
          // otherwise it could interrupt the next statement on this connection.
          await killed
          const durationMs = elapsed(start)
          for (const r of results) r.durationMs = durationMs
          resolve(results)
        }
        const onAbort = () => {
          cancelled = true
          killed = this.killQuery(threadId)
        }
        options.signal?.addEventListener('abort', onAbort, { once: true })

        // The callback API streams rows, which lets us stop reading after maxRows.
        const raw = conn.connection as unknown as CallbackConnection
        const query = raw.query({ sql, values: options.params, rowsAsArray: true })
        query.on('fields', (fields: FieldPacket[] | undefined) => {
          // Statements without a result set still emit 'fields' (with undefined).
          if (!fields) return
          current = {
            fields: fields.map((f): ResultField => ({ name: f.name, dataType: TYPE_NAMES[f.columnType ?? f.type ?? -1] })),
            rows: [],
            rowCount: 0,
            command: 'SELECT',
            durationMs: 0,
          }
          results.push(current)
        })
        query.on('result', (row: unknown) => {
          if (Array.isArray(row)) {
            if (!current) return
            if (current.rows.length < maxRows) {
              current.rows.push(row.map(normalizeValue))
              current.rowCount = current.rows.length
            } else if (!stoppedEarly) {
              current.truncated = true
              stoppedEarly = true
              killed = this.killQuery(threadId)
            }
            return
          }
          const header = row as ResultSetHeader
          current = undefined
          // CALL returns a trailing OK packet after its result sets; don't show it as a separate result.
          if (results.length > 0 && results.at(-1)!.fields.length > 0 && /^\s*call\b/i.test(sql)) return
          results.push({
            fields: [],
            rows: [],
            rowCount: header.affectedRows ?? 0,
            affectedRows: header.affectedRows ?? 0,
            command: sql.trim().split(/\s+/, 1)[0]?.toUpperCase(),
            durationMs: 0,
          })
        })
        query.on('error', (err: Error & { code?: string }) => {
          options.signal?.removeEventListener('abort', onAbort)
          if (stoppedEarly && err.code === 'ER_QUERY_INTERRUPTED') return void finish()
          if (settled) return
          settled = true
          void killed.then(() => reject(cancelled ? new QueryCancelledError() : err))
        })
        query.on('end', () => {
          options.signal?.removeEventListener('abort', onAbort)
          if (cancelled && !settled) {
            settled = true
            void killed.then(() => reject(new QueryCancelledError()))
            return
          }
          void finish()
        })
      })
    } finally {
      release()
    }
  }

  async *stream(sql: string, options: StreamOptions = {}): AsyncGenerator<StreamBatch> {
    if (options.signal?.aborted) throw new QueryCancelledError()
    const conn = await this.activePool.getConnection()
    const raw = conn.connection as unknown as CallbackConnection
    const threadId = conn.threadId
    let killed: Promise<void> = Promise.resolve()
    let cancelled = false
    let finished = false
    const onAbort = () => {
      cancelled = true
      killed = this.killQuery(threadId)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      yield* batchesFromEvents(
        {
          start: (h) => {
            let seenFields = false
            let firstDone = false
            const query = raw.query({ sql, values: options.params, rowsAsArray: true })
            query.on('fields', (fields: FieldPacket[] | undefined) => {
              if (!fields) return
              // Only the first result set is streamed.
              if (seenFields) firstDone = true
              seenFields = true
              if (!firstDone) h.fields(fields.map((f): ResultField => ({ name: f.name, dataType: TYPE_NAMES[f.columnType ?? f.type ?? -1] })))
            })
            query.on('result', (row: unknown) => {
              if (Array.isArray(row) && !firstDone) h.row(row.map(normalizeValue))
            })
            query.on('error', (err: Error) => {
              finished = true
              h.error(cancelled ? new QueryCancelledError() : err)
            })
            query.on('end', () => {
              finished = true
              h.end()
            })
          },
          pause: () => raw.pause(),
          resume: () => raw.resume(),
          cancel: () => {
            killed = this.killQuery(threadId)
          },
        },
        options.batchSize ?? 5000,
      )
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      if (finished) conn.release()
      else {
        // Stopped early: the KILL ends the query server-side; the half-read connection is not reused.
        await killed
        conn.destroy()
      }
    }
  }

  async transaction(statements: BuiltQuery[]): Promise<number[]> {
    const conn = await this.activePool.getConnection()
    try {
      await conn.beginTransaction()
      const affected: number[] = []
      for (const s of statements) {
        const [r] = await conn.query<ResultSetHeader>(s.sql, s.params)
        affected.push(r.affectedRows ?? 0)
      }
      await conn.commit()
      return affected
    } catch (err) {
      await conn.rollback().catch(() => {})
      throw err
    } finally {
      conn.release()
    }
  }

  async serverInfo(): Promise<ServerInfo> {
    const [rows] = await this.activePool.query<RowDataPacket[]>('SELECT VERSION() AS v')
    const v = String(rows[0]?.v ?? '')
    return { product: /mariadb/i.test(v) ? 'MariaDB' : 'MySQL', version: v.split('-')[0] ?? v }
  }

  async listDatabases(): Promise<string[]> {
    const [rows] = await this.activePool.query<RowDataPacket[]>('SHOW DATABASES')
    return rows.map((r) => String(Object.values(r)[0])).filter((d) => !SYSTEM_SCHEMAS.includes(d.toLowerCase()))
  }

  private async rows(sql: string, params: unknown[] = []): Promise<RawRow[]> {
    const [rows] = await this.activePool.query<RowDataPacket[]>(sql, params)
    return rows as RawRow[]
  }

  async introspect(options: IntrospectOptions = {}): Promise<SchemaSnapshot> {
    const [meta] = await this.rows('SELECT DATABASE() AS db')
    const currentDb = (meta?.db as string | null) ?? undefined
    let schemas = options.schemas
    if (!schemas?.length) schemas = currentDb ? [currentDb] : await this.listDatabases()
    if (schemas.length === 0) {
      return { database: currentDb, schemas: [], tables: [], routines: [], capturedAt: new Date().toISOString() }
    }
    const inList = schemas.map(() => '?').join(', ')

    const [tables, columns, fks, stats, routines] = await Promise.all([
      this.rows(
        `SELECT t.TABLE_SCHEMA AS s, t.TABLE_NAME AS t, t.TABLE_TYPE AS type, t.TABLE_COMMENT AS comment, t.TABLE_ROWS AS est,
                v.VIEW_DEFINITION AS definition
           FROM information_schema.TABLES t
           LEFT JOIN information_schema.VIEWS v ON v.TABLE_SCHEMA = t.TABLE_SCHEMA AND v.TABLE_NAME = t.TABLE_NAME
          WHERE t.TABLE_SCHEMA IN (${inList}) ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME`,
        schemas,
      ),
      this.rows(
        `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, COLUMN_NAME AS name, ORDINAL_POSITION AS ord, COLUMN_TYPE AS type,
                IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def, EXTRA AS extra, COLUMN_KEY AS col_key,
                COLUMN_COMMENT AS comment, CHARACTER_MAXIMUM_LENGTH AS max_len
           FROM information_schema.COLUMNS WHERE TABLE_SCHEMA IN (${inList})
          ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
        schemas,
      ),
      this.rows(
        `SELECT k.TABLE_SCHEMA AS s, k.TABLE_NAME AS t, k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col,
                k.REFERENCED_TABLE_SCHEMA AS ref_s, k.REFERENCED_TABLE_NAME AS ref_t, k.REFERENCED_COLUMN_NAME AS ref_col,
                r.UPDATE_RULE AS on_update, r.DELETE_RULE AS on_delete
           FROM information_schema.KEY_COLUMN_USAGE k
           JOIN information_schema.REFERENTIAL_CONSTRAINTS r
             ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
          WHERE k.TABLE_SCHEMA IN (${inList}) AND k.REFERENCED_TABLE_NAME IS NOT NULL
          ORDER BY k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
        schemas,
      ),
      this.rows(
        `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, INDEX_NAME AS name, NON_UNIQUE AS non_unique,
                COLUMN_NAME AS col, INDEX_TYPE AS method
           FROM information_schema.STATISTICS WHERE TABLE_SCHEMA IN (${inList})
          ORDER BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
        schemas,
      ),
      this.rows(
        `SELECT ROUTINE_SCHEMA AS s, ROUTINE_NAME AS name, ROUTINE_TYPE AS kind, DTD_IDENTIFIER AS result
           FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA IN (${inList}) ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME`,
        schemas,
      ),
    ])

    const key = (s: unknown, t: unknown) => `${String(s)}\u0000${String(t)}`
    const byKey = new Map<string, TableInfo>()
    for (const t of tables) {
      const type = String(t.type)
      byKey.set(key(t.s, t.t), {
        schema: String(t.s),
        name: String(t.t),
        type: type === 'VIEW' || type === 'SYSTEM VIEW' ? 'view' : 'table',
        comment: t.comment ? String(t.comment) : null,
        rowEstimate: t.est === null || t.est === undefined ? null : Number(t.est),
        definition: t.definition ? String(t.definition) : null,
        columns: [],
        primaryKey: [],
        foreignKeys: [],
        indexes: [],
      })
    }
    for (const c of columns) {
      const t = byKey.get(key(c.s, c.t))
      if (!t) continue
      const extra = String(c.extra ?? '').toLowerCase()
      t.columns.push({
        name: String(c.name),
        ordinal: Number(c.ord),
        dataType: String(c.type),
        nullable: c.nullable === 'YES',
        defaultValue: c.def === null || c.def === undefined ? null : String(c.def),
        isPrimaryKey: c.col_key === 'PRI',
        isIdentity: extra.includes('auto_increment'),
        isGenerated: extra.includes('generated'),
        maxLength: c.max_len === null || c.max_len === undefined ? null : Number(c.max_len),
        comment: c.comment ? String(c.comment) : null,
      })
    }
    for (const s of stats) {
      const t = byKey.get(key(s.s, s.t))
      if (!t) continue
      const name = String(s.name)
      let ix = t.indexes.find((i) => i.name === name)
      if (!ix) {
        ix = { name, columns: [], unique: Number(s.non_unique) === 0, primary: name === 'PRIMARY', method: String(s.method ?? '') }
        t.indexes.push(ix)
      }
      if (s.col !== null && s.col !== undefined) ix.columns.push(String(s.col))
      if (ix.primary) t.primaryKey = ix.columns
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
          onUpdate: String(fk.on_update),
          onDelete: String(fk.on_delete),
        }
        t.foreignKeys.push(entry)
      }
      entry.columns.push(String(fk.col))
      entry.refColumns.push(String(fk.ref_col))
    }

    return {
      database: currentDb,
      defaultSchema: currentDb,
      schemas,
      tables: [...byKey.values()],
      routines: routines.map((r) => ({
        schema: String(r.s),
        name: String(r.name),
        kind: String(r.kind) === 'PROCEDURE' ? 'procedure' : 'function',
        returnType: r.result ? String(r.result) : null,
      })),
      capturedAt: new Date().toISOString(),
    }
  }
}

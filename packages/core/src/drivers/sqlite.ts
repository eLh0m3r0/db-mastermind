import { Worker } from 'node:worker_threads'
import { sqliteDialect } from '../dialect.js'
import { elapsed, QueryCancelledError, type DatabaseDriver, type IntrospectOptions } from '../driver.js'
import type { BuiltQuery } from '../filters.js'
import type { ConnectionConfig, QueryOptions, QueryResult, SchemaSnapshot, ServerInfo, TableInfo } from '../types.js'
import { normalizeValue } from '../values.js'

/**
 * SQLite runs in a worker thread (node:sqlite is synchronous) so long queries never block the
 * process, and cancelling simply terminates the worker and reopens the database.
 * The worker source is inlined so bundlers don't need a separate entry point.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
process.removeAllListeners('warning')
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(workerData.path, { readOnly: workerData.readOnly, timeout: 5000 })
db.exec('PRAGMA foreign_keys = ON')

// node:sqlite can't bind booleans.
const bind = (params) => params.map((p) => typeof p === 'boolean' ? (p ? 1 : 0) : p)
const fix = (v) => typeof v === 'bigint' ? (v >= Number.MIN_SAFE_INTEGER && v <= Number.MAX_SAFE_INTEGER ? Number(v) : v.toString()) : v

function run(sql, params, maxRows) {
  const stmt = db.prepare(sql)
  stmt.setReadBigInts(true)
  const columns = stmt.columns()
  if (columns.length === 0) {
    const r = stmt.run(...bind(params))
    return { fields: [], rows: [], affectedRows: Number(r.changes) }
  }
  stmt.setReturnArrays(true)
  const rows = []
  let truncated = false
  for (const row of stmt.iterate(...bind(params))) {
    if (rows.length >= maxRows) { truncated = true; break }
    rows.push(row.map(fix))
  }
  return { fields: columns.map((c) => ({ name: c.name, dataType: c.type ?? undefined })), rows, truncated }
}

parentPort.on('message', (msg) => {
  try {
    if (msg.type === 'exec') {
      parentPort.postMessage({ id: msg.id, ok: true, result: run(msg.sql, msg.params ?? [], msg.maxRows ?? Infinity) })
    } else if (msg.type === 'tx') {
      db.exec('BEGIN')
      try {
        const affected = msg.statements.map((s) => Number(db.prepare(s.sql).run(...bind(s.params)).changes))
        db.exec('COMMIT')
        parentPort.postMessage({ id: msg.id, ok: true, result: affected })
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    } else if (msg.type === 'close') {
      db.close()
      parentPort.postMessage({ id: msg.id, ok: true })
    }
  } catch (e) {
    parentPort.postMessage({ id: msg.id, ok: false, error: { message: e.message, code: e.code, errcode: e.errcode } })
  }
})
`

interface WorkerReply {
  id: number
  ok: boolean
  result?: unknown
  error?: { message: string; code?: string }
}

interface RawResult {
  fields: { name: string; dataType?: string }[]
  rows: unknown[][]
  affectedRows?: number
  truncated?: boolean
}

export class SqliteDriver implements DatabaseDriver {
  readonly dialect = sqliteDialect
  private worker?: Worker
  /** Set while the worker is being (re)started; requests wait for it. */
  private starting?: Promise<void>
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  constructor(readonly config: ConnectionConfig) {}

  private spawn(): Promise<void> {
    const path = this.config.filePath
    if (!path) throw new Error('SQLite connection needs a database file')
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { path, readOnly: Boolean(this.config.readOnly) },
    })
    this.worker = worker
    worker.on('message', (reply: WorkerReply) => {
      const p = this.pending.get(reply.id)
      if (!p) return
      this.pending.delete(reply.id)
      if (reply.ok) p.resolve(reply.result)
      else p.reject(Object.assign(new Error(reply.error?.message ?? 'SQLite error'), { code: reply.error?.code }))
    })
    return new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.failAll(err)
        reject(err)
      }
      worker.once('error', onError)
      worker.once('online', () => {
        // Opening the database happens before 'online'; a ping proves it succeeded.
        this.post({ type: 'exec', sql: 'SELECT 1', params: [] }).then(() => {
          worker.off('error', onError)
          worker.on('error', (err) => this.failAll(err as Error))
          resolve()
        }, reject)
      })
    })
  }

  private failAll(err: Error) {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  private async send(msg: Record<string, unknown>): Promise<unknown> {
    if (this.starting) await this.starting
    return this.post(msg)
  }

  private post(msg: Record<string, unknown>): Promise<unknown> {
    const worker = this.worker
    if (!worker) return Promise.reject(new Error('Not connected'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      worker.postMessage({ ...msg, id })
    })
  }

  async connect(): Promise<void> {
    await this.restart()
  }

  private restart(): Promise<void> {
    const starting = this.spawn().finally(() => {
      if (this.starting === starting) this.starting = undefined
    })
    this.starting = starting
    return starting
  }

  async close(): Promise<void> {
    const worker = this.worker
    if (!worker) return
    await this.send({ type: 'close' }).catch(() => {})
    await worker.terminate()
    this.worker = undefined
  }

  async releaseSession(): Promise<void> {
    // Single connection: nothing to release, but don't leave a transaction open.
    await this.send({ type: 'exec', sql: 'ROLLBACK', params: [] }).catch(() => {})
  }

  async execute(sql: string, options: QueryOptions = {}): Promise<QueryResult[]> {
    if (options.signal?.aborted) throw new QueryCancelledError()
    const start = process.hrtime.bigint()
    let cancelled = false
    const onAbort = async () => {
      cancelled = true
      const worker = this.worker
      this.worker = undefined
      // Mark as starting synchronously so requests issued meanwhile wait for the new worker.
      // terminate() only takes effect once SQLite returns to JS, which a single long step may
      // never do soon; don't wait for it, open a fresh worker right away.
      void worker?.terminate()
      const starting = this.spawn().finally(() => {
        if (this.starting === starting) this.starting = undefined
      })
      this.starting = starting
      this.failAll(new QueryCancelledError())
      await starting.catch(() => {})
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const raw = (await this.send({
        type: 'exec',
        sql,
        params: options.params ?? [],
        maxRows: options.maxRows,
      })) as RawResult
      const hasRows = raw.fields.length > 0
      return [
        {
          fields: raw.fields,
          rows: raw.rows.map((r) => r.map(normalizeValue)),
          rowCount: hasRows ? raw.rows.length : (raw.affectedRows ?? 0),
          affectedRows: hasRows ? undefined : raw.affectedRows,
          command: sql.trim().split(/\s+/, 1)[0]?.toUpperCase(),
          truncated: raw.truncated,
          durationMs: elapsed(start),
        },
      ]
    } catch (err) {
      if (cancelled) throw new QueryCancelledError()
      throw err
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  async transaction(statements: BuiltQuery[]): Promise<number[]> {
    return (await this.send({ type: 'tx', statements })) as number[]
  }

  private async rows(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const raw = (await this.send({ type: 'exec', sql, params })) as RawResult
    return raw.rows.map((r) => Object.fromEntries(raw.fields.map((f, i) => [f.name, r[i]])))
  }

  async serverInfo(): Promise<ServerInfo> {
    const [r] = await this.rows('SELECT sqlite_version() AS v')
    return { product: 'SQLite', version: String(r?.v ?? '') }
  }

  async listDatabases(): Promise<string[]> {
    const rows = await this.rows('PRAGMA database_list')
    return rows.map((r) => String(r.name))
  }

  async introspect(options: IntrospectOptions = {}): Promise<SchemaSnapshot> {
    const schemas = options.schemas?.length ? options.schemas : (await this.listDatabases()).filter((d) => d !== 'temp')
    const tables: TableInfo[] = []
    for (const schema of schemas) {
      const q = sqliteDialect.quoteIdent(schema)
      const objects = await this.rows(
        `SELECT name, type, sql FROM ${q}.sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`,
      )
      for (const o of objects) {
        const name = String(o.name)
        const [cols, fks, idxs] = await Promise.all([
          this.rows(`SELECT * FROM pragma_table_xinfo(?, ?)`, [name, schema]),
          this.rows(`SELECT * FROM pragma_foreign_key_list(?, ?)`, [name, schema]),
          this.rows(`SELECT * FROM pragma_index_list(?, ?)`, [name, schema]),
        ])
        const pkCols = cols
          .filter((c) => Number(c.pk) > 0)
          .sort((a, b) => Number(a.pk) - Number(b.pk))
          .map((c) => String(c.name))
        const createSql = await this.rows(`SELECT sql FROM ${q}.sqlite_schema WHERE name = ?`, [name])
        const isAutoinc = /autoincrement/i.test(String(createSql[0]?.sql ?? ''))
        const info: TableInfo = {
          schema,
          name,
          type: o.type === 'view' ? 'view' : 'table',
          definition: o.type === 'view' ? String(o.sql ?? '') : null,
          columns: cols
            .filter((c) => Number(c.hidden) !== 1)
            .map((c, i) => {
              const type = String(c.type || '')
              const isPk = Number(c.pk) > 0
              return {
                name: String(c.name),
                ordinal: i + 1,
                dataType: type || 'any',
                nullable: Number(c.notnull) === 0 && !isPk,
                defaultValue: c.dflt_value === null ? null : String(c.dflt_value),
                isPrimaryKey: isPk,
                // INTEGER PRIMARY KEY is an alias of rowid and auto-assigned.
                isIdentity: isPk && pkCols.length === 1 && (/^integer$/i.test(type) || isAutoinc),
                isGenerated: Number(c.hidden) >= 2,
              }
            }),
          primaryKey: pkCols,
          foreignKeys: [],
          indexes: [],
        }
        const byId = new Map<number, (typeof info.foreignKeys)[number]>()
        for (const fk of fks) {
          const id = Number(fk.id)
          let entry = byId.get(id)
          if (!entry) {
            entry = {
              name: `fk_${name}_${id}`,
              columns: [],
              refSchema: schema,
              refTable: String(fk.table),
              refColumns: [],
              onUpdate: String(fk.on_update),
              onDelete: String(fk.on_delete),
            }
            byId.set(id, entry)
            info.foreignKeys.push(entry)
          }
          entry.columns.push(String(fk.from))
          entry.refColumns.push(fk.to === null ? '' : String(fk.to))
        }
        for (const fk of info.foreignKeys) {
          // REFERENCES t without columns means t's primary key; resolved after all tables are known.
          if (fk.refColumns.every((c) => c === '')) fk.refColumns = []
        }
        for (const ix of idxs) {
          const ixName = String(ix.name)
          const ixCols = await this.rows(`SELECT name FROM pragma_index_info(?, ?) ORDER BY seqno`, [ixName, schema])
          info.indexes.push({
            name: ixName,
            columns: ixCols.map((c) => String(c.name ?? '<expr>')),
            unique: Number(ix.unique) === 1,
            primary: ix.origin === 'pk',
          })
        }
        tables.push(info)
      }
    }
    for (const t of tables) {
      for (const fk of t.foreignKeys) {
        if (fk.refColumns.length) continue
        const ref = tables.find((x) => x.schema === fk.refSchema && x.name === fk.refTable)
        fk.refColumns = ref?.primaryKey ?? []
      }
    }
    return {
      database: this.config.filePath,
      defaultSchema: 'main',
      schemas,
      tables,
      routines: [],
      capturedAt: new Date().toISOString(),
    }
  }
}

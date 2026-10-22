import { trinoDialect } from '../dialect.js'
import { elapsed, QueryCancelledError, type DatabaseDriver, type IntrospectOptions, type StreamBatch, type StreamOptions } from '../driver.js'
import type { BuiltQuery } from '../filters.js'
import type { CellValue, ConnectionConfig, QueryOptions, QueryResult, ResultField, SchemaSnapshot, ServerInfo, TableInfo } from '../types.js'
import { normalizeValue } from '../values.js'

interface TrinoColumn {
  name: string
  type: string
}

interface TrinoResponse {
  id?: string
  nextUri?: string
  columns?: TrinoColumn[]
  data?: unknown[][]
  updateType?: string
  updateCount?: number
  error?: { message?: string; errorName?: string }
}

/** A literal for an inlined parameter (Trino compares typed values; the dialect casts them to the column type). */
export function trinoLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (v instanceof Date) return `TIMESTAMP '${v.toISOString().replace('T', ' ').replace('Z', '')}'`
  if (Array.isArray(v)) return `ARRAY[${v.map(trinoLiteral).join(', ')}]`
  return `'${String(v).replaceAll("'", "''")}'`
}

/** Replaces the dialect's `{__pN}` placeholders with literals. */
export function inlineTrinoParams(sql: string, params: unknown[] = []): string {
  return sql.replace(/\{__p(\d+)\}/g, (_, n: string) => {
    const i = Number(n) - 1
    if (i >= params.length) throw new Error(`Missing value for parameter ${n}`)
    return trinoLiteral(params[i])
  })
}

/** Parses a protocol response keeping 64-bit integers exact (text beyond 2^53). */
export function parseTrinoJson(text: string): TrinoResponse {
  const reviver = (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' && !Number.isSafeInteger(value) && context?.source && /^-?\d+$/.test(context.source) ? context.source : value
  return JSON.parse(text, reviver as (key: string, value: unknown) => unknown) as TrinoResponse
}

/** One value as the protocol sends it, by column type. */
export function trinoValue(type: string, raw: unknown): CellValue {
  if (raw === null || raw === undefined) return null
  const t = type.toLowerCase()
  if (t === 'varbinary' && typeof raw === 'string') return normalizeValue(Buffer.from(raw, 'base64'))
  if (t === 'json' && typeof raw === 'string') {
    try {
      return normalizeValue(JSON.parse(raw))
    } catch {
      return raw
    }
  }
  return normalizeValue(raw) as CellValue
}

const stripComments = (sql: string) => sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ').trim()

/**
 * Trino (and Starburst) over its HTTP protocol: POST the statement, follow `nextUri` for pages, DELETE it to cancel.
 * The connection's database is the catalog; its schemas are the explorer's schemas. Trino tables rarely declare
 * keys, so rows are read-only; statements run without transactions.
 */
export class TrinoDriver implements DatabaseDriver {
  readonly dialect = trinoDialect
  private catalog?: string
  private schema?: string
  private session = new Map<string, string>()
  private version = ''

  constructor(readonly config: ConnectionConfig) {}

  private get baseUrl(): string {
    const host = this.config.host || 'localhost'
    if (/^https?:\/\//.test(host)) return host.replace(/\/+$/, '')
    const tls = !!this.config.ssl && this.config.ssl.mode !== 'disable'
    return `${tls ? 'https' : 'http'}://${host}:${this.config.port ?? (tls ? 443 : 8080)}`
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'X-Trino-User': this.config.user || 'dbmastermind', 'X-Trino-Source': 'DB Mastermind' }
    if (this.config.password) h.Authorization = `Basic ${Buffer.from(`${this.config.user ?? ''}:${this.config.password}`).toString('base64')}`
    if (this.catalog) h['X-Trino-Catalog'] = this.catalog
    if (this.schema) h['X-Trino-Schema'] = this.schema
    if (this.session.size) h['X-Trino-Session'] = [...this.session].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join(',')
    return h
  }

  async connect(): Promise<void> {
    this.catalog = this.config.database?.trim() || undefined
    const schema = this.config.options?.schema
    this.schema = typeof schema === 'string' && schema.trim() ? schema.trim() : undefined
    const res = await fetch(`${this.baseUrl}/v1/info`, { headers: this.headers() })
    if (!res.ok) throw new Error(`Trino at ${this.baseUrl} answered ${res.status} ${res.statusText}`)
    const info = (await res.json()) as { nodeVersion?: { version?: string }; starting?: boolean }
    if (info.starting) throw new Error('Trino is still starting: try again in a moment')
    this.version = info.nodeVersion?.version ?? ''
    // Checks the user, password and catalog.
    await this.rows(this.catalog ? `SELECT 1 FROM ${this.dialect.quoteIdent(this.catalog)}.information_schema.schemata LIMIT 1` : 'SELECT 1')
  }

  async close(): Promise<void> {
    this.session.clear()
  }

  async releaseSession(): Promise<void> {}

  private async request(url: string, init: RequestInit): Promise<TrinoResponse> {
    const res = await fetch(url, { ...init, headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) } })
    const text = await res.text()
    if (!res.ok) {
      if (res.status === 401) throw new Error('Trino rejected the user or password')
      throw new Error(`Trino answered ${res.status}: ${text.slice(0, 300) || res.statusText}`)
    }
    // USE / SET SESSION change the client's session through response headers.
    const setCatalog = res.headers.get('x-trino-set-catalog')
    if (setCatalog) this.catalog = setCatalog
    const setSchema = res.headers.get('x-trino-set-schema')
    if (setSchema) this.schema = setSchema
    for (const pair of (res.headers.get('x-trino-set-session') ?? '').split(',').filter(Boolean)) {
      const [k, v = ''] = pair.split('=')
      if (k) this.session.set(k.trim(), decodeURIComponent(v.trim()))
    }
    for (const k of (res.headers.get('x-trino-clear-session') ?? '').split(',').filter(Boolean)) this.session.delete(k.trim())
    const body = parseTrinoJson(text)
    if (body.error) throw new Error(body.error.message ?? body.error.errorName ?? 'Trino query failed')
    return body
  }

  /** The responses of one statement; stopping early (or `signal`) cancels the query on the server. */
  private async *pages(sql: string, signal?: AbortSignal): AsyncGenerator<TrinoResponse> {
    let next: string | undefined
    let done = false
    const cancel = () => {
      if (next) void fetch(next, { method: 'DELETE', headers: this.headers() }).catch(() => undefined)
    }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      let page = await this.request(`${this.baseUrl}/v1/statement`, { method: 'POST', body: sql, signal })
      for (;;) {
        next = page.nextUri
        yield page
        if (!next) break
        if (signal?.aborted) throw new QueryCancelledError()
        page = await this.request(next, { method: 'GET', signal })
      }
      done = true
    } catch (err) {
      if (signal?.aborted) throw new QueryCancelledError()
      throw err
    } finally {
      signal?.removeEventListener('abort', cancel)
      if (!done) cancel()
    }
  }

  async execute(sql: string, options: QueryOptions = {}): Promise<QueryResult[]> {
    if (options.signal?.aborted) throw new QueryCancelledError()
    const query = inlineTrinoParams(sql.trim().replace(/;\s*$/, ''), options.params)
    const start = process.hrtime.bigint()
    let columns: TrinoColumn[] | undefined
    const rows: CellValue[][] = []
    let updateType: string | undefined
    let updateCount: number | undefined
    let truncated = false
    for await (const page of this.pages(query, options.signal)) {
      columns ??= page.columns
      updateType ??= page.updateType
      if (page.updateCount !== undefined) updateCount = page.updateCount
      for (const r of page.data ?? []) rows.push(r.map((v, i) => trinoValue(columns?.[i]?.type ?? '', v)))
      if (options.maxRows !== undefined && rows.length > options.maxRows) {
        truncated = true
        break
      }
    }
    if (truncated) rows.length = options.maxRows!
    const command = updateType ?? /^\s*(\w+)/.exec(stripComments(query))?.[1]?.toUpperCase()
    if (updateType && updateType !== 'SELECT' && !(columns?.length && !updateCount)) {
      return [{ fields: [], rows: [], rowCount: updateCount ?? 0, affectedRows: updateCount, command, durationMs: elapsed(start) }]
    }
    return [
      {
        fields: (columns ?? []).map((c) => ({ name: c.name, dataType: c.type })),
        rows,
        rowCount: rows.length,
        command: command ?? 'SELECT',
        truncated,
        durationMs: elapsed(start),
      },
    ]
  }

  async *stream(sql: string, options: StreamOptions = {}): AsyncGenerator<StreamBatch> {
    if (options.signal?.aborted) throw new QueryCancelledError()
    const query = inlineTrinoParams(sql.trim().replace(/;\s*$/, ''), options.params)
    const size = options.batchSize ?? 1000
    let fields: ResultField[] = []
    let types: string[] = []
    let batch: CellValue[][] = []
    let yielded = false
    for await (const page of this.pages(query, options.signal)) {
      if (!fields.length && page.columns) {
        fields = page.columns.map((c) => ({ name: c.name, dataType: c.type }))
        types = page.columns.map((c) => c.type)
      }
      for (const r of page.data ?? []) {
        batch.push(r.map((v, i) => trinoValue(types[i] ?? '', v)))
        if (batch.length >= size) {
          yield { fields, rows: batch }
          yielded = true
          batch = []
        }
      }
    }
    if (batch.length || !yielded) yield { fields, rows: batch }
  }

  /** No multi-request transactions from the app: statements run one after another. */
  async transaction(statements: BuiltQuery[]): Promise<number[]> {
    const affected: number[] = []
    for (const s of statements) {
      const [r] = await this.execute(s.sql, { params: s.params })
      affected.push(r?.affectedRows ?? 0)
    }
    return affected
  }

  private async rows(sql: string): Promise<Record<string, unknown>[]> {
    const [r] = await this.execute(sql)
    const names = r?.fields.map((f) => f.name) ?? []
    return (r?.rows ?? []).map((row) => Object.fromEntries(names.map((n, i) => [n, row[i]])))
  }

  async serverInfo(): Promise<ServerInfo> {
    return { product: 'Trino', version: this.version }
  }

  async listDatabases(): Promise<string[]> {
    return (await this.rows('SHOW CATALOGS')).map((r) => String(Object.values(r)[0])).sort()
  }

  async introspect(options: IntrospectOptions = {}): Promise<SchemaSnapshot> {
    if (!this.catalog) throw new Error('Enter a catalog (the connection\'s "Catalog" field) to browse its schemas')
    const info = `${this.dialect.quoteIdent(this.catalog)}.information_schema`
    const wanted = options.schemas?.length ? ` AND table_schema IN (${options.schemas.map(trinoLiteral).join(', ')})` : ''
    const [schemaRows, tableRows, columnRows] = await Promise.all([
      this.rows(`SELECT schema_name FROM ${info}.schemata WHERE schema_name <> 'information_schema' ORDER BY schema_name`),
      this.rows(`SELECT table_schema, table_name, table_type FROM ${info}.tables WHERE table_schema <> 'information_schema'${wanted}`),
      this.rows(
        `SELECT table_schema, table_name, column_name, ordinal_position, data_type, is_nullable, column_default FROM ${info}.columns
          WHERE table_schema <> 'information_schema'${wanted} ORDER BY table_schema, table_name, ordinal_position`,
      ),
    ])
    const tables = new Map<string, TableInfo>()
    const key = (s: unknown, n: unknown) => `${String(s)}.${String(n)}`
    for (const t of tableRows) {
      tables.set(key(t.table_schema, t.table_name), {
        schema: String(t.table_schema),
        name: String(t.table_name),
        type: String(t.table_type) === 'VIEW' ? 'view' : 'table',
        rowEstimate: null,
        columns: [],
        primaryKey: [],
        foreignKeys: [],
        indexes: [],
      })
    }
    for (const c of columnRows) {
      const t = tables.get(key(c.table_schema, c.table_name))
      if (!t) continue
      t.columns.push({
        name: String(c.column_name),
        ordinal: Number(c.ordinal_position),
        dataType: String(c.data_type),
        nullable: String(c.is_nullable) === 'YES',
        defaultValue: c.column_default === null || c.column_default === undefined ? null : String(c.column_default),
        isPrimaryKey: false,
        isIdentity: false,
        comment: null,
      })
    }
    const schemas = schemaRows.map((r) => String(r.schema_name)).filter((s) => !options.schemas?.length || options.schemas.includes(s))
    return {
      database: this.catalog,
      defaultSchema: this.schema && schemas.includes(this.schema) ? this.schema : schemas.includes('default') ? 'default' : schemas[0],
      schemas,
      tables: [...tables.values()].sort((a, b) => (a.schema ?? '').localeCompare(b.schema ?? '') || a.name.localeCompare(b.name)),
      routines: [],
      capturedAt: new Date().toISOString(),
    }
  }
}

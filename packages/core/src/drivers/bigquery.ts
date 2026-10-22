import { readFileSync } from 'node:fs'
import { BigQuery, type BigQueryOptions, type Job, type Query, type TableField } from '@google-cloud/bigquery'
import { bigqueryDialect } from '../dialect.js'
import { elapsed, QueryCancelledError, type DatabaseDriver, type IntrospectOptions, type StreamBatch, type StreamOptions } from '../driver.js'
import type { BuiltQuery } from '../filters.js'
import type { CellValue, ColumnInfo, ConnectionConfig, QueryOptions, QueryResult, SchemaSnapshot, ServerInfo, TableInfo } from '../types.js'
import { normalizeValue } from '../values.js'

interface RawCell {
  v: unknown
}
interface RawRow {
  f: RawCell[]
}

const pad = (n: number | bigint, width = 2) => String(n).padStart(width, '0')

/** A TIMESTAMP from the REST API (microseconds since the epoch, or float seconds) as UTC text. */
export function bigqueryTimestamp(raw: string): string {
  let micros: bigint
  if (/^-?\d+$/.test(raw)) micros = BigInt(raw)
  else micros = BigInt(Math.round(Number.parseFloat(raw) * 1e6))
  const ms = Number(micros / 1000n) - (micros % 1000n < 0n ? 1 : 0)
  const d = new Date(ms)
  const frac = ((micros % 1_000_000n) + 1_000_000n) % 1_000_000n
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` +
    (frac ? `.${pad(frac, 6).replace(/0+$/, '')}` : '') +
    ' UTC'
  )
}

/** One raw REST value (`{v}` cells, `{f}` records) converted by its schema field. */
export function bigqueryValue(field: TableField, raw: unknown): CellValue {
  if (raw === null || raw === undefined) return null
  if (field.mode === 'REPEATED') return (raw as RawCell[]).map((cell) => bigqueryValue({ ...field, mode: 'NULLABLE' }, cell.v))
  const type = String(field.type ?? '').toUpperCase()
  if (type === 'RECORD' || type === 'STRUCT') {
    const cells = (raw as RawRow).f ?? []
    return Object.fromEntries((field.fields ?? []).map((f, i) => [f.name ?? String(i), bigqueryValue(f, cells[i]?.v)]))
  }
  const text = String(raw)
  switch (type) {
    case 'INTEGER':
    case 'INT64': {
      const n = Number(text)
      return Number.isSafeInteger(n) ? n : text
    }
    case 'FLOAT':
    case 'FLOAT64':
      return Number(text)
    case 'BOOLEAN':
    case 'BOOL':
      return text === 'true'
    case 'TIMESTAMP':
      return bigqueryTimestamp(text)
    case 'BYTES':
      return normalizeValue(Buffer.from(text, 'base64'))
    case 'JSON':
      try {
        return normalizeValue(JSON.parse(text))
      } catch {
        return text
      }
    default:
      // NUMERIC/BIGNUMERIC stay exact as text; DATE, DATETIME, TIME, STRING, GEOGRAPHY, INTERVAL are text.
      return text
  }
}

const fieldType = (f: TableField): string => {
  const base = String(f.type ?? '').toUpperCase()
  const type = base === 'INTEGER' ? 'INT64' : base === 'FLOAT' ? 'FLOAT64' : base === 'BOOLEAN' ? 'BOOL' : base === 'RECORD' ? 'STRUCT' : base
  return f.mode === 'REPEATED' ? `ARRAY<${type}>` : type
}

/** Named query parameters (`@p1`…); null needs an explicit type, which STRING satisfies in comparisons. */
export function bigqueryParams(values: unknown[] = []): Pick<Query, 'params' | 'types'> {
  if (!values.length) return {}
  const params: Record<string, unknown> = {}
  const types: Record<string, string> = {}
  values.forEach((v, i) => {
    const name = `p${i + 1}`
    if (v === null || v === undefined) {
      params[name] = null
      types[name] = 'STRING'
    } else if (typeof v === 'bigint') {
      params[name] = v.toString()
      types[name] = 'INT64'
    } else params[name] = v
  })
  return Object.keys(types).length ? { params, types } : { params }
}

/**
 * Google BigQuery over the REST API. Datasets are schemas; the project is the connection's database. Credentials:
 * a service account key (pasted into the password field, stored encrypted, or a key file), otherwise Application
 * Default Credentials (`gcloud auth application-default login`). Rows are read-only: BigQuery keys aren't
 * enforced, so a row can't be addressed safely.
 */
export class BigQueryDriver implements DatabaseDriver {
  readonly dialect = bigqueryDialect
  private client?: BigQuery

  constructor(readonly config: ConnectionConfig) {}

  private get projectId(): string {
    return this.config.database || ''
  }

  private get location(): string | undefined {
    const l = this.config.options?.location
    return typeof l === 'string' && l.trim() ? l.trim() : undefined
  }

  async connect(): Promise<void> {
    const options: BigQueryOptions = { userAgent: 'DB Mastermind' }
    if (this.projectId) options.projectId = this.projectId
    if (this.location) options.location = this.location
    if (this.config.host) options.apiEndpoint = /^https?:\/\//.test(this.config.host) ? this.config.host : `https://${this.config.host}`
    const key = this.config.password?.trim() ? this.config.password : this.config.filePath ? readFileSync(this.config.filePath, 'utf8') : ''
    if (key) {
      let credentials: { client_email?: string; private_key?: string; project_id?: string }
      try {
        credentials = JSON.parse(key) as typeof credentials
      } catch {
        throw new Error('The service account key is not valid JSON (paste the whole key file)')
      }
      options.credentials = { client_email: credentials.client_email, private_key: credentials.private_key }
      options.projectId ??= credentials.project_id
    }
    if (!options.projectId) throw new Error('Enter the Google Cloud project ID')
    this.client = new BigQuery(options)
    try {
      await this.client.query({ query: 'SELECT 1', location: this.location })
    } catch (err) {
      this.client = undefined
      if (/default credentials/i.test((err as Error).message))
        throw new Error('No Google credentials: paste a service account key, or sign in with "gcloud auth application-default login"')
      throw err
    }
  }

  async close(): Promise<void> {
    this.client = undefined
  }

  private get bq(): BigQuery {
    if (!this.client) throw new Error('Not connected')
    return this.client
  }

  async releaseSession(): Promise<void> {}

  private async startJob(sql: string, params: unknown[] | undefined): Promise<Job> {
    const [job] = await this.bq.createQueryJob({ query: sql.trim().replace(/;\s*$/, ''), useLegacySql: false, location: this.location, ...bigqueryParams(params) })
    return job
  }

  private async cancelOnAbort<T>(job: Job, signal: AbortSignal | undefined, work: Promise<T>): Promise<T> {
    if (!signal) return work
    const onAbort = () => void job.cancel().catch(() => undefined)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await work
    } catch (err) {
      if (signal.aborted) throw new QueryCancelledError()
      throw err
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  async execute(sql: string, options: QueryOptions = {}): Promise<QueryResult[]> {
    if (options.signal?.aborted) throw new QueryCancelledError()
    const start = process.hrtime.bigint()
    const job = await this.startJob(sql, options.params)
    return this.cancelOnAbort(job, options.signal, this.read(job, options.maxRows, start))
  }

  private async read(job: Job, maxRows: number | undefined, start: bigint): Promise<QueryResult[]> {
    const fields: TableField[] = []
    const rows: CellValue[][] = []
    let pageToken: string | undefined
    let total = 0
    let affected: number | undefined
    do {
      const want = maxRows === undefined ? 10_000 : Math.min(10_000, maxRows - rows.length + 1)
      const [, , response] = await job.getQueryResults({ autoPaginate: false, skipParsing: true, maxResults: want, pageToken })
      if (!fields.length) fields.push(...(response?.schema?.fields ?? []))
      total = Number(response?.totalRows ?? 0)
      affected = response?.numDmlAffectedRows === undefined ? undefined : Number(response.numDmlAffectedRows)
      for (const r of (response?.rows ?? []) as RawRow[]) rows.push(fields.map((f, i) => bigqueryValue(f, r.f[i]?.v)))
      pageToken = response?.pageToken ?? undefined
    } while (pageToken && (maxRows === undefined || rows.length <= maxRows))
    const meta = job.metadata as { statistics?: { query?: { statementType?: string } } } | undefined
    const statementType = meta?.statistics?.query?.statementType
    const truncated = maxRows !== undefined && (rows.length > maxRows || total > maxRows)
    if (maxRows !== undefined && rows.length > maxRows) rows.length = maxRows
    if (!fields.length) {
      return [{ fields: [], rows: [], rowCount: affected ?? 0, affectedRows: affected, command: statementType, durationMs: elapsed(start) }]
    }
    return [
      {
        fields: fields.map((f) => ({ name: f.name ?? '', dataType: fieldType(f) })),
        rows,
        rowCount: rows.length,
        command: statementType ?? 'SELECT',
        truncated,
        durationMs: elapsed(start),
      },
    ]
  }

  async *stream(sql: string, options: StreamOptions = {}): AsyncGenerator<StreamBatch> {
    if (options.signal?.aborted) throw new QueryCancelledError()
    const job = await this.startJob(sql, options.params)
    const size = options.batchSize ?? 1000
    let pageToken: string | undefined
    let fields: TableField[] = []
    let finished = false
    try {
      do {
        if (options.signal?.aborted) throw new QueryCancelledError()
        const [, , response] = await job.getQueryResults({ autoPaginate: false, skipParsing: true, maxResults: size, pageToken })
        if (!fields.length) fields = response?.schema?.fields ?? []
        const rows = ((response?.rows ?? []) as RawRow[]).map((r) => fields.map((f, i) => bigqueryValue(f, r.f[i]?.v)))
        pageToken = response?.pageToken ?? undefined
        yield { fields: fields.map((f) => ({ name: f.name ?? '', dataType: fieldType(f) })), rows }
      } while (pageToken)
      finished = true
    } finally {
      // Stopped early: the results stay in BigQuery's temporary table; cancel a job that is still running.
      if (!finished) await job.cancel().catch(() => undefined)
    }
  }

  /** BigQuery scripts aren't atomic across API calls: statements run one after another. */
  async transaction(statements: BuiltQuery[]): Promise<number[]> {
    const affected: number[] = []
    for (const s of statements) {
      const [r] = await this.execute(s.sql, { params: s.params })
      affected.push(r?.affectedRows ?? 0)
    }
    return affected
  }

  async serverInfo(): Promise<ServerInfo> {
    return { product: 'BigQuery', version: this.location ? `project ${this.projectId} · ${this.location}` : `project ${this.projectId}` }
  }

  async listDatabases(): Promise<string[]> {
    return [this.projectId]
  }

  private async datasets(): Promise<string[]> {
    const [list] = await this.bq.getDatasets()
    return list.map((d) => d.id ?? '').filter(Boolean).sort()
  }

  async introspect(options: IntrospectOptions = {}): Promise<SchemaSnapshot> {
    const all = await this.datasets()
    const wanted = options.schemas?.length ? all.filter((d) => options.schemas!.includes(d)) : all
    const tables: TableInfo[] = []
    for (const dataset of wanted) tables.push(...(await this.introspectDataset(dataset)))
    return {
      database: this.projectId,
      defaultSchema: all[0],
      schemas: wanted,
      tables: tables.sort((a, b) => (a.schema ?? '').localeCompare(b.schema ?? '') || a.name.localeCompare(b.name)),
      routines: [],
      capturedAt: new Date().toISOString(),
    }
  }

  private async rows(sql: string): Promise<Record<string, unknown>[]> {
    const [rows] = await this.bq.query({ query: sql, useLegacySql: false, location: this.location })
    return rows as Record<string, unknown>[]
  }

  /** One dataset via INFORMATION_SCHEMA (one query each for tables and columns), or the table API as a fallback. */
  private async introspectDataset(dataset: string): Promise<TableInfo[]> {
    const q = (name: string) => `${this.dialect.quoteIdent(this.projectId)}.${this.dialect.quoteIdent(dataset)}.INFORMATION_SCHEMA.${name}`
    let tableRows: Record<string, unknown>[]
    let columnRows: Record<string, unknown>[]
    try {
      ;[tableRows, columnRows] = await Promise.all([
        this.rows(`SELECT table_name, table_type FROM ${q('TABLES')}`),
        this.rows(`SELECT table_name, column_name, ordinal_position, is_nullable, data_type FROM ${q('COLUMNS')} ORDER BY table_name, ordinal_position`),
      ])
    } catch {
      return this.introspectWithApi(dataset)
    }
    const [apiTables] = await this.bq.dataset(dataset).getTables()
    const counts = new Map(apiTables.map((t) => [t.id, (t.metadata as { numRows?: string } | undefined)?.numRows]))
    const byName = new Map<string, TableInfo>()
    for (const t of tableRows) {
      const name = String(t.table_name)
      const kind = String(t.table_type)
      const count = counts.get(name)
      byName.set(name, {
        schema: dataset,
        name,
        type: kind === 'VIEW' ? 'view' : kind === 'MATERIALIZED VIEW' ? 'materialized_view' : kind === 'EXTERNAL' ? 'foreign_table' : 'table',
        rowEstimate: count === undefined ? null : Number(count),
        columns: [],
        primaryKey: [],
        foreignKeys: [],
        indexes: [],
      })
    }
    for (const c of columnRows) {
      const t = byName.get(String(c.table_name))
      if (!t) continue
      t.columns.push(column(String(c.column_name), Number(c.ordinal_position), String(c.data_type), String(c.is_nullable) === 'YES'))
    }
    return [...byName.values()]
  }

  private async introspectWithApi(dataset: string): Promise<TableInfo[]> {
    const [list] = await this.bq.dataset(dataset).getTables()
    const out: TableInfo[] = []
    for (const t of list) {
      const [meta] = (await t.getMetadata()) as unknown as [{ type?: string; numRows?: string; description?: string; schema?: { fields?: TableField[] }; view?: { query?: string } }]
      out.push({
        schema: dataset,
        name: t.id ?? '',
        type: meta.type === 'VIEW' ? 'view' : meta.type === 'MATERIALIZED_VIEW' ? 'materialized_view' : meta.type === 'EXTERNAL' ? 'foreign_table' : 'table',
        comment: meta.description ?? null,
        rowEstimate: meta.numRows === undefined ? null : Number(meta.numRows),
        definition: meta.view?.query,
        columns: (meta.schema?.fields ?? []).map((f, i) => column(f.name ?? '', i + 1, fieldType(f), f.mode !== 'REQUIRED')),
        primaryKey: [],
        foreignKeys: [],
        indexes: [],
      })
    }
    return out
  }
}

function column(name: string, ordinal: number, dataType: string, nullable: boolean): ColumnInfo {
  return { name, ordinal, dataType, nullable, defaultValue: null, isPrimaryKey: false, isIdentity: false, comment: null }
}


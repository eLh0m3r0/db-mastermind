import { createClient, type ClickHouseClient, type ClickHouseSettings } from '@clickhouse/client'
import { clickhouseDialect } from '../dialect.js'
import { checkAffected, elapsed, QueryCancelledError, type DatabaseDriver, type IntrospectOptions, type StreamBatch, type StreamOptions } from '../driver.js'
import type { BuiltQuery } from '../filters.js'
import type { CellValue, ConnectionConfig, QueryOptions, QueryResult, ResultField, SchemaSnapshot, ServerInfo, TableInfo } from '../types.js'
import { normalizeValue } from '../values.js'

const SYSTEM_DATABASES = "('system', 'INFORMATION_SCHEMA', 'information_schema')"

/** Statements that return rows (everything else runs as a command). */
const RETURNS_ROWS = /^(\(|SELECT|WITH|SHOW|DESC|DESCRIBE|EXISTS|EXPLAIN|CHECK|VALUES)\b/i

const stripComments = (sql: string) => sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ').trim()

/** A literal for an inlined parameter; ClickHouse converts string literals to the compared column's type. */
export function clickhouseLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (v instanceof Date) return `'${v.toISOString().replace('T', ' ').replace('Z', '')}'`
  if (Array.isArray(v)) return `[${v.map(clickhouseLiteral).join(', ')}]`
  return `'${String(v).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}

/** Replaces the dialect's `{__pN}` placeholders with literals. */
export function inlineClickHouseParams(sql: string, params: unknown[] = []): string {
  return sql.replace(/\{__p(\d+)\}/g, (_, n: string) => {
    const i = Number(n) - 1
    if (i >= params.length) throw new Error(`Missing value for parameter ${n}`)
    return clickhouseLiteral(params[i])
  })
}

/** One line of a JSONCompactEachRow response; a line that isn't one is the error that ended the query. */
function rowOf(line: string): unknown[] {
  try {
    const row: unknown = JSON.parse(line)
    if (Array.isArray(row)) return row
  } catch {
    // Not JSON: below.
  }
  const text = line.trim()
  throw new Error(/DB::Exception/.test(text) ? text.replace(/\s*\(version [^)]*\)\s*$/, '') : `ClickHouse ended the result with something that is not a row: ${text.slice(0, 300)}`)
}

/**
 * ClickHouse over its HTTP interface. Analytics-first: queries, schema, streaming and exports; row editing is not
 * offered (ClickHouse has no row-level UPDATE), and scripts run without transactions.
 */
export class ClickHouseDriver implements DatabaseDriver {
  readonly dialect = clickhouseDialect
  private client?: ClickHouseClient

  constructor(readonly config: ConnectionConfig) {}

  private get settings(): ClickHouseSettings {
    // Keep 64-bit integers and decimals exact (strings), and stop read-only queries when the client goes away.
    // A query that runs for minutes sends progress headers now and then, so a proxy or load balancer between here and
    // the server doesn't drop the quiet connection (the client warns about the long request_timeout without them).
    return {
      output_format_json_quote_64bit_integers: 1,
      output_format_json_quote_decimals: 1,
      cancel_http_readonly_queries_on_client_close: 1,
      send_progress_in_http_headers: 1,
      http_headers_progress_interval_ms: '110000',
      // Once the response has started (a progress header, or enough rows), an error can only come in the body.
      // ClickHouse would write it as one more row of the format, which reads as data; as plain text it is no row,
      // and rowOf turns it into the error it is.
      http_write_exception_in_output_format: 0,
    }
  }

  async connect(): Promise<void> {
    const tls = !!this.config.ssl && this.config.ssl.mode !== 'disable'
    this.client = createClient({
      url: `${tls ? 'https' : 'http'}://${this.config.host ?? 'localhost'}:${this.config.port ?? (tls ? 8443 : 8123)}`,
      username: this.config.user || 'default',
      password: this.config.password ?? '',
      database: this.config.database || 'default',
      application: 'DB Mastermind',
      request_timeout: 300_000,
      clickhouse_settings: this.settings,
      ...(tls && this.config.ssl?.ca ? { tls: { ca_cert: Buffer.from(this.config.ssl.ca) } } : {}),
    })
    const ping = await this.client.ping()
    if (!ping.success) throw ping.error
  }

  async close(): Promise<void> {
    await this.client?.close()
    this.client = undefined
  }

  private get db(): ClickHouseClient {
    if (!this.client) throw new Error('Not connected')
    return this.client
  }

  async releaseSession(): Promise<void> {}

  async execute(sql: string, options: QueryOptions = {}): Promise<QueryResult[]> {
    if (options.signal?.aborted) throw new QueryCancelledError()
    const query = inlineClickHouseParams(sql.trim().replace(/;\s*$/, ''), options.params)
    const start = process.hrtime.bigint()
    const session = options.session ? { session_id: `dbm-${options.session}` } : {}
    try {
      if (!RETURNS_ROWS.test(stripComments(query))) {
        // (readonly 2: the server refuses anything that writes, settings may still be given.)
        const r = await this.db.command({ query, abort_signal: options.signal, ...(options.unconfirmed ? { clickhouse_settings: { ...this.settings, readonly: '2' } } : {}), ...session })
        const written = Number(r.summary?.written_rows ?? 0)
        const command = /^\s*(\w+)/.exec(stripComments(query))?.[1]?.toUpperCase()
        return [{ fields: [], rows: [], rowCount: written, affectedRows: written || undefined, command, durationMs: elapsed(start) }]
      }
      const limit = options.maxRows === undefined ? {} : { max_result_rows: String(options.maxRows + 1), result_overflow_mode: 'break' as const }
      const rs = await this.db.query({ query, format: 'JSONCompactEachRowWithNamesAndTypes', abort_signal: options.signal, clickhouse_settings: { ...this.settings, ...limit, ...(options.unconfirmed ? { readonly: '2' } : {}) }, ...session })
      const lines = (await rs.text()).split('\n').filter((l) => l.trim())
      const [names = [], types = [], ...data] = lines.map(rowOf)
      let rows = data as unknown[][]
      const truncated = options.maxRows !== undefined && rows.length > options.maxRows
      if (truncated) rows = rows.slice(0, options.maxRows)
      return [
        {
          fields: (names as string[]).map((name, i) => ({ name, dataType: String((types as string[])[i] ?? '') })),
          rows: rows.map((r) => r.map((v) => normalizeValue(v) as CellValue)),
          rowCount: rows.length,
          command: 'SELECT',
          truncated,
          durationMs: elapsed(start),
        },
      ]
    } catch (err) {
      if (options.signal?.aborted) throw new QueryCancelledError()
      throw err
    }
  }

  async *stream(sql: string, options: StreamOptions = {}): AsyncGenerator<StreamBatch> {
    if (options.signal?.aborted) throw new QueryCancelledError()
    const query = inlineClickHouseParams(sql.trim().replace(/;\s*$/, ''), options.params)
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const rs = await this.db.query({ query, format: 'JSONCompactEachRowWithNamesAndTypes', abort_signal: controller.signal })
      let names: string[] | undefined
      let fields: ResultField[] = []
      let batch: CellValue[][] = []
      const size = options.batchSize ?? 1000
      for await (const rows of rs.stream()) {
        for (const row of rows) {
          const values = rowOf(row.text)
          if (!names) {
            names = values as string[]
            continue
          }
          if (!fields.length) {
            fields = names.map((name, i) => ({ name, dataType: String(values[i] ?? '') }))
            continue
          }
          batch.push(values.map((v) => normalizeValue(v) as CellValue))
          if (batch.length >= size) {
            yield { fields, rows: batch }
            batch = []
          }
        }
      }
      if (batch.length || !fields.length) yield { fields: fields.length ? fields : (names ?? []).map((name) => ({ name })), rows: batch }
    } catch (err) {
      if (options.signal?.aborted) throw new QueryCancelledError()
      throw err
    } finally {
      // Stopping early (the consumer broke out of the loop) also ends the HTTP request and the query.
      controller.abort()
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  /** No transactions in ClickHouse: statements run one after another. */
  async transaction(statements: BuiltQuery[]): Promise<number[]> {
    const affected: number[] = []
    for (const s of statements) {
      const [r] = await this.execute(s.sql, { params: s.params })
      affected.push(checkAffected(s, r?.affectedRows ?? 0))
    }
    return affected
  }

  private async rows(query: string): Promise<Record<string, unknown>[]> {
    const rs = await this.db.query({ query, format: 'JSONEachRow' })
    return rs.json<Record<string, unknown>>()
  }

  async serverInfo(): Promise<ServerInfo> {
    const [r] = await this.rows('SELECT version() AS v')
    return { product: 'ClickHouse', version: String(r?.v ?? '') }
  }

  async listDatabases(): Promise<string[]> {
    const rows = await this.rows(`SELECT name FROM system.databases WHERE name NOT IN ${SYSTEM_DATABASES} ORDER BY name`)
    return rows.map((r) => String(r.name))
  }

  async introspect(options: IntrospectOptions = {}): Promise<SchemaSnapshot> {
    const wanted = options.schemas?.length ? new Set(options.schemas) : null
    const [[current], databases, tableRows, columnRows] = await Promise.all([
      this.rows('SELECT currentDatabase() AS db'),
      this.rows(`SELECT name FROM system.databases WHERE name NOT IN ${SYSTEM_DATABASES} ORDER BY name`),
      this.rows(
        `SELECT database, name, engine, comment, total_rows, sorting_key, as_select FROM system.tables
          WHERE database NOT IN ${SYSTEM_DATABASES} AND NOT is_temporary`,
      ),
      this.rows(
        `SELECT database, table, name, position, type, default_kind, default_expression, comment, is_in_sorting_key FROM system.columns
          WHERE database NOT IN ${SYSTEM_DATABASES} ORDER BY database, table, position`,
      ),
    ])
    const keep = (db: unknown) => !wanted || wanted.has(String(db))
    const tables = new Map<string, TableInfo>()
    const key = (db: unknown, name: unknown) => `${String(db)}.${String(name)}`
    for (const t of tableRows.filter((r) => keep(r.database))) {
      const engine = String(t.engine)
      const type = engine === 'View' ? 'view' : engine === 'MaterializedView' ? 'materialized_view' : 'table'
      const sorting = String(t.sorting_key ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      tables.set(key(t.database, t.name), {
        schema: String(t.database),
        name: String(t.name),
        type,
        comment: [t.comment ? String(t.comment) : '', type === 'table' ? `ENGINE = ${engine}` : ''].filter(Boolean).join(' · ') || null,
        rowEstimate: t.total_rows == null ? null : Number(t.total_rows),
        definition: type !== 'table' && t.as_select ? String(t.as_select) : undefined,
        columns: [],
        // The sorting key is not a unique row key, so rows aren't editable; it's shown as an index instead.
        primaryKey: [],
        foreignKeys: [],
        indexes: sorting.length ? [{ name: 'ORDER BY', columns: sorting, unique: false, primary: false }] : [],
      })
    }
    for (const c of columnRows) {
      const t = tables.get(key(c.database, c.table))
      if (!t) continue
      const type = String(c.type)
      const kind = String(c.default_kind ?? '')
      t.columns.push({
        name: String(c.name),
        ordinal: Number(c.position),
        dataType: type,
        nullable: type.startsWith('Nullable('),
        defaultValue: kind === 'DEFAULT' && c.default_expression ? String(c.default_expression) : null,
        isPrimaryKey: false,
        isIdentity: false,
        comment: [c.comment ? String(c.comment) : '', kind && kind !== 'DEFAULT' ? `${kind} ${String(c.default_expression ?? '')}` : ''].filter(Boolean).join(' · ') || null,
      })
    }
    return {
      database: String(current?.db ?? this.config.database ?? 'default'),
      defaultSchema: String(current?.db ?? 'default'),
      schemas: databases.map((r) => String(r.name)).filter(keep),
      tables: [...tables.values()].sort((a, b) => (a.schema ?? '').localeCompare(b.schema ?? '') || a.name.localeCompare(b.name)),
      routines: [],
      capturedAt: new Date().toISOString(),
    }
  }
}

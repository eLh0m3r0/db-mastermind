import { checkCondition } from './ddl.js'
import { qualify } from './dialect.js'
import { checkAffected, GuardBrokenError, isLockTimeout, QueryCancelledError, ReadOnlyViolationError, TooManyRowsError, RowLockedError, type DatabaseDriver, type StreamBatch, type StreamOptions } from './driver.js'
import { readVerdict, type ReadProfile } from './sql-readonly.js'
import { lex, type LexModes } from './sql-lexer.js'
import { BigQueryDriver } from './drivers/bigquery.js'
import { TrinoDriver } from './drivers/trino.js'
import { ClickHouseDriver } from './drivers/clickhouse.js'
import { DuckDBDriver } from './drivers/duckdb.js'
import { MssqlDriver } from './drivers/mssql.js'
import { MysqlDriver } from './drivers/mysql.js'
import { OracleDriver } from './drivers/oracle.js'
import { PostgresDriver } from './drivers/postgres.js'
import { SqliteDriver } from './drivers/sqlite.js'
import { buildCount, buildSelect, type BuiltQuery, type FilterNode, type SortSpec } from './filters.js'
import { buildChangeStatements, lockRowsFirst, type RowChange } from './mutations.js'
import { bindParameters, extractParameters } from './parameters.js'
import { KnowledgeBase, relationToForeignKey } from './knowledge.js'
import { findTable } from './schema-utils.js'
import { profileQueries, type ColumnProfile } from './profile.js'
import { classifyStatement, fitsReadOnlyTransaction, isCopyFromStdin, isReadOnlyCondition, isReadOnlyScript, opensTransaction, splitStatements, stripLiterals } from './sql-split.js'
import type { CheckInfo, ConnectionConfig, QueryResult, SchemaSnapshot, ServerInfo, StatementOutcome, TableInfo, TablePage, TableRef, TransactionState } from './types.js'

export function createDriver(config: ConnectionConfig): DatabaseDriver {
  switch (config.driver) {
    case 'postgres':
      return new PostgresDriver(config)
    case 'mysql':
    case 'mariadb':
      return new MysqlDriver(config)
    case 'mssql':
      return new MssqlDriver(config)
    case 'sqlite':
      return new SqliteDriver(config)
    case 'oracle':
      return new OracleDriver(config)
    case 'duckdb':
      return new DuckDBDriver(config)
    case 'clickhouse':
      return new ClickHouseDriver(config)
    case 'bigquery':
      return new BigQueryDriver(config)
    case 'trino':
      return new TrinoDriver(config)
  }
}


/** How long a grid save waits for rows another session has locked. */
const GRID_LOCK_TIMEOUT_MS = 5000
/** How long an unconfirmed (AI) read on SQL Server waits for locked rows. */
const READ_LOCK_TIMEOUT_MS = 10000
/** A time limit for SQL nobody confirmed where the session has none of its own. */
const UNCONFIRMED_TIMEOUT_MS = 60_000
/**
 * The guard's PostgreSQL transaction reads strings in the standard way whatever the database or role says: with
 * standard_conforming_strings off a backslash is an escape, the server would read a text differently from the
 * tokenizer, and what the app takes for one string could hold a call it refuses by name.
 */
const PG_STANDARD_STRINGS = `SELECT set_config('standard_conforming_strings', 'on', true)`
/** That, and a time limit where the session has none (pg_sleep and friends). */
const PG_GUARD_SETTINGS = `${PG_STANDARD_STRINGS}, set_config('statement_timeout', CASE WHEN current_setting('statement_timeout') = '0' THEN '${UNCONFIRMED_TIMEOUT_MS}ms' ELSE current_setting('statement_timeout') END, true)`
/** (SQL Server's limit and a stream's first-batch limit are the app's own timer: tests shorten it with DBM_UNCONFIRMED_TIMEOUT_MS.) */
const appUnconfirmedTimeoutMs = () => Number(process.env.DBM_UNCONFIRMED_TIMEOUT_MS) || UNCONFIRMED_TIMEOUT_MS

/** Whether a filter has free-form SQL of its own (typed in the grid, or written by AI). */
const hasRawFilter = (node: FilterNode | undefined): boolean => !!node && (node.kind === 'raw' ? !!node.sql.trim() : node.kind === 'group' ? node.children.some(hasRawFilter) : false)

/** Lock timeout for a grid save inside a session's transaction: set, and set back (session-wide settings). */
const digits = (v: string) => (/^-?\d+(ms)?$/.test(v) ? v : null)
const SESSION_LOCK_TIMEOUT: Partial<Record<ConnectionConfig['driver'], { read: string; set: string; restore: (prior: string) => string }>> = {
  postgres: { read: 'SHOW lock_timeout', set: `SET LOCAL lock_timeout = ${GRID_LOCK_TIMEOUT_MS}`, restore: (p) => `SET LOCAL lock_timeout = '${p.replace(/'/g, "''")}'` },
  mysql: { read: 'SELECT @@SESSION.innodb_lock_wait_timeout', set: `SET SESSION innodb_lock_wait_timeout = ${GRID_LOCK_TIMEOUT_MS / 1000}`, restore: (p) => `SET SESSION innodb_lock_wait_timeout = ${digits(p) ?? 'DEFAULT'}` },
  mariadb: { read: 'SELECT @@SESSION.innodb_lock_wait_timeout', set: `SET SESSION innodb_lock_wait_timeout = ${GRID_LOCK_TIMEOUT_MS / 1000}`, restore: (p) => `SET SESSION innodb_lock_wait_timeout = ${digits(p) ?? 'DEFAULT'}` },
  mssql: { read: 'SELECT @@LOCK_TIMEOUT', set: `SET LOCK_TIMEOUT ${GRID_LOCK_TIMEOUT_MS}`, restore: (p) => `SET LOCK_TIMEOUT ${digits(p) ?? -1}` },
}

export interface RunScriptOptions {
  session?: string
  maxRows?: number
  signal?: AbortSignal
  /** Continue with the next statement after an error. */
  continueOnError?: boolean
  params?: unknown[]
  /** Values for `:name` / `?` / `$1` parameters (keys: `name`, `$1`…); bound per statement. */
  parameterValues?: Record<string, string | null>
  /**
   * Only reads, enforced by the database where it can: the script runs on its own connection inside a read-only
   * transaction that is always rolled back (unconfirmed AI queries; a SELECT may call a function that writes).
   */
  readOnly?: boolean
  /**
   * A SQL editor tab's run: follows the connection's commit mode (`manualCommit` opens a transaction before the
   * first statement that changes something) and notes a statement that committed an open transaction on its own.
   */
  editor?: boolean
}


export interface FetchTableOptions {
  table: TableRef
  filter?: FilterNode
  sort?: SortSpec[]
  limit: number
  offset?: number
  signal?: AbortSignal
  /** The table tab's session: with manual commit it reads there, so its own uncommitted changes show. */
  session?: string
}

/** Describes an error from any driver in a uniform, serializable way. */
export function describeError(err: unknown): { message: string; code?: string; position?: number } {
  if (err instanceof Error) {
    const e = err as Error & { code?: string | number; position?: string; number?: number; originalError?: Error; errors?: unknown[] }
    // Stopping a query is the user's choice, not a failure: the UI shows it without error styling.
    const code = e.name === 'QueryCancelledError' ? 'CANCELLED' : (e.code ?? (e.number !== undefined ? String(e.number) : undefined))
    // Node reports a refused "localhost" (tried on ::1 and 127.0.0.1) as an AggregateError with an empty message.
    const inner = Array.isArray(e.errors) ? [...new Set(e.errors.map((x) => (x instanceof Error ? x.message : String(x))).filter(Boolean))].join('; ') : ''
    return {
      message: e.message || inner || e.originalError?.message || String(err),
      code: code === undefined ? undefined : String(code),
      position: e.position ? Number(e.position) : undefined,
    }
  }
  return { message: String(err) }
}

interface OpenConnection {
  config: ConnectionConfig
  driver: DatabaseDriver
  /** Sessions that ran editor statements (query tabs, the AI chat's writes): what may hold a transaction open. */
  editorSessions?: Set<string>
  schema?: SchemaSnapshot
  schemaPromise?: Promise<SchemaSnapshot>
  serverInfo?: ServerInfo
}

/**
 * Owns live connections. Shared by the desktop app and the MCP server so both behave identically,
 * including read-only enforcement.
 */
/**
 * What only psql understands, said plainly instead of the server's "syntax error at or near \": meta-commands
 * (\d, \dt, \timing) and COPY … FROM STDIN with its data.
 */
function refusePsqlOnly(sql: string): void {
  const meta = /^\\(\S+)/.exec(sql)
  if (meta) {
    const hint = /^d[a-zA-Z+]*$/.test(meta[1]!) ? ' The explorer shows tables, columns, indexes and definitions (right-click → Definition).' : ''
    throw new Error(`\\${meta[1]} is a psql command, not SQL: the server can't run it.${hint}`)
  }
  if (isCopyFromStdin(sql)) {
    throw new Error('COPY … FROM STDIN needs psql to send the data. Use Import data (CSV / Excel) on the table, or INSERT statements.')
  }
}

export class DatabaseService {
  private open = new Map<string, OpenConnection>()

  constructor(private readonly driverFactory: (config: ConnectionConfig) => DatabaseDriver = createDriver) {}

  isOpen(id: string): boolean {
    return this.open.has(id)
  }

  /** Opens (or re-opens with new config) a connection. */
  async connect(config: ConnectionConfig): Promise<ServerInfo> {
    await this.disconnect(config.id)
    const driver = this.driverFactory(config)
    try {
      await driver.connect()
    } catch (err) {
      // A half-open driver (an SSH tunnel up, the login refused) must not stay behind.
      await driver.close().catch(() => {})
      throw err
    }
    const entry: OpenConnection = { config, driver }
    this.open.set(config.id, entry)
    for (const p of this.allowedFiles.get(config.id) ?? []) (driver as { allowFile?: (path: string) => void }).allowFile?.(p)
    try {
      entry.serverInfo = await driver.serverInfo()
    } catch {
      entry.serverInfo = { product: config.driver, version: '' }
    }
    return entry.serverInfo
  }

  /** Connects with a throwaway driver, returns server info, and disconnects. */
  async test(config: ConnectionConfig): Promise<ServerInfo> {
    const driver = this.driverFactory(config)
    try {
      await driver.connect()
      return await driver.serverInfo()
    } finally {
      await driver.close().catch(() => {})
    }
  }

  /** Settings that need no new connection (see `needsReconnect`) take effect at once. */
  reconfigure(config: ConnectionConfig): void {
    const entry = this.open.get(config.id)
    if (entry) entry.config = { ...config, password: entry.config.password }
  }

  async disconnect(id: string): Promise<void> {
    const entry = this.open.get(id)
    if (!entry) return
    this.open.delete(id)
    await entry.driver.close().catch(() => {})
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.open.keys()].map((id) => this.disconnect(id)))
  }

  private get(id: string): OpenConnection {
    const entry = this.open.get(id)
    if (!entry) throw new Error('Connection is not open')
    return entry
  }

  config(id: string): ConnectionConfig {
    return this.get(id).config
  }

  driver(id: string): DatabaseDriver {
    return this.get(id).driver
  }

  serverInfo(id: string): ServerInfo | undefined {
    return this.open.get(id)?.serverInfo
  }

  async schema(id: string, refresh = false): Promise<SchemaSnapshot> {
    const entry = this.get(id)
    if (!refresh && entry.schema) return entry.schema
    if (!refresh && entry.schemaPromise) return entry.schemaPromise
    const promise = entry.driver.introspect().then((snapshot) => withDocumentedRelations(snapshot, entry.config))
    entry.schemaPromise = promise
    try {
      entry.schema = await promise
      return entry.schema
    } finally {
      if (entry.schemaPromise === promise) entry.schemaPromise = undefined
    }
  }

  async findTable(id: string, ref: TableRef): Promise<TableInfo | undefined> {
    const snapshot = await this.schema(id)
    return findTable(snapshot, ref)
  }

  /**
   * A check's condition as the database itself would store it on that table, next to the condition the table's
   * check of that name has, stored the same way: the two can then be compared (a database rewrites a condition
   * when it takes it: `x IN (1, 2)` comes back as `x = ANY (ARRAY[1, 2])`). Both conditions are put on a
   * temporary copy of the table's columns, which is thrown away. PostgreSQL, MySQL and SQL Server. `null` where
   * the database can't say (another engine, a read-only connection, a condition it refuses); `missingColumn`
   * when the model's condition names a column the table does not have.
   */
  async canonicalChecks(id: string, items: { table: TableRef; check: CheckInfo }[]): Promise<({ definition: string; current?: string } | { missingColumn: true } | null)[]> {
    const entry = this.get(id)
    const driver = entry.config.driver
    const d = entry.driver.dialect
    const out: ({ definition: string; current?: string } | { missingColumn: true } | null)[] = []
    if (driver !== 'postgres' && driver !== 'mysql' && driver !== 'mssql') return items.map(() => null)
    // The probe writes a temporary table: a read-only connection never writes, so it can't say.
    if (entry.config.readOnly) return items.map(() => null)
    for (const { table, check } of items) {
      try {
        const live = await this.findTable(id, table)
        // PostgreSQL reports a table's check with the very function that reads the probe, so the model's condition
        // is compared with that report as it is (fed back, its own text does not always come out the same again).
        // MySQL and SQL Server report it from another place than the probe is read from: there the table's
        // condition goes through the probe as well.
        const twin = driver !== 'postgres' && check.name ? live?.checks?.find((c) => c.name?.toLowerCase() === check.name!.toLowerCase()) : undefined
        if (!live) {
          out.push(null)
          continue
        }
        const source = `${live.schema ? `${d.quoteIdent(live.schema)}.` : ''}${d.quoteIdent(live.name)}`
        const model = checkCondition(check, live.columns, d)
        // Names nobody else has: check names are per schema in MySQL and SQL Server, also for temporary tables.
        const tag = Math.random().toString(36).slice(2, 10)
        const [m, c] = [`dbm_m_${tag}`, `dbm_c_${tag}`]
        const probe = driver === 'mssql' ? `#dbm_probe_${tag}` : `dbm_probe_${tag}`
        const add = (name: string, condition: string) => `ALTER TABLE ${probe} ADD CONSTRAINT ${name} CHECK (${condition})`
        const script =
          driver === 'postgres'
            ? ['BEGIN', `CREATE TEMP TABLE ${probe} (LIKE ${source}) ON COMMIT DROP`, add(m, model), ...(twin ? [add(c, twin.expression)] : []), `SELECT conname, pg_get_constraintdef(oid, true) FROM pg_constraint WHERE conrelid = '${probe}'::regclass AND conname IN ('${m}', '${c}')`, 'ROLLBACK']
            : driver === 'mysql'
              ? [`CREATE TEMPORARY TABLE ${probe} LIKE ${source}`, add(m, model), ...(twin ? [add(c, twin.expression)] : []), `SHOW CREATE TABLE ${probe}`, `DROP TEMPORARY TABLE IF EXISTS ${probe}`]
              : [`SELECT TOP 0 * INTO ${probe} FROM ${source}`, add(m, model), ...(twin ? [add(c, twin.expression)] : []), `SELECT name, definition FROM tempdb.sys.check_constraints WHERE name IN ('${m}', '${c}')`, `DROP TABLE ${probe}`]
        const outcomes = await this.runScript(id, script.join(';\n'), { continueOnError: true })
        // The model's condition is the second statement after the copy; the last is the clean-up, which always runs.
        // (SQL Server takes the script as one batch: one outcome with a result set per statement that has one.)
        const modelFailed = driver === 'mssql' ? outcomes.find((o) => o.error)?.error : outcomes[driver === 'postgres' ? 2 : 1]?.error
        if (modelFailed) {
          out.push(modelFailed.code === '42703' || /unknown column|invalid column name|column .* does not exist/i.test(modelFailed.message) ? { missingColumn: true } : null)
          continue
        }
        const read = driver === 'mssql' ? outcomes.flatMap((o) => o.results ?? []).find((r) => r.rows.some((row) => String(row[0]).startsWith('dbm_'))) : outcomes[outcomes.length - 2]?.results?.[0]
        const found = new Map<string, string>()
        if (driver === 'mysql') {
          const ddl = String(read?.rows[0]?.[1] ?? '')
          for (const line of ddl.matchAll(/CONSTRAINT `(dbm_[mc]_\w+)` CHECK \((.*)\)(?: \/\*.*?\*\/)?,?$/gm)) found.set(line[1]!, line[2]!.replace(/\b_[a-z0-9]+(?=')/gi, ''))
        } else {
          for (const row of read?.rows ?? []) {
            const text = String(row[1] ?? '')
            // (SQL Server keeps names as they were typed and finds them whatever their case: outside its strings, case is not a difference.)
            found.set(String(row[0]), driver === 'postgres' ? (/^CHECK \((.*)\)(?: NOT VALID| NO INHERIT)*$/s.exec(text)?.[1] ?? '') : text.replace(/'(?:[^']|'')*'|[^']+/g, (part) => (part.startsWith("'") ? part : part.toLowerCase())))
          }
        }
        const definition = found.get(m)
        // The table's own condition must have gone through the same way, or there is nothing sound to compare with.
        out.push(definition && (!twin || found.get(c)) ? { definition, ...(twin ? { current: found.get(c)! } : {}) } : null)
      } catch {
        out.push(null)
      }
    }
    return out
  }

  private assertAllowed(entry: OpenConnection, sql: string) {
    if (entry.config.readOnly && !isReadOnlyScript(sql, entry.config.driver)) throw new ReadOnlyViolationError()
  }

  /** Free-form SQL in a filter only reads, on every connection: a filter (also one AI wrote) never changes data. */
  private assertFilterReads(entry: OpenConnection, node: FilterNode | undefined) {
    if (!node) return
    if (node.kind === 'group') return node.children.forEach((child) => this.assertFilterReads(entry, child))
    if (node.kind === 'raw' && node.sql.trim() && !isReadOnlyCondition(node.sql, entry.config.driver)) {
      throw new ReadOnlyViolationError('A SQL filter can only be a condition that reads: run changes in the SQL editor.')
    }
  }

  /** Splits and runs a script statement by statement, collecting per-statement outcomes. */
  async runScript(id: string, script: string, options: RunScriptOptions = {}): Promise<StatementOutcome[]> {
    const entry = this.get(id)
    // SQL nobody confirmed (`readOnly`), and everything on a read-only connection: the guarded path.
    // (`readOnly: false` is an explicit choice of the caller for a connection that allows writes.)
    if (options.readOnly || (entry.config.readOnly && options.readOnly === undefined)) {
      try {
        // Two profiles: SQL nobody confirmed (AI, MCP) is `agent`; the user's own SQL on a read-only connection `user`.
        return await this.runUnconfirmed(entry, script, options, options.readOnly ? 'agent' : 'user')
      } catch (err) {
        // A read-only connection reports a refused script like any failed statement; callers of readOnly get the error.
        if (options.readOnly || !(err instanceof ReadOnlyViolationError)) throw err
        return [{ sql: script, start: 0, end: script.length, error: describeError(err), durationMs: 0 }]
      }
    }
    // T-SQL batches run as a whole (variables and temp tables span statements); only GO splits them.
    const statements = splitStatements(script, entry.config.driver, { batchesOnly: entry.config.driver === 'mssql' })
    const outcomes: StatementOutcome[] = []
    let inTransaction = false
    const editorSession = options.editor && options.session && entry.driver.transactionState ? options.session : undefined
    if (editorSession) (entry.editorSessions ??= new Set()).add(editorSession)
    const manual = !!editorSession && !!entry.config.manualCommit && !entry.config.readOnly && !!entry.driver.dialect.begin
    // PostgreSQL aborts a whole transaction on any error: with manual commit each statement gets a savepoint, so a
    // typo undoes only itself (psql's ON_ERROR_ROLLBACK). Real PostgreSQL only (CockroachDB, Redshift differ).
    const statementSavepoints = manual && entry.config.driver === 'postgres' && entry.serverInfo?.product === 'PostgreSQL'
    const runningKey = editorSession ? `${id}\u0000${editorSession}` : undefined
    if (runningKey) this.running.set(runningKey, (this.running.get(runningKey) ?? 0) + 1)
    // A multi-statement script runs on one connection (BEGIN … COMMIT must not hop between pooled connections).
    const temporary = !options.session && statements.filter((s) => s.text).length > 1 ? `script-${Date.now()}-${Math.random().toString(36).slice(2)}` : undefined
    if (temporary) options = { ...options, session: temporary }
    try {
      for (const statement of statements) {
        if (!statement.text) continue
        const started = Date.now()
        try {
          if (entry.config.driver === 'postgres') refusePsqlOnly(statement.text)
          this.assertAllowed(entry, statement.text)
          let text = statement.text
          let params = statements.length === 1 ? options.params : undefined
          if (options.parameterValues && extractParameters(text, entry.config.driver).length) {
            const bound = bindParameters(text, entry.config.driver, entry.driver.dialect, options.parameterValues)
            text = bound.sql
            params = bound.params
          }
          // MySQL, MariaDB and Oracle commit an open transaction before DDL: worth saying, the user expected to decide.
          const watch = editorSession && ['ddl', 'other'].includes(classifyStatement(statement.text)) && !/\b(COMMIT|ROLLBACK|ABORT|PREPARE\s+TRANSACTION)\b/i.test(stripLiterals(statement.text, entry.config.driver)) ? await this.transactionState(id, editorSession) : undefined
          if (manual && opensTransaction(statement.text, entry.config.driver) && (watch ?? (await this.transactionState(id, editorSession!))) === 'none') {
            await entry.driver.execute(entry.driver.dialect.begin, { session: editorSession })
          }
          const guarded = statementSavepoints && classifyStatement(statement.text) !== 'transaction' && (await this.transactionState(id, editorSession!)) === 'open'
          if (guarded) await entry.driver.execute('SAVEPOINT dbm_statement', { session: editorSession })
          let results: QueryResult[]
          try {
            results = await entry.driver.execute(text, {
              session: options.session,
              maxRows: options.maxRows,
              signal: options.signal,
              params,
            })
          } catch (err) {
            if (guarded) {
              await entry.driver.execute('ROLLBACK TO SAVEPOINT dbm_statement', { session: editorSession }).catch(() => {})
              await entry.driver.execute('RELEASE SAVEPOINT dbm_statement', { session: editorSession }).catch(() => {})
              throw Object.assign(err as Error, { undoneOnly: true })
            }
            throw err
          }
          if (guarded) await entry.driver.execute('RELEASE SAVEPOINT dbm_statement', { session: editorSession }).catch(() => {})
          const committed = watch === 'open' && (await this.transactionState(id, editorSession!)) === 'none'
          const messages = results.flatMap((r) => r.messages ?? [])
          outcomes.push({
            sql: statement.text,
            start: statement.start,
            end: statement.end,
            results: results.filter((r) => !r.messagesOnly),
            durationMs: Date.now() - started,
            ...(messages.length ? { messages } : {}),
            ...(committed ? { note: 'This statement committed the open transaction: the database commits before and after a schema change.' } : {}),
          })
          if (classifyStatement(statement.text) === 'transaction') inTransaction = /^\s*(BEGIN|START)\b/i.test(statement.text)
          // T-SQL batches contain BEGIN TRAN … COMMIT inside one statement.
          if (entry.config.driver === 'mssql' && /\bBEGIN\s+TRAN/i.test(statement.text)) inTransaction = !/\b(COMMIT|ROLLBACK)\b/i.test(statement.text.slice(statement.text.search(/\bBEGIN\s+TRAN/i)))
        } catch (err) {
          outcomes.push({
            sql: statement.text,
            start: statement.start,
            end: statement.end,
            error: describeError(err),
            durationMs: Date.now() - started,
            ...((err as { notices?: string[] }).notices?.length ? { messages: (err as { notices: string[] }).notices } : {}),
            ...((err as { undoneOnly?: boolean }).undoneOnly ? { note: 'Only this statement was undone: the transaction stays open with the earlier changes.' } : {}),
          })
          if (!options.continueOnError || options.signal?.aborted) {
            // A failed script must not leave its transaction open (PostgreSQL would reject everything after). With
            // manual commit, the user decides (the tab shows a failed transaction and offers Roll back).
            if (inTransaction && options.session && !manual) {
              await entry.driver.execute(entry.driver.dialect.rollback, { session: options.session }).catch(() => {})
              outcomes.push({ sql: entry.driver.dialect.rollback, start: statement.end, end: statement.end, results: [], durationMs: 0, note: 'The transaction was rolled back: no changes were saved.' })
            }
            break
          }
        }
      }
    } finally {
      if (temporary) await entry.driver.releaseSession(temporary).catch(() => {})
      if (runningKey) {
        const n = (this.running.get(runningKey) ?? 1) - 1
        if (n > 0) this.running.set(runningKey, n)
        else this.running.delete(runningKey)
      }
    }
    if (/^\s*(CREATE|ALTER|DROP|RENAME)\b/im.test(script)) {
      // DDL changes the schema; drop the cache so the explorer refreshes lazily.
      entry.schema = undefined
    }
    return outcomes
  }

  /**
   * SQL nobody confirmed (AI chat, MCP agents, read-only connections). Every layer stands on its own:
   * 1. sql-lexer.ts reads every character as the server does or the script is refused, and sql-readonly.ts allows
   *    only what reads (an allowlist of what may start a statement, words that never belong in a read).
   * 2. The server's own truth, per engine (the table below): one statement per call where the protocol allows,
   *    inside a read-only transaction that is always rolled back, and SQL Server's own plan of every batch.
   * 3. After every statement the transaction must still be ours (the protocol's or the server's state): if it is
   *    gone, nothing further runs and the outcome says the guard was broken.
   *
   * | engine        | one statement per call                 | read-only on the server                  | checked after each statement |
   * |---------------|----------------------------------------|------------------------------------------|------------------------------|
   * | PostgreSQL    | extended protocol (Parse/Bind/Execute) | BEGIN TRANSACTION READ ONLY, rolled back | protocol transaction status  |
   * | MySQL/MariaDB | multipleStatements off (asserted)      | START TRANSACTION READ ONLY, rolled back | SERVER_STATUS_IN_TRANS       |
   * | SQL Server    | no (a batch is many): SHOWPLAN_XML of  | BEGIN TRANSACTION, rolled back           | @@TRANCOUNT / XACT_STATE()   |
   * |               | the batch must list only reads         |                                          |                              |
   * | Oracle        | yes (one statement per execute)        | SET TRANSACTION READ ONLY, rolled back   | none (a SELECT can't end it) |
   * | SQLite        | yes (prepare runs the first only)      | PRAGMA query_only = 1 for the statement  | no transaction (one shared connection) |
   * | DuckDB        | extractStatements must count one, of   | BEGIN TRANSACTION READ ONLY, rolled back | txid probe                   |
   * |               | type SELECT or EXPLAIN                 |                                          |                              |
   * | ClickHouse    | yes (one query per HTTP request)       | readonly = 2 on every query              | no transactions              |
   * | BigQuery      | a dry run must say SELECT (no scripts) | the dry run's SELECT                     | no transactions              |
   * | Trino         | yes (one statement per request)        | none: the lexer and allowlist only       | no transactions              |
   */
  private async runUnconfirmed(entry: OpenConnection, script: string, options: RunScriptOptions, profile: ReadProfile): Promise<StatementOutcome[]> {
    const driver = entry.config.driver
    // SQL Server: a run nobody confirmed reuses one session of its own per connection, one run at a time (opening a
    // connection per run was most of its cost); everything there is rolled back and nothing else can be left behind.
    if (driver === 'mssql' && !options.session && profile === 'agent') {
      const key = entry.config.id
      const previous = this.mssqlShared.get(key) ?? Promise.resolve()
      let done: () => void = () => {}
      const mine = new Promise<void>((r) => (done = r))
      this.mssqlShared.set(key, previous.then(() => mine))
      await previous
      try {
        return await this.runGuarded(entry, script, { ...options, session: `readonly-shared-${key}` }, profile, false)
      } finally {
        done()
      }
    }
    return this.runGuarded(entry, script, options, profile, !options.session)
  }

  private mssqlShared = new Map<string, Promise<void>>()

  private async runGuarded(entry: OpenConnection, script: string, options: RunScriptOptions, profile: ReadProfile, own: boolean): Promise<StatementOutcome[]> {
    const driver = entry.config.driver
    const dialect = entry.driver.dialect
    const session = options.session ?? `readonly-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const outcomes: StatementOutcome[] = []
    let inTransaction = false
    let usedTransaction = false
    const broken = (sql: string, at: number) => {
      const error = new GuardBrokenError()
      console.error(`[dbm] ${error.message} (${driver})`)
      outcomes.push({ sql, start: at, end: at, error: describeError(error), durationMs: 0 })
    }
    // The read-only transaction, with a time limit where the session has none (pg_sleep and friends).
    const begin = async () => {
      // (DuckDB's guarded runs are on an instance of their own, opened read-only: see DuckDBDriver.guardedInstance.)
      if (!dialect.beginReadOnly || driver === 'duckdb') return
      const sql =
        driver === 'postgres'
          ? `${dialect.beginReadOnly}; ${PG_GUARD_SETTINGS}`
          : driver === 'mssql' && (own || session.startsWith('readonly-shared-'))
            ? `SET LOCK_TIMEOUT ${READ_LOCK_TIMEOUT_MS}; ${dialect.beginReadOnly}`
            : dialect.beginReadOnly
      await entry.driver.execute(sql, { session })
      inTransaction = true
      usedTransaction = true
    }
    const end = async () => {
      if (!inTransaction) return
      inTransaction = false
      // SQL Server: the transaction must still be there to be rolled back (asked and rolled back in one round trip).
      if (driver === 'mssql') {
        const [r] = await entry.driver.execute('SELECT @@TRANCOUNT AS n; IF @@TRANCOUNT > 0 ROLLBACK', { session }).catch(() => [])
        if (r && Number(r.rows[0]?.[0] ?? 0) === 0 && !outcomes.some((o) => o.error?.message.includes('guard was broken'))) broken(script, script.length)
        return
      }
      await entry.driver.execute(dialect.rollback, { session }).catch(() => {})
    }
    // SQL Server has no statement time limit of its own: a guarded batch is cancelled after the same 60 s as the other
    // engines' limit, unless the connection has a request timeout of its own. (Cancelling is safe: what runs here
    // reads, or writes #temp tables only, and is rolled back.)
    const ownTimeout = Number((entry.config.options as { requestTimeout?: unknown } | undefined)?.requestTimeout ?? 0)
    const limit = driver === 'mssql' && !ownTimeout ? AbortSignal.timeout(appUnconfirmedTimeoutMs()) : undefined
    const signal = limit ? (options.signal ? AbortSignal.any([options.signal, limit]) : limit) : options.signal
    try {
      // MySQL's sql_mode decides how its strings read (backslashes, double quotes): asked of this session.
      let modes: LexModes = {}
      if (driver === 'mysql' || driver === 'mariadb') {
        const [r] = await entry.driver.execute('SELECT @@SESSION.sql_mode, VERSION()', { session })
        const mode = String(r?.rows[0]?.[0] ?? '')
        modes = { ansiQuotes: /ANSI_QUOTES/i.test(mode), noBackslashEscapes: /NO_BACKSLASH_ESCAPES/i.test(mode) }
        // A time limit where there is none (a connection of its own is closed afterwards: the limit goes with it).
        // MariaDB calls it max_statement_time, in seconds; MySQL max_execution_time, in milliseconds (SELECTs only).
        if (own) {
          const mariadb = /mariadb/i.test(String(r?.rows[0]?.[1] ?? ''))
          const name = mariadb ? 'max_statement_time' : 'max_execution_time'
          const [limit] = await entry.driver.execute(`SELECT @@SESSION.${name}`, { session })
          if (Number(limit?.rows[0]?.[0] ?? 0) === 0) await entry.driver.execute(`SET SESSION ${name} = ${mariadb ? UNCONFIRMED_TIMEOUT_MS / 1000 : UNCONFIRMED_TIMEOUT_MS}`, { session })
        }
      }
      const verdict = readVerdict(script, driver, { modes, profile })
      if (!verdict.ok) throw new ReadOnlyViolationError(verdict.reason)
      if (driver === 'mssql') for (const s of verdict.statements) await this.mssqlReadsOnly(entry, session, s.text, verdict.statements.length === 1 ? options.params : undefined, profile)
      // Oracle's read-only transaction has no id to ask about; ClickHouse, BigQuery and Trino have none.
      const trackable = !!entry.driver.transactionState && driver !== 'oracle'
      for (const s of verdict.statements) {
        const started = Date.now()
        // A PostgreSQL SET or RESET of the user profile lasts on the session: it runs outside the read-only
        // transaction (inside one it would be rolled back with it), one statement on the extended protocol as well.
        if (s.session) await end()
        else if (!inTransaction) await begin()
        // (Right after BEGIN the transaction is there; it is asked about after the statement.)
        const tracked = inTransaction && trackable
        let text = s.text
        let params = verdict.statements.length === 1 ? options.params : undefined
        if (options.parameterValues && extractParameters(text, driver).length) {
          const bound = bindParameters(text, driver, dialect, options.parameterValues)
          text = bound.sql
          params = bound.params
        }
        let failed = false
        try {
          const results = await entry.driver.execute(text, { session, maxRows: options.maxRows, signal, params, unconfirmed: true })
          const messages = results.flatMap((r) => r.messages ?? [])
          outcomes.push({ sql: s.text, start: s.start, end: s.end, results: results.filter((r) => !r.messagesOnly), durationMs: Date.now() - started, ...(messages.length ? { messages } : {}) })
        } catch (err) {
          failed = true
          const timedOut = limit?.aborted && !options.signal?.aborted
          outcomes.push({ sql: s.text, start: s.start, end: s.end, error: timedOut ? { message: `Stopped after ${Math.round(appUnconfirmedTimeoutMs() / 1000)} s: SQL nobody confirmed has a time limit here.` } : describeError(err), durationMs: Date.now() - started })
        }
        // (SQL Server's last batch is checked as it is rolled back, in end().)
        const last = s === verdict.statements.at(-1)
        if (tracked && !(driver === 'mssql' && last) && (await entry.driver.transactionState!(session)) === 'none') {
          inTransaction = false
          broken(s.text, s.end)
          break
        }
        if (failed && (!options.continueOnError || options.signal?.aborted)) break
      }
      return outcomes
    } finally {
      await end()
      // Nothing of the run stays behind on a session that goes back to the pool: PostgreSQL forgets settings,
      // advisory locks and prepared statements (DISCARD ALL); MySQL's connection is closed (named locks go with it).
      if (own) {
        if (driver === 'postgres' && usedTransaction) await entry.driver.execute('DISCARD ALL', { session }).catch(() => {})
        await entry.driver.releaseSession(session).catch(() => {})
      }
    }
  }

  /**
   * SQL Server's own reading of a batch, without running it: SHOWPLAN_XML compiles and plans the batch as it will
   * run. Every statement must be one that reads (SELECT, a variable assignment, a condition, PRINT; for the user
   * profile also SET options, USE and writes to #temp tables only); a batch the server can't plan is refused. A login
   * without SHOWPLAN permission gets the tokenizer alone, which then refuses anything unusual. The user profile's
   * batches that make and use a #temp table can't be planned (the table isn't there while planning): the tokenizer
   * has checked that every write in them goes to a #temp table, and the run is rolled back as always.
   */
  private async mssqlReadsOnly(entry: OpenConnection, session: string, batch: string, params: unknown[] | undefined, profile: ReadProfile): Promise<string> {
    const READS = new Set(['SELECT', 'SELECT WITHOUT QUERY', 'ASSIGN', 'COND', 'COND WITH QUERY', 'PRINT', ...(profile === 'user' ? ['SET ON/OFF', 'USE DATABASE'] : [])])
    const TEMP_WRITES = new Set(['SELECT INTO', 'INSERT', 'UPDATE', 'DELETE'])
    const tokensOnly = () => {
      const lexed = lex(batch, 'mssql')
      const unusual = !lexed.ok || lexed.tokens.some((t) => t.kind === 'comment' || ((t.kind === 'ident' || t.kind === 'string') && /['"[\]]|--|\/\*/.test(t.value ?? '')))
      if (unusual) throw new ReadOnlyViolationError('This login may not ask SQL Server for a plan (SHOWPLAN permission), so only plain batches without comments, and without quotes or comment marks inside names and strings, are allowed here. Grant SHOWPLAN to the login to lift this.')
      return ''
    }
    const noPermission = (err: unknown) => /SHOWPLAN permission/i.test((err as Error)?.message ?? '')
    try {
      await entry.driver.execute('SET SHOWPLAN_XML ON', { session })
    } catch (err) {
      if (noPermission(err)) return tokensOnly()
      throw err
    }
    let plans: QueryResult[]
    try {
      plans = await entry.driver.execute(batch, { session, params })
    } catch (err) {
      // (The permission is checked when a statement is planned, not when SHOWPLAN is turned on.)
      if (noPermission(err)) return tokensOnly()
      if (profile === 'user' && /Invalid object name '#/i.test((err as Error)?.message ?? '')) return ''
      throw new ReadOnlyViolationError(`SQL Server could not plan this batch, so it is not run: ${(err as Error).message}`)
    } finally {
      await entry.driver.execute('SET SHOWPLAN_XML OFF', { session }).catch(() => {})
    }
    const xml = plans.map((r) => String(r.rows?.[0]?.[0] ?? '')).join('\n')
    const statements = [...xml.matchAll(/<(Stmt\w+)[^>]*?StatementType="([^"]+)"[\s\S]*?(?=<Stmt\w+[^>]*?StatementType=|$)/g)]
    if (!statements.length) throw new ReadOnlyViolationError('SQL Server gave no plan for this batch, so it is not run.')
    for (const [whole, , type] of statements) {
      if (READS.has(type!)) continue
      // A write the user profile may do: every object it touches a #temp table.
      const objects = [...whole.matchAll(/<Object [^>]*?Table="([^"]+)"/g)].map((m) => m[1]!)
      // (Local #temp only: a ##global one is shared with other sessions.)
      if (profile === 'user' && TEMP_WRITES.has(type!) && objects.length && objects.every((o) => /^\[#[^#]/.test(o))) continue
      throw new ReadOnlyViolationError(profile === 'user' ? `This connection is read-only: SQL Server plans this batch with ${type}, which can't be run here. Open the connection's settings to allow writes.` : `Only reads are allowed here (read-only): SQL Server plans this batch with ${type}.`)
    }
    return xml
  }

  /**
   * SQL Server's plan of a batch nobody confirmed, without running it (an agent's explain): the guard's verdict, then
   * the same SHOWPLAN_XML call the guard makes, on a session of its own. Refused where the login may not plan.
   */
  async planUnconfirmed(id: string, sql: string): Promise<string> {
    const entry = this.get(id)
    if (entry.config.driver !== 'mssql') throw new Error('Only SQL Server plans this way')
    const verdict = readVerdict(sql, 'mssql', { profile: 'agent' })
    if (!verdict.ok) throw new ReadOnlyViolationError(verdict.reason)
    if (verdict.statements.length !== 1) throw new ReadOnlyViolationError('Explain one batch at a time.')
    const session = `readonly-plan-${Date.now()}-${Math.random().toString(36).slice(2)}`
    try {
      const xml = await this.mssqlReadsOnly(entry, session, verdict.statements[0]!.text, undefined, 'agent')
      if (!xml) throw new ReadOnlyViolationError('This login may not ask SQL Server for a plan (SHOWPLAN permission). Grant SHOWPLAN to the login to explain queries here.')
      return xml
    } finally {
      await entry.driver.releaseSession(session).catch(() => {})
    }
  }

  /**
   * Rows of one statement in batches, holding one batch at a time (exports of any size). `readOnly` (SQL nobody
   * confirmed) and every read-only connection stream through the guard (streamGuarded), as runScript runs them;
   * drivers without streaming fall back to a normal execute.
   */
  async *streamQuery(id: string, sql: string, options: Omit<StreamOptions, 'session' | 'unconfirmed'> & { readOnly?: boolean } = {}): AsyncGenerator<StreamBatch> {
    const entry = this.get(id)
    if (options.readOnly || (entry.config.readOnly && options.readOnly === undefined)) {
      yield* this.streamGuarded(entry, sql, options, options.readOnly ? 'agent' : 'user')
      return
    }
    if (entry.driver.stream) {
      yield* entry.driver.stream(sql, options)
      return
    }
    const [r] = await entry.driver.execute(sql, { params: options.params, signal: options.signal })
    if (r?.fields.length) yield { fields: r.fields, rows: r.rows }
  }

  /**
   * One read nobody confirmed, streamed with the guarantees of runGuarded: the same verdict (one statement, the
   * allowlist, refused names; SQL Server's plan of the batch), the read-only transaction on a session of its own
   * whose state is checked before the first row and after the last, and the driver's own server-side guard
   * (StreamOptions.unconfirmed). The time limit is on the first batch (60 s, the app's own timer): an export of
   * millions of rows may take longer than any one query should, but a query that sits before its first row is
   * stopped. Every engine streams this way; a session statement (the user profile's SET or USE) can't be streamed.
   */
  private async *streamGuarded(entry: OpenConnection, sql: string, options: StreamOptions, profile: ReadProfile): AsyncGenerator<StreamBatch> {
    const driver = entry.config.driver
    const dialect = entry.driver.dialect
    if (!entry.driver.stream) throw new ReadOnlyViolationError(`${driver} can't stream SQL nobody confirmed.`)
    const session = `readonly-stream-${Date.now()}-${Math.random().toString(36).slice(2)}`
    let inTransaction = false
    let completed = false
    try {
      let modes: LexModes = {}
      if (driver === 'mysql' || driver === 'mariadb') {
        const [r] = await entry.driver.execute('SELECT @@SESSION.sql_mode', { session })
        const mode = String(r?.rows[0]?.[0] ?? '')
        modes = { ansiQuotes: /ANSI_QUOTES/i.test(mode), noBackslashEscapes: /NO_BACKSLASH_ESCAPES/i.test(mode) }
      }
      const verdict = readVerdict(sql, driver, { modes, profile })
      if (!verdict.ok) throw new ReadOnlyViolationError(verdict.reason)
      const only = verdict.statements[0]!
      if (verdict.statements.length !== 1 || only.session) throw new ReadOnlyViolationError('Only one read can be streamed here: run session statements and scripts in the SQL editor.')
      if (driver === 'mssql') await this.mssqlReadsOnly(entry, session, only.text, options.params, profile)
      if (dialect.beginReadOnly && driver !== 'duckdb') {
        await entry.driver.execute(
          driver === 'mssql' ? `SET LOCK_TIMEOUT ${READ_LOCK_TIMEOUT_MS}; ${dialect.beginReadOnly}` : driver === 'postgres' ? `${dialect.beginReadOnly}; ${PG_STANDARD_STRINGS}` : dialect.beginReadOnly,
          { session },
        )
        inTransaction = true
      }
      const trackable = inTransaction && !!entry.driver.transactionState && driver !== 'oracle'
      if (trackable && (await entry.driver.transactionState!(session)) !== 'open') throw new GuardBrokenError()
      const first = new AbortController()
      const timer = setTimeout(() => first.abort(), appUnconfirmedTimeoutMs())
      const signal = options.signal ? AbortSignal.any([options.signal, first.signal]) : first.signal
      try {
        for await (const batch of entry.driver.stream(only.text, { ...options, signal, session, unconfirmed: true })) {
          clearTimeout(timer)
          yield batch
        }
      } catch (err) {
        if (first.signal.aborted && !options.signal?.aborted) throw new Error(`Stopped: no row came within ${Math.round(appUnconfirmedTimeoutMs() / 1000)} s (SQL nobody confirmed has a time limit for its first rows).`)
        throw err
      } finally {
        clearTimeout(timer)
      }
      if (trackable && (await entry.driver.transactionState!(session)) !== 'open') throw new GuardBrokenError()
      completed = true
    } finally {
      // (MySQL: a stream stopped early closed its connection, and the transaction with it.)
      if (inTransaction && (completed || (driver !== 'mysql' && driver !== 'mariadb'))) {
        await entry.driver.execute(driver === 'mssql' ? 'IF @@TRANCOUNT > 0 ROLLBACK' : dialect.rollback, { session }).catch(() => {})
      }
      if (driver === 'postgres' && inTransaction) await entry.driver.execute('DISCARD ALL', { session }).catch(() => {})
      await entry.driver.releaseSession(session).catch(() => {})
    }
  }

  /** Files the user handed to a DuckDB connection ("Query a file"): SQL nobody confirmed may read them too. */
  allowFiles(id: string, paths: string[]): void {
    const kept = this.allowedFiles.get(id) ?? new Set<string>()
    for (const p of paths) kept.add(p)
    this.allowedFiles.set(id, kept)
    const driver = this.open.get(id)?.driver as { allowFile?: (path: string) => void } | undefined
    for (const p of kept) driver?.allowFile?.(p)
  }

  /** (Kept across reconnects: the connection may open after the file was handed to it.) */
  private allowedFiles = new Map<string, Set<string>>()

  /** The session's transaction as the database sees it; undefined where the database has no transactions to manage. */
  async transactionState(id: string, session: string): Promise<TransactionState | undefined> {
    const driver = this.open.get(id)?.driver
    if (!driver?.transactionState) return undefined
    return driver.transactionState(session)
  }

  /** Server session ids of this app's open sessions (query tabs), by session key. */
  serverSessionIds(id: string): Record<string, string> {
    return this.open.get(id)?.driver.serverSessionIds?.() ?? {}
  }

  /** Commits or rolls back the session's open transaction (the editor's Commit / Roll back buttons). */
  endTransaction(id: string, session: string, action: 'commit' | 'rollback'): Promise<TransactionState | undefined> {
    return this.serialized(id, session, () => this.endTransactionNow(id, session, action))
  }

  private async endTransactionNow(id: string, session: string, action: 'commit' | 'rollback'): Promise<TransactionState | undefined> {
    const entry = this.get(id)
    const sql = action === 'commit' ? entry.driver.dialect.commit : entry.driver.dialect.rollback
    if (!sql) return undefined
    // COMMIT would also commit a statement still running in this session (it queues behind it).
    if (this.running.has(`${id}\u0000${session}`)) throw new Error('A statement is still running in this tab: wait for it (or cancel it) before Commit or Roll back.')
    if (action === 'commit') {
      const state = await this.transactionState(id, session)
      // PostgreSQL answers COMMIT in a failed transaction with ROLLBACK and no error: never report that as saved.
      if (state === 'failed') throw new Error('The transaction failed, so it can only be rolled back: nothing was committed.')
      if (state === 'none') throw new Error('This tab has no open transaction any more (it ended on the server, e.g. after a lost connection): nothing to commit.')
    }
    try {
      const [result] = await entry.driver.execute(sql, { session })
      if (action === 'commit' && result?.command?.toUpperCase() === 'ROLLBACK') throw new Error('The database rolled the transaction back instead of committing it: nothing was saved.')
    } finally {
      // DDL inside the transaction may have been undone (or made permanent): the explorer reloads lazily.
      entry.schema = undefined
    }
    return this.transactionState(id, session)
  }

  async releaseSession(id: string, session: string): Promise<void> {
    this.open.get(id)?.editorSessions?.delete(session)
    await this.open.get(id)?.driver.releaseSession(session)
  }

  async fetchTable(id: string, options: FetchTableOptions): Promise<TablePage> {
    const entry = this.get(id)
    this.assertFilterReads(entry, options.filter)
    const table = await this.findTable(id, options.table)
    // Without a chosen order, rows come back in storage order: an edited row jumps away after saving, and pages
    // (LIMIT/OFFSET) can overlap or skip rows. The primary key gives a stable order.
    const sort = options.sort?.length ? options.sort : table?.primaryKey.length ? table.primaryKey.map((column) => ({ column, direction: 'asc' as const })) : options.sort
    const built = buildSelect(
      {
        table: options.table,
        filter: options.filter,
        sort,
        limit: options.limit,
        offset: options.offset,
        knownColumns: table?.columns.map((c) => c.name),
        columnTypes: table && Object.fromEntries(table.columns.map((c) => [c.name, c.dataType])),
      },
      entry.driver.dialect,
    )
    const [result] = await this.readIn(id, entry, this.readSession(entry, options.session), built.sql, built.params, options.signal, hasRawFilter(options.filter))
    if (!result) throw new Error('Query returned no result')
    return { result, sql: built.sql }
  }

  /** A table tab reads on its own session once it has written there (it sees its uncommitted rows). */
  private readSession(entry: OpenConnection, session: string | undefined): string | undefined {
    return session && entry.editorSessions?.has(session) ? session : undefined
  }

  /**
   * A read on a tab's session. On PostgreSQL inside an open transaction it runs behind a savepoint: a failing or
   * cancelled read (a typo in a filter, a page changed quickly) must not abort the tab's pending changes.
   */
  private async readIn(id: string, entry: OpenConnection, session: string | undefined, sql: string, params: unknown[], signal?: AbortSignal, rawFilter = false): Promise<QueryResult[]> {
    // A filter's own SQL nobody confirmed: one statement on the server's word (PostgreSQL's extended protocol), and
    // SQL Server plans the query first, which must be a read.
    if (rawFilter) {
      if (entry.config.driver === 'mssql') {
        const probe = `rawfilter-${Date.now()}-${Math.random().toString(36).slice(2)}`
        try {
          await this.mssqlReadsOnly(entry, probe, sql, params, 'agent')
        } finally {
          await entry.driver.releaseSession(probe).catch(() => {})
        }
      }
    }
    const unconfirmed = rawFilter || undefined
    if (!session) return entry.driver.execute(sql, { params, signal, unconfirmed })
    if (entry.config.driver === 'duckdb' && (await this.transactionState(id, session)) === 'open') {
      // DuckDB has no savepoints, and any error or interrupt aborts the whole transaction. The read is tried first on
      // a connection of its own (committed rows; it may be cancelled there), and only then run on the session, in
      // line with saves and never interrupted.
      // (A table only the transaction has created is not there yet: a catalog error doesn't abort a transaction.)
      await entry.driver.execute(sql, { params, signal, unconfirmed }).catch((err: unknown) => {
        if (signal?.aborted || !/^Catalog Error/.test((err as Error)?.message ?? '')) throw err
      })
      return this.serialized(id, session, () => entry.driver.execute(sql, { params, session, unconfirmed }))
    }
    const guarded = entry.config.driver === 'postgres' && entry.serverInfo?.product === 'PostgreSQL' && (await this.transactionState(id, session)) === 'open'
    if (!guarded) return entry.driver.execute(sql, { params, signal, session, unconfirmed })
    // In line with saves and Commit on this session, and not cancelled (a cancel hits the session's process, which
    // could land on a save's statement): a stale read just finishes and its result is dropped.
    return this.serialized(id, session, () => this.guardedRead(entry, session, sql, params, unconfirmed))
  }

  private async guardedRead(entry: OpenConnection, session: string, sql: string, params: unknown[], unconfirmed?: boolean): Promise<QueryResult[]> {
    await entry.driver.execute('SAVEPOINT dbm_read', { session })
    try {
      const results = await entry.driver.execute(sql, { params, session, unconfirmed })
      await entry.driver.execute('RELEASE SAVEPOINT dbm_read', { session }).catch(() => {})
      return results
    } catch (err) {
      await entry.driver.execute('ROLLBACK TO SAVEPOINT dbm_read', { session }).catch(() => {})
      await entry.driver.execute('RELEASE SAVEPOINT dbm_read', { session }).catch(() => {})
      throw err
    }
  }

  async countTable(id: string, options: Pick<FetchTableOptions, 'table' | 'filter' | 'signal' | 'session'>): Promise<number> {
    const entry = this.get(id)
    this.assertFilterReads(entry, options.filter)
    const table = await this.findTable(id, options.table)
    const built = buildCount(
      { table: options.table, filter: options.filter, knownColumns: table?.columns.map((c) => c.name), columnTypes: table && Object.fromEntries(table.columns.map((c) => [c.name, c.dataType])) },
      entry.driver.dialect,
    )
    const [result] = await this.readIn(id, entry, this.readSession(entry, options.session), built.sql, built.params, options.signal, hasRawFilter(options.filter))
    return Number(result?.rows[0]?.[0] ?? 0)
  }

  /**
   * A column's profile with the table tab's filter: rows, NULLs, distinct values, min / max and the most common
   * values. A part the database can't compute for the type (MIN of a PostgreSQL boolean, DISTINCT of json) is left out.
   */
  async profileColumn(id: string, options: Pick<FetchTableOptions, 'table' | 'filter' | 'signal' | 'session'> & { column: string }): Promise<ColumnProfile> {
    const entry = this.get(id)
    this.assertFilterReads(entry, options.filter)
    const table = await this.findTable(id, options.table)
    const q = profileQueries(options.table, options.column, options.filter, entry.driver.dialect, table)
    const session = this.readSession(entry, options.session)
    const read = async (query: BuiltQuery) => (await this.readIn(id, entry, session, query.sql, query.params, options.signal, hasRawFilter(options.filter)))[0]
    const optional = async (query: BuiltQuery) => {
      try {
        return await read(query)
      } catch (err) {
        if (options.signal?.aborted) throw err
        return undefined
      }
    }
    const counts = await read(q.counts)
    const [distinct, range, top] = [await optional(q.distinct), await optional(q.range), await optional(q.top)]
    const row = counts?.rows[0] ?? []
    return {
      total: Number(row[0] ?? 0),
      filled: Number(row[1] ?? 0),
      ...(distinct?.rows[0] ? { distinct: Number(distinct.rows[0][0] ?? 0) } : {}),
      ...(range?.rows[0] ? { min: range.rows[0][0] ?? null, max: range.rows[0][1] ?? null } : {}),
      top: (top?.rows ?? []).map((r) => ({ value: r[0] ?? null, count: Number(r[1] ?? 0) })),
    }
  }

  /**
   * Saves grid edits. With manual commit and the table tab's `session`, they go into that tab's transaction (opened if
   * needed) and wait for Commit / Roll back; otherwise they commit at once, all or nothing.
   */
  async applyChanges(id: string, table: TableRef, changes: RowChange[], options: { session?: string } = {}): Promise<number[]> {
    const entry = this.get(id)
    if (entry.config.readOnly) throw new ReadOnlyViolationError()
    const statements = buildChangeStatements(table, changes, entry.driver.dialect)
    // Manual commit, or a transaction this tab still has open (manual commit was turned off meanwhile).
    const inTabTransaction =
      !!options.session && !!entry.driver.transactionState && !!entry.driver.dialect.begin &&
      (!!entry.config.manualCommit || (!!entry.editorSessions?.has(options.session) && (await this.transactionState(id, options.session)) !== 'none'))
    if (inTabTransaction) return this.applyInTransaction(id, entry, options.session!, statements)
    try {
      // A row a query tab changed in its open transaction stays locked until Commit / Roll back: say so, don't hang.
      return await entry.driver.transaction(statements, this.lockTimeoutApplies(entry) ? { lockTimeoutMs: GRID_LOCK_TIMEOUT_MS } : {})
    } catch (err) {
      if (!isLockTimeout(err)) throw err
      const tabs = await this.openEditorTransactions(id)
      throw new RowLockedError(
        tabs.length
          ? 'The rows are locked by an open transaction in a query tab. Commit or roll it back there, then save again.'
          : 'The rows are locked by another session’s open transaction. Save again once it ends (Server activity shows who holds them).',
      )
    }
  }

  /** Work on one session's transaction that must not interleave with another (two saves, a save and Commit). */
  private sessionQueue = new Map<string, Promise<unknown>>()
  private serialized<T>(id: string, session: string, work: () => Promise<T>): Promise<T> {
    const key = `${id}\u0000${session}`
    const run = (this.sessionQueue.get(key) ?? Promise.resolve()).catch(() => {}).then(work)
    this.sessionQueue.set(key, run)
    void run.finally(() => this.sessionQueue.get(key) === run && this.sessionQueue.delete(key)).catch(() => {})
    return run
  }

  private applyInTransaction(id: string, entry: OpenConnection, session: string, statements: BuiltQuery[]): Promise<number[]> {
    return this.serialized(id, session, () => this.applyInTransactionNow(id, entry, session, statements))
  }

  private async applyInTransactionNow(id: string, entry: OpenConnection, session: string, statements: BuiltQuery[]): Promise<number[]> {
    ;(entry.editorSessions ??= new Set()).add(session)
    const driver = entry.config.driver
    const exec = (sql: string, params?: unknown[]) => entry.driver.execute(sql, { session, params })
    const state = await this.transactionState(id, session)
    if (state === 'failed') throw new Error('The tab’s transaction failed: roll it back first.')
    if (state === 'none') await exec(entry.driver.dialect.begin)
    // One save stays all or nothing inside the longer transaction (DuckDB has no savepoints; an error aborts it anyway).
    // (Redshift has no savepoints either.)
    const savepoint = driver === 'duckdb' || entry.serverInfo?.product === 'Redshift' ? undefined : driver === 'mssql' ? ['SAVE TRANSACTION dbm_grid', 'ROLLBACK TRANSACTION dbm_grid'] : ['SAVEPOINT dbm_grid', 'ROLLBACK TO SAVEPOINT dbm_grid']
    const lock = this.lockTimeoutApplies(entry) ? SESSION_LOCK_TIMEOUT[driver] : undefined
    // The user's own lock timeout in this session comes back afterwards (not the server's default).
    const prior = lock ? await exec(lock.read).then((r) => r[0]?.rows[0]?.[0] ?? null, () => null) : null
    if (savepoint) await exec(savepoint[0]!)
    if (lock) await exec(lock.set).catch(() => {})
    try {
      const affected: number[] = []
      for (const s of statements) {
        const rows = driver === 'oracle' ? lockRowsFirst(s, GRID_LOCK_TIMEOUT_MS / 1000) : undefined
        if (rows) await exec(rows.sql, rows.params)
        const [r] = await exec(s.sql, s.params)
        affected.push(checkAffected(s, r?.affectedRows ?? r?.rowCount ?? 0))
      }
      return affected
    } catch (err) {
      if (savepoint) await exec(savepoint[1]!).catch(() => {})
      // DuckDB and Redshift have no savepoint to undo the rows just changed: a failing statement aborts the tab's
      // transaction, so they can't be committed; only Roll back ends it.
      if (!savepoint && err instanceof TooManyRowsError) {
        await exec(driver === 'duckdb' ? "SELECT error('several rows changed')" : 'SELECT 1 / 0').catch(() => {})
        throw new TooManyRowsError(err.rows, 'Roll back the tab’s transaction: it can no longer be committed.')
      }
      if (!isLockTimeout(err)) throw err
      const others = (await this.openEditorTransactions(id)).filter((s) => s !== session)
      throw new RowLockedError(
        others.length
          ? 'The rows are locked by an open transaction in a query tab. Commit or roll it back there, then save again.'
          : 'The rows are locked by another session’s open transaction. Save again once it ends (Server activity shows who holds them).',
      )
    } finally {
      if (lock && prior !== null) await exec(lock.restore(String(prior))).catch(() => {})
    }
  }

  /** lock_timeout is PostgreSQL's own: CockroachDB versions and Redshift (same protocol) may reject it. */
  private lockTimeoutApplies(entry: OpenConnection): boolean {
    return entry.config.driver !== 'postgres' || entry.serverInfo?.product === 'PostgreSQL'
  }

  /** Statements still running per session: Commit must not slip in behind one. */
  private running = new Map<string, number>()

  /** Sessions (query tabs) of this connection with a transaction open. */
  async openEditorTransactions(id: string): Promise<string[]> {
    const out: string[] = []
    for (const session of this.open.get(id)?.editorSessions ?? []) {
      // A session busy with a statement (waiting on a lock itself) can't answer: don't wait for it.
      const state = await Promise.race([this.transactionState(id, session).catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), 1000))])
      if (state === 'open' || state === 'failed') out.push(session)
    }
    return out
  }

  /** Runs prepared statements atomically (imports). Read-only connections refuse. */
  async transactionRaw(id: string, statements: BuiltQuery[]): Promise<number[]> {
    const entry = this.get(id)
    if (entry.config.readOnly) throw new ReadOnlyViolationError()
    return entry.driver.transaction(statements)
  }

  /**
   * Runs batches of statements in one transaction on a session of its own (an import that streams its rows): the next
   * batch is pulled only after the previous one ran, so one batch is held in memory. An error or an abort rolls
   * everything back. Returns the rows the statements reported.
   */
  async transactionBatches(id: string, batches: AsyncIterable<BuiltQuery[]>, options: { signal?: AbortSignal } = {}): Promise<number> {
    const entry = this.get(id)
    if (entry.config.readOnly) throw new ReadOnlyViolationError()
    const { driver } = entry
    const session = `import-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const aborted = () => {
      if (options.signal?.aborted) throw new QueryCancelledError()
    }
    let rows = 0
    try {
      aborted()
      // (ClickHouse has no transactions: its dialect's begin and commit are empty.)
      if (driver.dialect.begin) await driver.execute(driver.dialect.begin, { session })
      for await (const batch of batches) {
        aborted()
        for (const q of batch) {
          const results = await driver.execute(q.sql, { params: q.params, session, signal: options.signal })
          rows += results.reduce((n, r) => n + (r.affectedRows ?? 0), 0)
        }
      }
      aborted()
      if (driver.dialect.commit) await driver.execute(driver.dialect.commit, { session })
      return rows
    } catch (err) {
      if (driver.dialect.rollback) await driver.execute(driver.dialect.rollback, { session }).catch(() => {})
      throw err
    } finally {
      await driver.releaseSession(session).catch(() => {})
    }
  }

  qualifiedName(id: string, ref: TableRef): string {
    return qualify(this.get(id).driver.dialect, ref)
  }
}

/**
 * Adds relationships documented in the knowledge base (front matter `relations:`) as virtual foreign keys,
 * so diagrams, FK navigation and the AI see joins the database itself doesn't declare.
 */
export async function withDocumentedRelations(snapshot: SchemaSnapshot, config: ConnectionConfig): Promise<SchemaSnapshot> {
  if (!config.knowledgeBasePath) return snapshot
  let relations
  try {
    relations = await new KnowledgeBase(config.knowledgeBasePath).relations()
  } catch {
    return snapshot
  }
  for (const relation of relations) {
    const { table: fromName, fk } = relationToForeignKey(relation)
    const parts = fromName.split('.')
    const from = findTable(snapshot, parts.length > 1 ? { schema: parts.slice(0, -1).join('.'), name: parts.at(-1)! } : { name: fromName })
    if (!from) continue
    const target = findTable(snapshot, { schema: fk.refSchema, name: fk.refTable })
    if (!target) continue
    fk.refSchema = target.schema
    fk.refTable = target.name
    const duplicate = from.foreignKeys.some(
      (existing) => existing.refTable === fk.refTable && existing.columns.join() === fk.columns.join(),
    )
    if (!duplicate && fk.columns.every((c) => from.columns.some((col) => col.name === c))) from.foreignKeys.push(fk)
  }
  return snapshot
}

import { checkCondition } from './ddl.js'
import { qualify } from './dialect.js'
import { isLockTimeout, ReadOnlyViolationError, RowLockedError, type DatabaseDriver, type StreamBatch, type StreamOptions } from './driver.js'
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
import { classifyStatement, fitsReadOnlyTransaction, isReadOnlyCondition, isReadOnlyScript, opensTransaction, splitStatements, stripLiterals } from './sql-split.js'
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
    await driver.connect()
    const entry: OpenConnection = { config, driver }
    this.open.set(config.id, entry)
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
    // ApplicationIntent=ReadOnly only binds on read replicas, and T-SQL needs no semicolons (`SELECT 1 DELETE …`):
    // a read-only SQL Server connection also runs everything in a transaction that is rolled back.
    // (`readOnly: false` is the guarded inner run.)
    if (entry.config.readOnly && entry.config.driver === 'mssql' && options.readOnly === undefined) {
      // Same per-statement error as other read-only connections, without running any of the script.
      if (!fitsReadOnlyTransaction(script, entry.config.driver)) return [{ sql: script, start: 0, end: script.length, error: describeError(new ReadOnlyViolationError()), durationMs: 0 }]
      options = { ...options, readOnly: true }
    }
    if (options.readOnly) {
      if (!fitsReadOnlyTransaction(script, entry.config.driver)) throw new ReadOnlyViolationError('Only reads are allowed here (no writes, DDL, transaction control or procedure calls).')
      const begin = entry.driver.dialect.beginReadOnly
      if (!begin) return this.runScript(id, script, { ...options, readOnly: false })
      const session = options.session ?? `readonly-${Date.now()}-${Math.random().toString(36).slice(2)}`
      try {
        // SQL Server reads wait for locked rows (an AI chat's own uncommitted write): give up after a while instead.
        if (entry.config.driver === 'mssql' && !options.session) await entry.driver.execute(`SET LOCK_TIMEOUT ${READ_LOCK_TIMEOUT_MS}`, { session }).catch(() => {})
        await entry.driver.execute(begin, { session })
        return await this.runScript(id, script, { ...options, readOnly: false, session })
      } finally {
        await entry.driver.execute(entry.driver.dialect.rollback, { session }).catch(() => {})
        if (!options.session) await entry.driver.releaseSession(session).catch(() => {})
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
          this.assertAllowed(entry, statement.text)
          let text = statement.text
          let params = statements.length === 1 ? options.params : undefined
          if (options.parameterValues && extractParameters(text, entry.config.driver).length) {
            const bound = bindParameters(text, entry.config.driver, entry.driver.dialect, options.parameterValues)
            text = bound.sql
            params = bound.params
          }
          // MySQL, MariaDB and Oracle commit an open transaction before DDL: worth saying, the user expected to decide.
          const watch = editorSession && ['ddl', 'other'].includes(classifyStatement(statement.text)) && !/\b(COMMIT|ROLLBACK|ABORT|PREPARE\s+TRANSACTION)\b/i.test(stripLiterals(statement.text)) ? await this.transactionState(id, editorSession) : undefined
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
          outcomes.push({
            sql: statement.text,
            start: statement.start,
            end: statement.end,
            results,
            durationMs: Date.now() - started,
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
   * Rows of one statement in batches, holding one batch at a time (exports of any size). Read-only connections
   * only allow reads; drivers without streaming fall back to a normal execute.
   */
  async *streamQuery(id: string, sql: string, options: StreamOptions = {}): AsyncGenerator<StreamBatch> {
    const entry = this.get(id)
    this.assertAllowed(entry, sql)
    if (entry.driver.stream) {
      yield* entry.driver.stream(sql, options)
      return
    }
    const [r] = await entry.driver.execute(sql, { params: options.params, signal: options.signal })
    if (r?.fields.length) yield { fields: r.fields, rows: r.rows }
  }

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
    const [result] = await this.readIn(id, entry, this.readSession(entry, options.session), built.sql, built.params, options.signal)
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
  private async readIn(id: string, entry: OpenConnection, session: string | undefined, sql: string, params: unknown[], signal?: AbortSignal): Promise<QueryResult[]> {
    if (!session) return entry.driver.execute(sql, { params, signal })
    const guarded = entry.config.driver === 'postgres' && entry.serverInfo?.product === 'PostgreSQL' && (await this.transactionState(id, session)) === 'open'
    if (!guarded) return entry.driver.execute(sql, { params, signal, session })
    // In line with saves and Commit on this session, and not cancelled (a cancel hits the session's process, which
    // could land on a save's statement): a stale read just finishes and its result is dropped.
    return this.serialized(id, session, () => this.guardedRead(entry, session, sql, params))
  }

  private async guardedRead(entry: OpenConnection, session: string, sql: string, params: unknown[]): Promise<QueryResult[]> {
    await entry.driver.execute('SAVEPOINT dbm_read', { session })
    try {
      const results = await entry.driver.execute(sql, { params, session })
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
    const [result] = await this.readIn(id, entry, this.readSession(entry, options.session), built.sql, built.params, options.signal)
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
    const read = async (query: BuiltQuery) => (await this.readIn(id, entry, session, query.sql, query.params, options.signal))[0]
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
    const savepoint = driver === 'duckdb' ? undefined : driver === 'mssql' ? ['SAVE TRANSACTION dbm_grid', 'ROLLBACK TRANSACTION dbm_grid'] : ['SAVEPOINT dbm_grid', 'ROLLBACK TO SAVEPOINT dbm_grid']
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
        affected.push(r?.affectedRows ?? r?.rowCount ?? 0)
      }
      return affected
    } catch (err) {
      if (savepoint) await exec(savepoint[1]!).catch(() => {})
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

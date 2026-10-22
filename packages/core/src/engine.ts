import { qualify } from './dialect.js'
import { ReadOnlyViolationError, type DatabaseDriver } from './driver.js'
import { MssqlDriver } from './drivers/mssql.js'
import { MysqlDriver } from './drivers/mysql.js'
import { OracleDriver } from './drivers/oracle.js'
import { PostgresDriver } from './drivers/postgres.js'
import { SqliteDriver } from './drivers/sqlite.js'
import { buildCount, buildSelect, type BuiltQuery, type FilterNode, type SortSpec } from './filters.js'
import { buildChangeStatements, type RowChange } from './mutations.js'
import { bindParameters, extractParameters } from './parameters.js'
import { KnowledgeBase, relationToForeignKey } from './knowledge.js'
import { findTable } from './schema-utils.js'
import { classifyStatement, isReadOnlyScript, splitStatements } from './sql-split.js'
import type { ConnectionConfig, SchemaSnapshot, ServerInfo, StatementOutcome, TableInfo, TablePage, TableRef } from './types.js'

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
  }
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
}


export interface FetchTableOptions {
  table: TableRef
  filter?: FilterNode
  sort?: SortSpec[]
  limit: number
  offset?: number
  signal?: AbortSignal
}

/** Describes an error from any driver in a uniform, serializable way. */
export function describeError(err: unknown): { message: string; code?: string; position?: number } {
  if (err instanceof Error) {
    const e = err as Error & { code?: string | number; position?: string; number?: number; originalError?: Error }
    const code = e.code ?? (e.number !== undefined ? String(e.number) : undefined)
    return {
      message: e.message || e.originalError?.message || String(err),
      code: code === undefined ? undefined : String(code),
      position: e.position ? Number(e.position) : undefined,
    }
  }
  return { message: String(err) }
}

interface OpenConnection {
  config: ConnectionConfig
  driver: DatabaseDriver
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

  private assertAllowed(entry: OpenConnection, sql: string) {
    if (entry.config.readOnly && !isReadOnlyScript(sql, entry.config.driver)) throw new ReadOnlyViolationError()
  }

  /** Splits and runs a script statement by statement, collecting per-statement outcomes. */
  async runScript(id: string, script: string, options: RunScriptOptions = {}): Promise<StatementOutcome[]> {
    const entry = this.get(id)
    // T-SQL batches run as a whole (variables and temp tables span statements); only GO splits them.
    const statements = splitStatements(script, entry.config.driver, { batchesOnly: entry.config.driver === 'mssql' })
    const outcomes: StatementOutcome[] = []
    let inTransaction = false
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
        const results = await entry.driver.execute(text, {
          session: options.session,
          maxRows: options.maxRows,
          signal: options.signal,
          params,
        })
        outcomes.push({ sql: statement.text, start: statement.start, end: statement.end, results, durationMs: Date.now() - started })
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
        })
        if (!options.continueOnError || options.signal?.aborted) {
          // A failed script must not leave its transaction open (PostgreSQL would reject everything after).
          if (inTransaction && options.session) {
            await entry.driver.execute(entry.driver.dialect.rollback, { session: options.session }).catch(() => {})
            outcomes.push({ sql: entry.driver.dialect.rollback, start: statement.end, end: statement.end, results: [], durationMs: 0, note: 'The transaction was rolled back: no changes were saved.' })
          }
          break
        }
      }
    }
    if (/^\s*(CREATE|ALTER|DROP|RENAME)\b/im.test(script)) {
      // DDL changes the schema; drop the cache so the explorer refreshes lazily.
      entry.schema = undefined
    }
    return outcomes
  }

  async releaseSession(id: string, session: string): Promise<void> {
    await this.open.get(id)?.driver.releaseSession(session)
  }

  async fetchTable(id: string, options: FetchTableOptions): Promise<TablePage> {
    const entry = this.get(id)
    const table = await this.findTable(id, options.table)
    const built = buildSelect(
      {
        table: options.table,
        filter: options.filter,
        sort: options.sort,
        limit: options.limit,
        offset: options.offset,
        knownColumns: table?.columns.map((c) => c.name),
      },
      entry.driver.dialect,
    )
    const [result] = await entry.driver.execute(built.sql, { params: built.params, signal: options.signal })
    if (!result) throw new Error('Query returned no result')
    return { result, sql: built.sql }
  }

  async countTable(id: string, options: Pick<FetchTableOptions, 'table' | 'filter' | 'signal'>): Promise<number> {
    const entry = this.get(id)
    const table = await this.findTable(id, options.table)
    const built = buildCount(
      { table: options.table, filter: options.filter, knownColumns: table?.columns.map((c) => c.name) },
      entry.driver.dialect,
    )
    const [result] = await entry.driver.execute(built.sql, { params: built.params, signal: options.signal })
    return Number(result?.rows[0]?.[0] ?? 0)
  }

  async applyChanges(id: string, table: TableRef, changes: RowChange[]): Promise<number[]> {
    const entry = this.get(id)
    if (entry.config.readOnly) throw new ReadOnlyViolationError()
    const statements = buildChangeStatements(table, changes, entry.driver.dialect)
    return entry.driver.transaction(statements)
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

import type { BuiltQuery } from './filters.js'
import type { Dialect } from './dialect.js'
import type { ConnectionConfig, QueryOptions, QueryResult, SchemaSnapshot, ServerInfo } from './types.js'

export interface IntrospectOptions {
  /** Limit to these schemas; all non-system schemas when omitted. */
  schemas?: string[]
}

export interface DatabaseDriver {
  readonly config: ConnectionConfig
  readonly dialect: Dialect
  connect(): Promise<void>
  close(): Promise<void>
  /**
   * Executes a single statement (or a T-SQL batch). Returns one result per result set.
   * Rejects with the database error; aborting `signal` cancels the statement server-side.
   */
  execute(sql: string, options?: QueryOptions): Promise<QueryResult[]>
  /** Runs statements atomically, returns affected rows per statement. */
  transaction(statements: BuiltQuery[]): Promise<number[]>
  /** Returns the session's sticky connection to the pool (rolling back anything uncommitted). */
  releaseSession(session: string): Promise<void>
  serverInfo(): Promise<ServerInfo>
  listDatabases(): Promise<string[]>
  introspect(options?: IntrospectOptions): Promise<SchemaSnapshot>
}

export class QueryCancelledError extends Error {
  override name = 'QueryCancelledError'
  constructor() {
    super('Query was cancelled')
  }
}

export class ReadOnlyViolationError extends Error {
  override name = 'ReadOnlyViolationError'
  constructor() {
    super('This connection is read-only. Only SELECT-like statements are allowed.')
  }
}

export function elapsed(start: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10
}

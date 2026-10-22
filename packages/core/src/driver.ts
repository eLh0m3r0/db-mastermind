import type { BuiltQuery } from './filters.js'
import type { Dialect } from './dialect.js'
import { nextTransactionState } from './sql-split.js'
import type { CellValue, ConnectionConfig, QueryOptions, QueryResult, ResultField, SchemaSnapshot, ServerInfo } from './types.js'

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
  /**
   * Reads the first result set of one statement in batches, holding only one batch in memory (exports of any
   * size). Stopping the iteration early cancels the statement.
   */
  stream?(sql: string, options?: StreamOptions): AsyncGenerator<StreamBatch>
}

export interface StreamOptions {
  params?: unknown[]
  signal?: AbortSignal
  /** Rows per batch (drivers with their own chunking may differ). */
  batchSize?: number
}

export interface StreamBatch {
  fields: ResultField[]
  rows: CellValue[][]
}

/** An event-driven row source (callbacks plus flow control) for `batchesFromEvents`. */
export interface EventRowSource {
  start(handlers: { fields(fields: ResultField[]): void; row(row: CellValue[]): void; end(): void; error(err: unknown): void }): void
  pause(): void
  resume(): void
  cancel(): void
}

/** Pull-based batches from a push-based source, pausing it while the consumer is behind. */
export async function* batchesFromEvents(source: EventRowSource, batchSize: number): AsyncGenerator<StreamBatch> {
  let fields: ResultField[] = []
  const queue: CellValue[][] = []
  let done = false
  let failure: unknown
  let paused = false
  let wake: (() => void) | undefined
  const notify = () => {
    const w = wake
    wake = undefined
    w?.()
  }
  source.start({
    fields: (f) => {
      fields = f
    },
    row: (r) => {
      queue.push(r)
      if (queue.length >= batchSize * 2 && !paused) {
        paused = true
        source.pause()
      }
      if (queue.length >= batchSize) notify()
    },
    end: () => {
      done = true
      notify()
    },
    error: (err) => {
      failure = err
      done = true
      notify()
    },
  })
  try {
    for (;;) {
      if (failure) throw failure
      if (queue.length >= batchSize || (done && queue.length)) {
        const rows = queue.splice(0, batchSize)
        if (paused && queue.length < batchSize) {
          paused = false
          source.resume()
        }
        yield { fields, rows }
        continue
      }
      if (done) return
      if (paused) {
        paused = false
        source.resume()
      }
      await new Promise<void>((resolve) => (wake = resolve))
    }
  } finally {
    if (!done) source.cancel()
  }
}

/**
 * The server wants a password and didn't get the right one (none saved, or a wrong one): the app asks for it.
 * Covers each driver's wording, including PostgreSQL's "client password must be a string" for a missing one.
 */
export function isPasswordProblem(err: unknown): boolean {
  // Some drivers reject with a plain string (pg's SASL "client password must be a string").
  const e = (typeof err === 'string' ? { message: err } : err) as { code?: string | number; errno?: number; message?: string } | undefined
  const code = String(e?.code ?? '')
  if (['28P01', '28000', 'ER_ACCESS_DENIED_ERROR', 'ELOGIN', '516'].includes(code) || e?.errno === 1045) return true
  return /client password must be a string|password authentication failed|no password supplied|Login failed for user|ORA-01017|ORA-01005|NJS-101|Authentication failed|AUTHENTICATION_FAILED|Access denied for user/i.test(
    e?.message ?? '',
  )
}

export class PasswordRequiredError extends Error {
  override name = 'PasswordRequiredError'
  readonly code = 'PASSWORD_REQUIRED'
  constructor(message: string) {
    super(message)
  }
}

/** A session's connection dropped (server restart, network) while it had uncommitted changes. */
export class ConnectionLostError extends Error {
  override name = 'ConnectionLostError'
  constructor(message = 'The connection to the server was lost, and with it the open transaction: the server rolled back its uncommitted changes. Start the transaction again.') {
    super(message)
  }
}

/**
 * Per-session transaction bookkeeping, so a session whose connection dropped mid-transaction says so once instead
 * of silently continuing on a new connection in autocommit mode.
 */
export class SessionTransactions {
  private open = new Map<string, boolean>()
  private lost = new Set<string>()
  constructor(private readonly implicitDml = false) {}
  /** Before a statement: throws once if the session's connection dropped with a transaction open. */
  check(session: string): void {
    if (this.lost.delete(session)) throw new ConnectionLostError()
  }
  isOpen(session: string): boolean {
    return this.open.get(session) ?? false
  }
  ran(session: string, sql: string): void {
    this.open.set(session, nextTransactionState(this.isOpen(session), sql, this.implicitDml))
  }
  /** The connection went away while idle: the next statement reports it if a transaction was open. */
  dropped(session: string): void {
    if (this.isOpen(session)) this.lost.add(session)
    this.open.delete(session)
  }
  released(session: string): void {
    this.open.delete(session)
    this.lost.delete(session)
  }
}

export class QueryCancelledError extends Error {
  override name = 'QueryCancelledError'
  constructor() {
    super('Query was cancelled')
  }
}

export class ReadOnlyViolationError extends Error {
  override name = 'ReadOnlyViolationError'
  constructor(message = 'This connection is read-only. Only SELECT-like statements are allowed.') {
    super(message)
  }
}

export function elapsed(start: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10
}

import type { BuiltQuery } from './filters.js'
import type { Dialect } from './dialect.js'
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

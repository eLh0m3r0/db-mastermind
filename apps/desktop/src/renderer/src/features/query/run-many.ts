import type { StatementOutcome, TransactionState } from '@dbmastermind/core/browser'

export interface Outcome {
  connectionId: string
  state: 'waiting' | 'running' | 'ok' | 'failed' | 'skipped'
  rows?: number
  changed?: number
  error?: string
  /** The transaction open after the run was rolled back (the run failed or was stopped, or no manual commit). */
  rolledBack?: boolean
}

/** One run of the dialog. Stop and Close mark only their own run: a run started later never sees it. */
export interface ManyRun {
  stopped: boolean
  /** The statement running now (Stop cancels it). */
  runId?: string
}

export interface RunManyApi {
  runQuery(request: { connectionId: string; sql: string; runId: string; maxRows: number; session: string }): Promise<StatementOutcome[]>
  transactionState(connectionId: string, session: string): Promise<TransactionState | null>
  endTransaction(connectionId: string, session: string, action: 'commit' | 'rollback'): Promise<TransactionState>
  releaseSession(connectionId: string, session: string): Promise<void>
}

/**
 * Runs the script on each connection in turn, as the editor runs it there, each in a session of its own: with manual
 * commit, what the run opened is committed when that connection's run succeeded and rolled back when it failed or was
 * stopped, so nothing is left waiting for a Commit nobody can press. A failed or stopped run on a connection that
 * commits at once keeps what its earlier statements did.
 */
export async function runOnConnections(
  run: ManyRun,
  /** `manualCommit`: the connection's own setting; only then is a transaction open after the run committed. */
  targets: { id: string; manualCommit?: boolean }[],
  sql: string,
  options: { stopOnError: boolean; newId: (prefix: string) => string; progress: (rows: Outcome[]) => void },
  api: RunManyApi,
): Promise<Outcome[]> {
  const rows: Outcome[] = targets.map((c) => ({ connectionId: c.id, state: 'waiting' }))
  options.progress([...rows])
  for (const [i, { id: connectionId, manualCommit }] of targets.entries()) {
    if (run.stopped) {
      rows[i] = { ...rows[i]!, state: 'skipped' }
      continue
    }
    rows[i] = { ...rows[i]!, state: 'running' }
    options.progress([...rows])
    const id = options.newId('many')
    const session = options.newId('many-session')
    run.runId = id
    try {
      const result = await api.runQuery({ connectionId, sql, runId: id, maxRows: 1000, session })
      const failed = result.find((o) => o.error)
      const sets = result.flatMap((o) => o.results ?? [])
      rows[i] = {
        connectionId,
        state: failed ? 'failed' : 'ok',
        rows: sets.filter((r) => r.fields.length).reduce((n, r) => n + r.rowCount, 0),
        changed: sets.reduce((n, r) => n + (r.affectedRows ?? 0), 0),
        error: failed?.error?.message,
      }
    } catch (err) {
      rows[i] = { connectionId, state: 'failed', error: err instanceof Error ? err.message : String(err) }
    }
    try {
      const state = await api.transactionState(connectionId, session)
      if (state && state !== 'none') {
        // Without manual commit only a script's own BEGIN without COMMIT leaves one open: it was never committed.
        const commit = !!manualCommit && rows[i]!.state === 'ok' && !run.stopped && state === 'open'
        await api.endTransaction(connectionId, session, commit ? 'commit' : 'rollback')
        if (!commit) rows[i] = { ...rows[i]!, rolledBack: true }
      }
    } catch (err) {
      rows[i] = { ...rows[i]!, state: 'failed', error: err instanceof Error ? err.message : String(err) }
    } finally {
      await api.releaseSession(connectionId, session).catch(() => {})
    }
    run.runId = undefined
    options.progress([...rows])
    if (rows[i]!.state === 'failed' && options.stopOnError) run.stopped = true
  }
  options.progress([...rows])
  return rows
}

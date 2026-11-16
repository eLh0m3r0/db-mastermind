import { describe, expect, it } from 'vitest'
import type { StatementOutcome, TransactionState } from '@dbmastermind/core/browser'
import { runOnConnections, type ManyRun, type RunManyApi } from '../src/renderer/src/features/query/run-many'

/** A fake main: manual-commit connections open a transaction on the first write of a session. */
function fakeApi(manual: Set<string>, fail: Set<string> = new Set(), hold?: Promise<void>) {
  const log: string[] = []
  const open = new Set<string>()
  const api: RunManyApi = {
    async runQuery({ connectionId, session, sql }) {
      log.push(`run ${connectionId} ${session ? 'session' : 'no session'}`)
      if (hold) await hold
      if (manual.has(connectionId)) open.add(session)
      const error = fail.has(connectionId) ? { message: 'boom' } : undefined
      return [{ sql, start: 0, end: sql.length, durationMs: 0, results: error ? undefined : [{ fields: [], rows: [], rowCount: 1, affectedRows: 1, durationMs: 0 }], error }] as unknown as StatementOutcome[]
    },
    async transactionState(_c, session): Promise<TransactionState> {
      return open.has(session) ? 'open' : 'none'
    },
    async endTransaction(connectionId, session, action) {
      log.push(`${action} ${connectionId}`)
      open.delete(session)
      return 'none'
    },
    async releaseSession(connectionId) {
      log.push(`release ${connectionId}`)
    },
  }
  return { api, log }
}

let n = 0
const options = (progress: (rows: unknown) => void = () => {}) => ({ stopOnError: false, newId: (p: string) => `${p}-${++n}`, progress })

describe('Run on several connections', () => {
  it('runs each connection in a session; manual commit is committed after a good run and rolled back after a failed one', async () => {
    const { api, log } = fakeApi(new Set(['dev', 'prod']), new Set(['prod']))
    const rows = await runOnConnections({ stopped: false }, [{ id: 'dev', manualCommit: true }, { id: 'auto' }, { id: 'prod', manualCommit: true }], 'UPDATE t SET a = 1', options(), api)
    expect(log).toEqual(['run dev session', 'commit dev', 'release dev', 'run auto session', 'release auto', 'run prod session', 'rollback prod', 'release prod'])
    expect(rows.map((r) => [r.connectionId, r.state, !!r.rolledBack])).toEqual([['dev', 'ok', false], ['auto', 'ok', false], ['prod', 'failed', true]])
  })

  it('a run that was stopped rolls back and runs nothing more, and does not stop a later run', async () => {
    let release!: () => void
    const hold = new Promise<void>((r) => (release = r))
    const { api, log } = fakeApi(new Set(['a', 'b']), new Set(), hold)
    const first: ManyRun = { stopped: false }
    const old = runOnConnections(first, [{ id: 'a', manualCommit: true }, { id: 'b', manualCommit: true }], 'UPDATE t SET a = 1', options(), api)
    // Close while 'a' runs, then start again before its statement returns.
    first.stopped = true
    const second: ManyRun = { stopped: false }
    const again = runOnConnections(second, [{ id: 'b', manualCommit: true }], 'UPDATE t SET a = 2', options(), api)
    release()
    const [oldRows, newRows] = await Promise.all([old, again])
    expect(oldRows.map((r) => r.state)).toEqual(['ok', 'skipped'])
    expect(oldRows[0]!.rolledBack).toBe(true)
    expect(newRows.map((r) => r.state)).toEqual(['ok'])
    expect(second.stopped).toBe(false)
    expect(log.filter((l) => l.startsWith('commit'))).toEqual(['commit b'])
  })
})

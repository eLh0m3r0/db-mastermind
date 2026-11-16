import { describe, expect, it } from 'vitest'
import type { StatementOutcome } from '@dbmastermind/core/browser'
import { stepsAfterRun } from '../src/renderer/src/store/transaction-steps'

const ran = (...sql: string[]): StatementOutcome[] => sql.map((s) => ({ sql: s, results: [{ affectedRows: 1 }] }) as unknown as StatementOutcome)
const open = { steps: [{ sql: 'UPDATE a SET x = 1', rows: 1 }], since: 1000 }

describe('the transaction bar after a run', () => {
  it('adds the run to the open transaction', () => {
    expect(stepsAfterRun(open, ran('UPDATE b SET x = 1'), 5000)).toEqual({ steps: [open.steps[0], { sql: 'UPDATE b SET x = 1', rows: 1 }], since: 1000 })
  })

  it('a COMMIT or ROLLBACK in the run ends what was open: only what follows it is uncommitted, and it is new', () => {
    expect(stepsAfterRun(open, ran('COMMIT', 'UPDATE b SET x = 1'), 5000)).toEqual({ steps: [{ sql: 'UPDATE b SET x = 1', rows: 1 }], since: 5000 })
    expect(stepsAfterRun(undefined, ran('UPDATE a SET x = 1', 'COMMIT', 'UPDATE b SET x = 1'), 5000).steps.map((s) => s.sql)).toEqual(['UPDATE b SET x = 1'])
    expect(stepsAfterRun(open, ran('ROLLBACK;', 'DELETE FROM c'), 5000).steps.map((s) => s.sql)).toEqual(['DELETE FROM c'])
  })

  it('a rollback to a savepoint or a failed COMMIT ends nothing', () => {
    expect(stepsAfterRun(open, ran('ROLLBACK TO SAVEPOINT s1'), 5000).since).toBe(1000)
    expect(stepsAfterRun(open, ran('ROLLBACK TO s1'), 5000).steps).toHaveLength(1)
    const failed = [{ sql: 'COMMIT', error: { message: 'no' } } as unknown as StatementOutcome]
    expect(stepsAfterRun(open, failed, 5000).since).toBe(1000)
  })

  it('statements before a BEGIN that opened the transaction committed on their own', () => {
    expect(stepsAfterRun(undefined, ran('UPDATE a SET x = 1', 'BEGIN', 'UPDATE b SET x = 1'), 5000).steps.map((s) => s.sql)).toEqual(['UPDATE b SET x = 1'])
  })
})

import { describe, expect, it } from 'vitest'
import type { StatementOutcome } from '@dbmastermind/core/browser'
import { loadAllTarget, withReloaded } from '../src/renderer/src/features/query/load-all'

const outcome = (sql: string, start: number, rows = 1): StatementOutcome => ({ sql, start, end: start + sql.length, durationMs: 0, results: [{ fields: [{ name: 'a' }], rows: [], rowCount: rows, durationMs: 0 }] }) as unknown as StatementOutcome

describe('Load all rows', () => {
  it('runs only the statement of the result, never the writes of the run around it', () => {
    // "Run all" on `UPDATE …; SELECT …`: Load all re-runs the SELECT alone.
    expect(loadAllTarget(outcome('SELECT * FROM t', 30), 10, 'postgres')).toEqual({ sql: 'SELECT * FROM t', offset: 40 })
    expect(loadAllTarget(outcome('DELETE FROM t RETURNING *', 0), 0, 'postgres')).toBeNull()
    expect(loadAllTarget(outcome('INSERT INTO t SELECT * FROM s RETURNING id', 0), 0, 'postgres')).toBeNull()
  })

  it('puts the reloaded result in its place and keeps the others', () => {
    const update = outcome('UPDATE t SET a = 1', 0)
    const select = outcome('SELECT * FROM t', 20, 1000)
    const all = withReloaded([update, select], select, [outcome('SELECT * FROM t', 0, 5000)])
    expect(all[0]).toBe(update)
    expect(all[1]).toMatchObject({ start: 20, results: [{ rowCount: 5000 }] })
  })
})

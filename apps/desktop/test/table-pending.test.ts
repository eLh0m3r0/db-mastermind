import { describe, expect, it } from 'vitest'
import type { QueryResult } from '@dbmastermind/core/browser'
import { carryPending } from '../src/renderer/src/features/table/pending'

const page = (...rows: [number, string][]): QueryResult => ({ fields: [{ name: 'id' }, { name: 'name' }], rows, rowCount: rows.length, durationMs: 0 }) as unknown as QueryResult

describe('Commit / Roll back in a table tab keeps the unsaved edits', () => {
  it('moves them to the same rows of the reloaded page, found by key', () => {
    const before = page([1, 'a'], [2, 'b'], [3, 'c'])
    // The rollback removed row 1: rows 2 and 3 moved up.
    const after = page([2, 'b'], [3, 'c'])
    const pending = { edits: new Map([[1, { name: 'B' }], [2, { name: 'C' }]]), inserted: [{ name: 'new' }], deleted: new Set([2]) }
    const { pending: carried, lost } = carryPending(pending, before, after, ['id'])
    expect([...carried.edits]).toEqual([[0, { name: 'B' }], [1, { name: 'C' }]])
    expect([...carried.deleted]).toEqual([1])
    expect(carried.inserted).toEqual([{ name: 'new' }])
    expect(lost).toBe(0)
  })

  it('counts edits whose row is gone', () => {
    const { pending, lost } = carryPending({ edits: new Map([[0, { name: 'A' }]]), inserted: [], deleted: new Set<number>() }, page([1, 'a']), page(), ['id'])
    expect(pending.edits.size).toBe(0)
    expect(lost).toBe(1)
  })
})

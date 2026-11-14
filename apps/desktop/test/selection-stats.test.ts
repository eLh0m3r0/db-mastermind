import { describe, expect, it } from 'vitest'
import { MAX_STAT_CELLS, selectionStats } from '../src/renderer/src/components/grid/selection-stats'

const fields = [
  { name: 'id', dataType: 'int4' },
  { name: 'total', dataType: 'numeric' },
  { name: 'status', dataType: 'text' },
  { name: 'code', dataType: 'text' },
]
const rows = [
  [1, '10.50', 'paid', '007'],
  [2, '0.25', 'new', '42'],
  [3, null, 'paid', null],
  [4, '1000', 'paid', '42'],
]

describe('selectionStats', () => {
  it('sums exact numerics that arrive as text, keeping their decimals, and counts NULLs apart', () => {
    const s = selectionStats(fields, rows, { r0: 0, r1: 3, c0: 1, c1: 1 })
    expect(s).toMatchObject({ cells: 4, count: 3, empty: 1, sum: 1010.75, min: 0.25, max: 1000, decimals: 2 })
    expect(s.avg).toBeCloseTo(336.9166, 3)
  })

  it('adds integers without floating point noise', () => {
    expect(selectionStats([{ name: 'x', dataType: 'numeric' }], [['0.1'], ['0.2']], { r0: 0, r1: 1, c0: 0, c1: 0 }).sum).toBe(0.3)
  })

  it('counts distinct values of text; digits in a text column stay text', () => {
    expect(selectionStats(fields, rows, { r0: 0, r1: 3, c0: 2, c1: 2 })).toEqual({ cells: 4, count: 4, empty: 0, distinct: 2 })
    expect(selectionStats(fields, rows, { r0: 0, r1: 3, c0: 3, c1: 3 })).toEqual({ cells: 4, count: 3, empty: 1, distinct: 2 })
  })

  it('a block over numbers and text has no sum', () => {
    const s = selectionStats(fields, rows, { r0: 0, r1: 1, c0: 0, c1: 2 })
    expect(s.sum).toBeUndefined()
    expect(s).toMatchObject({ cells: 6, count: 6 })
  })

  it('ignores rows past the end and gives only a count for huge selections', () => {
    expect(selectionStats(fields, rows, { r0: 2, r1: 99, c0: 0, c1: 0 })).toMatchObject({ cells: 2, sum: 7 })
    const huge = selectionStats(fields, Array.from({ length: MAX_STAT_CELLS / 2 + 1 }, () => [1, 2]), { r0: 0, r1: MAX_STAT_CELLS, c0: 0, c1: 1 })
    expect(huge.tooMany).toBe(true)
  })
})

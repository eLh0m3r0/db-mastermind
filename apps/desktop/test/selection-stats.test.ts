import { describe, expect, it } from 'vitest'
import { decimalText, MAX_STAT_CELLS, parseDecimal, selectionStats } from '../src/renderer/src/components/grid/selection-stats'

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
    expect(selectionStats(fields, rows, { r0: 0, r1: 3, c0: 1, c1: 1 })).toEqual({ cells: 4, count: 3, empty: 1, sum: '1010.75', avg: '336.91666667', min: '0.25', max: '1000' })
  })

  it('adds decimals exactly', () => {
    expect(selectionStats([{ name: 'x', dataType: 'numeric' }], [['0.1'], ['0.2']], { r0: 0, r1: 1, c0: 0, c1: 0 }).sum).toBe('0.3')
  })

  it('keeps every digit of bigint values and the smallest exponents (review finding)', () => {
    const big = selectionStats([{ name: 'x', dataType: 'int8' }], [['9007199254740993'], ['1']], { r0: 0, r1: 1, c0: 0, c1: 0 })
    expect(big).toMatchObject({ sum: '9007199254740994', max: '9007199254740993', min: '1' })
    const tiny = selectionStats([{ name: 'x', dataType: 'float8' }], [[1e-7], [2e-7]], { r0: 0, r1: 1, c0: 0, c1: 0 })
    expect(tiny).toMatchObject({ sum: '0.0000003', min: '0.0000001', max: '0.0000002' })
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
    expect(selectionStats(fields, rows, { r0: 2, r1: 99, c0: 0, c1: 0 })).toMatchObject({ cells: 2, sum: '7' })
    const huge = selectionStats(fields, Array.from({ length: MAX_STAT_CELLS / 2 + 1 }, () => [1, 2]), { r0: 0, r1: MAX_STAT_CELLS, c0: 0, c1: 1 })
    expect(huge.tooMany).toBe(true)
  })
})

describe('parseDecimal / decimalText', () => {
  it.each([
    ['123.4500', '123.4500'],
    ['-0.5', '-0.5'],
    ['1e-7', '0.0000001'],
    ['2.5E3', '2500'],
    ['+7', '7'],
    ['.5', '0.5'],
  ])('%s → %s', (input, out) => {
    expect(decimalText(parseDecimal(input)!)).toBe(out)
  })

  it('is not fooled by text', () => {
    for (const x of ['', '.', 'abc', '1.2.3', 'Infinity', '1e999']) expect(parseDecimal(x)).toBeUndefined()
  })
})

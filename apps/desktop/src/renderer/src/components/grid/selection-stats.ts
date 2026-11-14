import { cellToText, isBinaryValue, type CellValue, type ResultField } from '@dbmastermind/core/browser'

/** Beyond this many selected cells only the count is shown (a whole million-row result selected with ⌘A). */
export const MAX_STAT_CELLS = 1_000_000

const NUMERIC_TYPE = /(int|serial|numeric|decimal|float|double|real|money|number|longlong|newdecimal|tiny|short|long)/i
const NUMBER_TEXT = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/

/** Whether a column holds numbers (exact numerics arrive as text, e.g. PostgreSQL numeric and bigint). */
export function isNumericField(field: ResultField, dataType?: string): boolean {
  const type = dataType ?? field.dataType
  return !!type && NUMERIC_TYPE.test(type) && !/interval|point/i.test(type)
}

export interface SelectionStats {
  cells: number
  /** Cells with a value (not NULL). */
  count: number
  empty: number
  /** Set when every value is a number. */
  sum?: number
  avg?: number
  min?: number
  max?: number
  /** Digits after the decimal point the values have (sum and min/max are shown with as many). */
  decimals?: number
  /** Different values, when they are not all numbers. */
  distinct?: number
  /** Too many cells to look at each. */
  tooMany?: boolean
}

/**
 * Totals of a rectangular selection of a grid: count, empty; sum/avg/min/max when every value is a number, the
 * number of distinct values otherwise.
 */
export function selectionStats(
  fields: ResultField[],
  rows: CellValue[][],
  bounds: { r0: number; r1: number; c0: number; c1: number },
  dataTypes?: (string | undefined)[],
): SelectionStats {
  const r1 = Math.min(bounds.r1, rows.length - 1)
  const cells = Math.max(0, r1 - bounds.r0 + 1) * (bounds.c1 - bounds.c0 + 1)
  if (cells > MAX_STAT_CELLS) return { cells, count: cells, empty: 0, tooMany: true }
  const numericCol: boolean[] = []
  for (let c = bounds.c0; c <= bounds.c1; c++) numericCol[c] = !!fields[c] && isNumericField(fields[c]!, dataTypes?.[c])
  let count = 0
  let empty = 0
  let allNumbers = true
  let sum = 0
  let min = Infinity
  let max = -Infinity
  let decimals = 0
  const distinct = new Set<string>()
  for (let r = bounds.r0; r <= r1; r++) {
    const row = rows[r]
    if (!row) continue
    for (let c = bounds.c0; c <= bounds.c1; c++) {
      const v = row[c] ?? null
      if (v === null) {
        empty++
        continue
      }
      count++
      let n: number | undefined
      if (typeof v === 'number') n = v
      else if (typeof v === 'string' && numericCol[c] && NUMBER_TEXT.test(v.trim())) n = Number(v)
      if (n === undefined || !Number.isFinite(n)) {
        allNumbers = false
        distinct.add(isBinaryValue(v) ? `0x${v.$binary}` : cellToText(v))
        continue
      }
      if (allNumbers) {
        sum += n
        if (n < min) min = n
        if (n > max) max = n
        const text = typeof v === 'string' ? v.trim() : String(v)
        const dot = text.indexOf('.')
        if (dot !== -1 && !/e/i.test(text)) decimals = Math.max(decimals, text.length - dot - 1)
      }
      distinct.add(String(n))
    }
  }
  if (count > 0 && allNumbers) {
    const places = Math.min(decimals, 10)
    const round = (x: number) => Number(x.toFixed(places))
    return { cells, count, empty, sum: round(sum), avg: sum / count, min, max, decimals: places }
  }
  return { cells, count, empty, distinct: distinct.size }
}

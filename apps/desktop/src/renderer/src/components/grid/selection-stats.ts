import { cellToText, isBinaryValue, type CellValue, type ResultField } from '@dbmastermind/core/browser'

/** Beyond this many selected cells only the count is shown (a whole million-row result selected with ⌘A). */
export const MAX_STAT_CELLS = 1_000_000
/** Decimal places beyond which numbers are not totalled (they would not be shown faithfully). */
const MAX_SCALE = 40

const NUMERIC_TYPE = /(int|serial|numeric|decimal|float|double|real|money|number|longlong|newdecimal|tiny|short|long)/i
const NUMBER_TEXT = /^([-+]?)(\d*)(?:\.(\d*))?(?:[eE]([-+]?\d+))?$/

/** Whether a column holds numbers (exact numerics arrive as text, e.g. PostgreSQL numeric and bigint). */
export function isNumericField(field: ResultField, dataType?: string): boolean {
  const type = dataType ?? field.dataType
  return !!type && NUMERIC_TYPE.test(type) && !/interval|point/i.test(type)
}

/** An exact decimal: `units × 10^-scale`. */
interface Decimal {
  units: bigint
  scale: number
}

/** Exact value of a number as written ("123.4500", "1e-7", "-0.5"); undefined when it is not one. */
export function parseDecimal(text: string): Decimal | undefined {
  const m = NUMBER_TEXT.exec(text.trim())
  if (!m || (!m[2] && !m[3])) return undefined
  const [, sign, whole = '', fraction = '', exponent = '0'] = m
  let scale = fraction.length - Number(exponent)
  let digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, '') || '0'
  if (scale < 0) {
    if (-scale > MAX_SCALE) return undefined
    digits += '0'.repeat(-scale)
    scale = 0
  }
  if (scale > MAX_SCALE) return undefined
  const units = BigInt(digits)
  return { units: sign === '-' ? -units : units, scale }
}

const pow10 = (n: number) => 10n ** BigInt(n)
const align = (a: Decimal, scale: number) => a.units * pow10(scale - a.scale)

/** "1234.50" for units 123450, scale 2 (the exact text, for copying). */
export function decimalText(d: Decimal): string {
  const negative = d.units < 0n
  const digits = (negative ? -d.units : d.units).toString().padStart(d.scale + 1, '0')
  const whole = digits.slice(0, digits.length - d.scale)
  const fraction = d.scale ? digits.slice(digits.length - d.scale) : ''
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

export interface SelectionStats {
  cells: number
  /** Cells with a value (not NULL). */
  count: number
  empty: number
  /** Exact decimal text, set when every value is a number. */
  sum?: string
  /** Rounded to `scale + 6` places at most, trailing zeros dropped. */
  avg?: string
  min?: string
  max?: string
  /** Different values, when they are not all numbers. */
  distinct?: number
  /** Too many cells to look at each. */
  tooMany?: boolean
}

/**
 * Totals of a rectangular selection of a grid: count, empty; sum/avg/min/max when every value is a number (exact
 * decimal arithmetic: bigint and numeric values keep every digit), the number of distinct values otherwise.
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
  const values: Decimal[] = []
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
      let d: Decimal | undefined
      if (typeof v === 'number' && Number.isFinite(v)) d = parseDecimal(String(v))
      else if (typeof v === 'string' && numericCol[c]) d = parseDecimal(v)
      if (!d) {
        allNumbers = false
        distinct.add(isBinaryValue(v) ? `0x${v.$binary}` : cellToText(v))
        continue
      }
      if (allNumbers) values.push(d)
      distinct.add(decimalText(d))
    }
  }
  if (count > 0 && allNumbers) {
    const scale = Math.max(...values.map((d) => d.scale))
    let sum = 0n
    let min = values[0]!
    let max = values[0]!
    for (const d of values) {
      const units = align(d, scale)
      sum += units
      if (units < align(min, scale)) min = d
      if (units > align(max, scale)) max = d
    }
    // Average with six more places, rounded half away from zero, trailing zeros dropped.
    const extra = 6
    const scaled = sum * pow10(extra) * 2n
    const n = BigInt(values.length)
    const half = (scaled / n + (scaled >= 0n ? 1n : -1n)) / 2n
    const avg = decimalText({ units: half, scale: scale + extra }).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
    return { cells, count, empty, sum: decimalText({ units: sum, scale }), avg, min: decimalText(min), max: decimalText(max) }
  }
  return { cells, count, empty, distinct: distinct.size }
}

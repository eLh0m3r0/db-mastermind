import type { BinaryValue, CellValue } from './types.js'

const MAX_BINARY_PREVIEW = 4096

export function isBinaryValue(v: unknown): v is BinaryValue {
  return typeof v === 'object' && v !== null && '$binary' in v && 'length' in v
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

/** Formats a Date as local-time-free ISO-like text, keeping what the driver parsed (UTC). */
function formatDate(d: Date): string {
  if (Number.isNaN(d.getTime())) return 'Invalid date'
  const ms = d.getUTCMilliseconds()
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` +
    (ms ? `.${pad(ms, 3)}` : '')
  )
}

/**
 * Converts any driver value to something that can cross IPC/JSON without losing information:
 * bigint → string, Date → string, Buffer → hex, nested JSON stays structured.
 */
export function normalizeValue(value: unknown): CellValue {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      return Number.isFinite(value) ? value : String(value)
    case 'bigint':
      return value.toString()
    case 'object':
      break
    default:
      return String(value)
  }
  if (value instanceof Date) return formatDate(value)
  if (value instanceof Uint8Array) {
    const bytes = value.subarray(0, MAX_BINARY_PREVIEW)
    return { $binary: Buffer.from(bytes).toString('hex'), length: value.length }
  }
  if (Array.isArray(value)) return value.map(normalizeValue)
  const out: { [key: string]: CellValue } = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = normalizeValue(v)
  return out
}

/** Display text for a cell, used by grids, copy and CSV export. */
export function cellToText(value: CellValue): string {
  if (value === null) return 'NULL'
  if (typeof value === 'string') return value
  // 15 significant digits hide binary float noise (0.1 + 0.2 → 0.3) without losing real precision.
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(15)))
  if (typeof value === 'boolean') return String(value)
  if (isBinaryValue(value)) return `0x${value.$binary}${value.length * 2 > value.$binary.length ? '…' : ''}`
  return JSON.stringify(value)
}

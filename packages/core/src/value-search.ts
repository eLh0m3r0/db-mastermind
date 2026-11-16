import { columnFamily, newFilterId, type FilterCondition, type FilterGroup, type FilterNode } from './filters.js'
import type { CellValue, DriverId, TableInfo } from './types.js'
import { cellToText } from './values.js'

/** Exact: the whole value (fast, uses indexes; what an order number needs). Contains: anywhere in text columns. */
export type ValueSearchMode = 'exact' | 'contains'

export type SearchedValueKind = 'number' | 'date' | 'uuid' | 'text'

const NUMBER = /^[-+]?\d+(\.\d+)?$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function searchedValueKind(text: string): SearchedValueKind {
  const v = text.trim()
  if (NUMBER.test(v)) return 'number'
  if (DATE.test(v) && !Number.isNaN(Date.parse(v))) return 'date'
  if (UUID.test(v)) return 'uuid'
  return 'text'
}

/** Column types that can't be compared with = (large objects, documents, spatial, binary). */
function unsearchable(dataType: string, driver: DriverId): boolean {
  const t = dataType.toLowerCase()
  if (/json|xml|blob|binary|bytea|image|geometry|geography|point|polygon|raster|hierarchyid|sql_variant|vector|array|\[\]|struct|map\(|tsvector/.test(t)) return true
  if (driver === 'mssql' && /^(n?text)$/.test(t)) return true
  if (driver === 'oracle' && /n?clob|long|raw/.test(t)) return true
  // DuckDB casts the searched text to the enum and fails for a value that isn't one of its labels.
  if (driver === 'duckdb' && /^enum/.test(t)) return true
  return false
}

const isUuidType = (t: string) => /^(uuid|uniqueidentifier)$/i.test(t)
const isPlainDate = (t: string) => /^date$/i.test(t)

/**
 * The type's own name, without its arguments: `enum('pending','printed')` → `enum`, `numeric(12, 2)` → `numeric`,
 * `timestamp(3) with time zone` → `timestamp with time zone`. Enum labels and user type names (`user_role_enum`) must
 * not decide what a column holds.
 */
function baseType(dataType: string): string {
  let out = ''
  let depth = 0
  for (let i = 0; i < dataType.length; i++) {
    const ch = dataType[i]!
    if (ch === "'") {
      const close = dataType.indexOf("'", i + 1)
      i = close === -1 ? dataType.length : close
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (!depth) out += ch
  }
  const base = out.toLowerCase().replace(/\s+/g, ' ').trim()
  // ClickHouse wraps types: Nullable(String), LowCardinality(String).
  const wrapped = /^(nullable|lowcardinality)$/.test(base) ? /\((.*)\)\s*$/.exec(dataType) : null
  return wrapped ? baseType(wrapped[1]!) : base
}

const TEXT_TYPES = /^(n?char|n?varchar2?|character( varying)?|national (char|character)( varying)?|bpchar|(tiny|medium|long)?text|ntext|string|citext|name|sysname|clob|nclob|enum\d*|set|fixedstring)$/
const FRACTION_TYPES = /^(numeric|decimal\d*|dec|number|float\d*|double( precision)?|real|money|smallmoney|bignumeric)$/
const DATE_TYPES = /^(date\d*|datetime\d*|smalldatetime|datetimeoffset|timestamp( with(out)? time zone)?|timestamptz|timestamp_(s|ms|ns))$/
const UNSIGNED_DUCKDB_BITS: Record<string, number> = { utinyint: 8, usmallint: 16, uinteger: 32, ubigint: 64, uhugeint: 128 }

/** The values an integer column takes, or undefined for a type that isn't an integer. */
function integerRange(base: string, driver: DriverId): [bigint, bigint] | undefined {
  const bits = (n: number, unsigned: boolean): [bigint, bigint] => (unsigned ? [0n, (1n << BigInt(n)) - 1n] : [-(1n << BigInt(n - 1)), (1n << BigInt(n - 1)) - 1n])
  const unsigned = /\bunsigned\b/.test(base)
  // ClickHouse and BigQuery count bits (Int8, INT64); PostgreSQL counts bytes (int2, int8).
  const sized = /^(u?)int(\d+)$/.exec(base)
  if (sized) return driver === 'clickhouse' || driver === 'bigquery' ? bits(Number(sized[2]), sized[1] === 'u') : bits(Number(sized[2]) * 8, false)
  if (UNSIGNED_DUCKDB_BITS[base]) return bits(UNSIGNED_DUCKDB_BITS[base], true)
  if (/^tinyint\b/.test(base)) return bits(8, unsigned || driver === 'mssql')
  if (/^(smallint|smallserial|serial2)\b/.test(base)) return bits(16, unsigned)
  if (/^mediumint\b/.test(base)) return bits(24, unsigned)
  if (/^(int|integer|serial|serial4)\b/.test(base)) return bits(32, unsigned)
  if (/^(bigint|bigserial|serial8)\b/.test(base)) return bits(64, unsigned)
  if (/^hugeint\b/.test(base)) return bits(128, false)
  return undefined
}

/**
 * Whether a column of this type can be compared with the searched number without an error: integers in range for
 * integer columns, no more digits before the point than a numeric(p, s) column takes.
 */
function holdsNumber(dataType: string, value: string, driver: DriverId): boolean {
  const base = baseType(dataType)
  const [whole = '0', fraction = ''] = value.replace(/^[-+]/, '').split('.')
  const range = integerRange(base, driver)
  if (range) {
    if (/[1-9]/.test(fraction)) return false
    const n = BigInt(whole) * (value.startsWith('-') ? -1n : 1n)
    return n >= range[0] && n <= range[1]
  }
  const args = /\(\s*(\d+)\s*(?:,\s*(-?\d+)\s*)?\)/.exec(dataType)
  if (args && /^(numeric|decimal|dec|number)$/.test(base)) return whole.replace(/^0+/, '').length <= Number(args[1]) - Number(args[2] ?? 0)
  return true
}

/** The kind of value a column holds, from its type's own name; SQLite's affinity reads names loosely, as columnFamily does. */
function searchFamily(dataType: string, driver: DriverId): 'text' | 'number' | 'date' | 'other' {
  if (driver === 'sqlite') {
    const family = columnFamily(dataType)
    return family === 'boolean' ? 'other' : family
  }
  const base = baseType(dataType)
  if (isUuidType(base) || TEXT_TYPES.test(base)) return 'text'
  if (integerRange(base, driver) || FRACTION_TYPES.test(base.replace(/ unsigned$/, ''))) return 'number'
  // (SQL Server's timestamp is a rowversion.)
  if (DATE_TYPES.test(base) && !(driver === 'mssql' && base === 'timestamp')) return 'date'
  return 'other'
}

/**
 * The conditions that find `text` in one table, each on a column whose type can hold such a value (comparing a
 * uuid, enum or number column with arbitrary text is an error in PostgreSQL); null when no column can.
 */
export function valueSearchConditions(table: Pick<TableInfo, 'columns'>, text: string, mode: ValueSearchMode, driver: DriverId): ValueSearchCondition[] {
  const value = text.trim()
  if (!value) return []
  const kind = searchedValueKind(value)
  const out: ValueSearchCondition[] = []
  const condition = (column: string, operator: FilterCondition['operator'], v: string): FilterCondition => ({ kind: 'condition', id: newFilterId(), column, operator, value: v })
  const add = (column: string, operator: 'eq' | 'contains' | 'day', v: string) => {
    if (operator !== 'day') return out.push({ column, operator, node: condition(column, operator, v) })
    // The whole day, half open: [day, next day) also holds 23:59:59.9995 and never the next midnight.
    const next = new Date(`${v}T00:00:00Z`)
    next.setUTCDate(next.getUTCDate() + 1)
    return out.push({ column, operator, node: { kind: 'group', id: newFilterId(), combinator: 'and', children: [condition(column, 'gte', v), condition(column, 'lt', next.toISOString().slice(0, 10))] } })
  }
  for (const c of table.columns) {
    const type = c.dataType ?? ''
    if (unsearchable(type, driver)) continue
    const family = searchFamily(type, driver)
    if (family === 'text') {
      if (isUuidType(baseType(type))) {
        if (kind === 'uuid') add(c.name, 'eq', value)
        continue
      }
      // PostgreSQL enums and domains are reported by their own type name (family 'other'), so only real text columns
      // get here; a MySQL ENUM compares as text.
      add(c.name, mode === 'contains' ? 'contains' : 'eq', value)
    } else if (family === 'number' && kind === 'number' && holdsNumber(type, value, driver)) {
      add(c.name, 'eq', value)
    } else if (family === 'date' && kind === 'date' && driver !== 'oracle' && driver !== 'bigquery') {
      // A date matches the whole day of a timestamp.
      add(c.name, isPlainDate(baseType(type)) ? 'eq' : 'day', value)
    }
  }
  return out
}

/** One searched column: how it is compared, and its part of the table tab's filter. */
export interface ValueSearchCondition {
  column: string
  operator: 'eq' | 'contains' | 'day'
  node: FilterNode
}

/** The filter of a table tab that shows the rows holding `text` (the conditions OR-ed). */
export function valueSearchFilter(conditions: ValueSearchCondition[]): FilterGroup {
  return { kind: 'group', id: newFilterId(), combinator: 'or', children: conditions.map((c) => c.node) }
}

/** Which of the searched columns hold the value in the rows found (for the result list). */
export function matchedColumns(fields: { name: string }[], rows: CellValue[][], conditions: ValueSearchCondition[], text: string): string[] {
  const needle = text.trim().toLowerCase()
  const kind = searchedValueKind(needle)
  const out = new Set<string>()
  for (const condition of conditions) {
    const i = fields.findIndex((f) => f.name === condition.column)
    if (i === -1) continue
    for (const row of rows) {
      const v = row[i]
      if (v === null || v === undefined) continue
      const cell = cellToText(v).toLowerCase()
      const hit =
        condition.operator === 'contains'
          ? cell.includes(needle)
          : condition.operator === 'day'
            ? cell.startsWith(needle)
            : cell === needle || (kind === 'number' && Number(cell) === Number(needle)) || (kind === 'date' && cell.startsWith(needle))
      if (hit) {
        out.add(condition.column)
        break
      }
    }
  }
  return [...out]
}

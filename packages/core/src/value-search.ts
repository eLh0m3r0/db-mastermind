import { columnFamily, newFilterId, type FilterCondition, type FilterGroup } from './filters.js'
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
 * The conditions that find `text` in one table, each on a column whose type can hold such a value (comparing a
 * uuid, enum or number column with arbitrary text is an error in PostgreSQL); null when no column can.
 */
export function valueSearchConditions(table: Pick<TableInfo, 'columns'>, text: string, mode: ValueSearchMode, driver: DriverId): FilterCondition[] {
  const value = text.trim()
  if (!value) return []
  const kind = searchedValueKind(value)
  const out: FilterCondition[] = []
  const add = (column: string, operator: FilterCondition['operator'], v: string, v2?: string) => out.push({ kind: 'condition', id: newFilterId(), column, operator, value: v, ...(v2 ? { value2: v2 } : {}) })
  for (const c of table.columns) {
    const type = c.dataType ?? ''
    if (unsearchable(type, driver)) continue
    const family = columnFamily(type)
    if (family === 'text') {
      if (isUuidType(type)) {
        if (kind === 'uuid') add(c.name, 'eq', value)
        continue
      }
      // PostgreSQL enums are reported by their own type name (family 'other'), so only real text columns get here.
      add(c.name, mode === 'contains' ? 'contains' : 'eq', value)
    } else if (family === 'number' && kind === 'number') {
      add(c.name, 'eq', value)
    } else if (family === 'date' && kind === 'date' && driver !== 'oracle' && driver !== 'bigquery') {
      // A date matches the whole day of a timestamp.
      if (isPlainDate(type)) add(c.name, 'eq', value)
      else add(c.name, 'between', `${value} 00:00:00`, `${value} 23:59:59.999`)
    }
  }
  return out
}

/** The filter of a table tab that shows the rows holding `text` (the conditions OR-ed). */
export function valueSearchFilter(conditions: FilterCondition[]): FilterGroup {
  return { kind: 'group', id: newFilterId(), combinator: 'or', children: conditions }
}

/** Which of the searched columns hold the value in the rows found (for the result list). */
export function matchedColumns(fields: { name: string }[], rows: CellValue[][], conditions: FilterCondition[], text: string): string[] {
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
          : condition.operator === 'between'
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

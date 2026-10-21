import { qualify, type Dialect } from './dialect.js'
import type { TableRef } from './types.js'

export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'in'
  | 'not_in'
  | 'between'
  | 'not_between'
  | 'is_null'
  | 'is_not_null'
  | 'is_empty'
  | 'is_not_empty'
  | 'is_true'
  | 'is_false'
  | 'regex'
  | 'not_regex'
  | 'today'
  | 'yesterday'
  | 'last_n_days'
  | 'this_week'
  | 'this_month'
  | 'this_year'

export interface FilterCondition {
  kind: 'condition'
  id: string
  column: string
  operator: FilterOperator
  value?: string
  value2?: string
  /** For in / not_in. */
  values?: string[]
  enabled?: boolean
}

export interface FilterGroup {
  kind: 'group'
  id: string
  combinator: 'and' | 'or'
  negate?: boolean
  children: FilterNode[]
  enabled?: boolean
}

/** Free-form SQL condition, inserted verbatim. */
export interface RawFilter {
  kind: 'raw'
  id: string
  sql: string
  enabled?: boolean
}

export type FilterNode = FilterCondition | FilterGroup | RawFilter

export interface OperatorMeta {
  id: FilterOperator
  label: string
  /** How many value inputs the UI should show. 'list' = multiple values. */
  arity: 0 | 1 | 2 | 'list'
  /** Applies to which column families. */
  families: ColumnFamily[]
}

export type ColumnFamily = 'text' | 'number' | 'date' | 'boolean' | 'other'

const ALL: ColumnFamily[] = ['text', 'number', 'date', 'boolean', 'other']

export const OPERATORS: OperatorMeta[] = [
  { id: 'eq', label: '=', arity: 1, families: ALL },
  { id: 'neq', label: '≠', arity: 1, families: ALL },
  { id: 'contains', label: 'contains', arity: 1, families: ['text', 'number', 'date', 'other'] },
  { id: 'not_contains', label: 'does not contain', arity: 1, families: ['text', 'number', 'date', 'other'] },
  { id: 'starts_with', label: 'starts with', arity: 1, families: ['text', 'number', 'other'] },
  { id: 'ends_with', label: 'ends with', arity: 1, families: ['text', 'number', 'other'] },
  { id: 'gt', label: '>', arity: 1, families: ['number', 'date', 'text', 'other'] },
  { id: 'gte', label: '≥', arity: 1, families: ['number', 'date', 'text', 'other'] },
  { id: 'lt', label: '<', arity: 1, families: ['number', 'date', 'text', 'other'] },
  { id: 'lte', label: '≤', arity: 1, families: ['number', 'date', 'text', 'other'] },
  { id: 'between', label: 'between', arity: 2, families: ['number', 'date', 'text'] },
  { id: 'not_between', label: 'not between', arity: 2, families: ['number', 'date', 'text'] },
  { id: 'in', label: 'in list', arity: 'list', families: ALL },
  { id: 'not_in', label: 'not in list', arity: 'list', families: ALL },
  { id: 'is_null', label: 'is NULL', arity: 0, families: ALL },
  { id: 'is_not_null', label: 'is not NULL', arity: 0, families: ALL },
  { id: 'is_empty', label: 'is empty', arity: 0, families: ['text'] },
  { id: 'is_not_empty', label: 'is not empty', arity: 0, families: ['text'] },
  { id: 'is_true', label: 'is true', arity: 0, families: ['boolean'] },
  { id: 'is_false', label: 'is false', arity: 0, families: ['boolean'] },
  { id: 'regex', label: 'matches regex', arity: 1, families: ['text', 'other'] },
  { id: 'not_regex', label: 'does not match regex', arity: 1, families: ['text', 'other'] },
  { id: 'today', label: 'is today', arity: 0, families: ['date'] },
  { id: 'yesterday', label: 'is yesterday', arity: 0, families: ['date'] },
  { id: 'last_n_days', label: 'in last N days', arity: 1, families: ['date'] },
  { id: 'this_week', label: 'this week', arity: 0, families: ['date'] },
  { id: 'this_month', label: 'this month', arity: 0, families: ['date'] },
  { id: 'this_year', label: 'this year', arity: 0, families: ['date'] },
]

export function columnFamily(dataType: string): ColumnFamily {
  const t = dataType.toLowerCase()
  if (/^(bool|boolean|bit)$/.test(t) || t === 'tinyint(1)') return 'boolean'
  if (/(int|serial|numeric|decimal|float|double|real|money|number)/.test(t)) return 'number'
  if (/(date|time|year)/.test(t)) return 'date'
  if (/(char|text|string|clob|uuid|uniqueidentifier|citext|enum|name|xml|json)/.test(t)) return 'text'
  return 'other'
}

/** Accumulates positional parameters while rendering SQL. */
export class ParamCollector {
  readonly values: unknown[] = []
  constructor(private readonly dialect: Dialect) {}
  add(value: unknown): string {
    this.values.push(value)
    return this.dialect.placeholder(this.values.length)
  }
}

const LIKE_ESCAPE = '!'

function escapeLike(value: string, dialect: Dialect): string {
  let escaped = value.replace(/[!%_]/g, (ch) => LIKE_ESCAPE + ch)
  // T-SQL also treats [ as a pattern character.
  if (dialect.id === 'mssql') escaped = escaped.replace(/\[/g, LIKE_ESCAPE + '[')
  return escaped
}

function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function dateRange(op: FilterOperator, value: string | undefined, now: Date): [string, string] | null {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
  switch (op) {
    case 'today':
      return [isoDate(day), isoDate(addDays(day, 1))]
    case 'yesterday':
      return [isoDate(addDays(day, -1)), isoDate(day)]
    case 'last_n_days': {
      const n = Number.parseInt(value ?? '', 10)
      if (!Number.isFinite(n) || n < 0) throw new FilterError(`"${value}" is not a valid number of days`)
      return [isoDate(addDays(day, -n)), isoDate(addDays(day, 1))]
    }
    case 'this_week': {
      // ISO week, Monday first.
      const monday = addDays(day, -((day.getDay() + 6) % 7))
      return [isoDate(monday), isoDate(addDays(monday, 7))]
    }
    case 'this_month':
      return [
        isoDate(new Date(day.getFullYear(), day.getMonth(), 1)),
        isoDate(new Date(day.getFullYear(), day.getMonth() + 1, 1)),
      ]
    case 'this_year':
      return [isoDate(new Date(day.getFullYear(), 0, 1)), isoDate(new Date(day.getFullYear() + 1, 0, 1))]
    default:
      return null
  }
}

export class FilterError extends Error {
  override name = 'FilterError'
}

export interface RenderFilterOptions {
  /** Restrict conditions to known columns (prevents typos from becoming SQL errors). */
  columns?: string[]
  now?: Date
}

function renderCondition(
  c: FilterCondition,
  dialect: Dialect,
  params: ParamCollector,
  opts: RenderFilterOptions,
): string | null {
  if (opts.columns && !opts.columns.includes(c.column)) throw new FilterError(`Unknown column "${c.column}"`)
  const col = dialect.quoteIdent(c.column)
  const value = c.value ?? ''
  const like = (pattern: string, negate: boolean) =>
    `${dialect.castToText(col)} ${negate ? 'NOT ' : ''}${dialect.ilike} ${params.add(pattern)} ESCAPE '${LIKE_ESCAPE}'`

  switch (c.operator) {
    case 'eq':
      return `${col} = ${params.add(value)}`
    case 'neq':
      return `(${col} <> ${params.add(value)} OR ${col} IS NULL)`
    case 'gt':
      return `${col} > ${params.add(value)}`
    case 'gte':
      return `${col} >= ${params.add(value)}`
    case 'lt':
      return `${col} < ${params.add(value)}`
    case 'lte':
      return `${col} <= ${params.add(value)}`
    case 'contains':
      return like(`%${escapeLike(value, dialect)}%`, false)
    case 'not_contains':
      return `(${like(`%${escapeLike(value, dialect)}%`, true)} OR ${col} IS NULL)`
    case 'starts_with':
      return like(`${escapeLike(value, dialect)}%`, false)
    case 'ends_with':
      return like(`%${escapeLike(value, dialect)}`, false)
    case 'between':
    case 'not_between':
      return `${col} ${c.operator === 'not_between' ? 'NOT ' : ''}BETWEEN ${params.add(value)} AND ${params.add(c.value2 ?? '')}`
    case 'in':
    case 'not_in': {
      const values = (c.values ?? []).filter((v) => v !== '')
      if (values.length === 0) return c.operator === 'in' ? '1 = 0' : null
      const list = values.map((v) => params.add(v)).join(', ')
      return c.operator === 'in' ? `${col} IN (${list})` : `(${col} NOT IN (${list}) OR ${col} IS NULL)`
    }
    case 'is_null':
      return `${col} IS NULL`
    case 'is_not_null':
      return `${col} IS NOT NULL`
    case 'is_empty':
      return `(${col} IS NULL OR ${dialect.castToText(col)} = '')`
    case 'is_not_empty':
      return `(${col} IS NOT NULL AND ${dialect.castToText(col)} <> '')`
    case 'is_true':
      return `${col} = ${dialect.trueLiteral}`
    case 'is_false':
      return `${col} = ${dialect.falseLiteral}`
    case 'regex':
    case 'not_regex': {
      const sql = dialect.regex(col, params.add(value), c.operator === 'not_regex')
      if (!sql) throw new FilterError(`Regular expressions are not supported by ${dialect.sqlFlavor}`)
      return sql
    }
    case 'today':
    case 'yesterday':
    case 'last_n_days':
    case 'this_week':
    case 'this_month':
    case 'this_year': {
      const range = dateRange(c.operator, c.value, opts.now ?? new Date())!
      return `(${col} >= ${params.add(range[0])} AND ${col} < ${params.add(range[1])})`
    }
  }
}

function renderNode(
  node: FilterNode,
  dialect: Dialect,
  params: ParamCollector,
  opts: RenderFilterOptions,
): string | null {
  if (node.enabled === false) return null
  if (node.kind === 'raw') return node.sql.trim() ? `(${node.sql.trim()})` : null
  if (node.kind === 'condition') return renderCondition(node, dialect, params, opts)
  const parts = node.children
    .map((child) => renderNode(child, dialect, params, opts))
    .filter((p): p is string => p !== null)
  if (parts.length === 0) return null
  const joined = parts.length === 1 ? parts[0]! : `(${parts.join(node.combinator === 'and' ? ' AND ' : ' OR ')})`
  return node.negate ? `NOT ${joined.startsWith('(') ? joined : `(${joined})`}` : joined
}

/** Renders a filter tree to a SQL boolean expression (without the WHERE keyword), or null when empty. */
export function renderFilter(
  node: FilterNode | undefined,
  dialect: Dialect,
  params: ParamCollector,
  opts: RenderFilterOptions = {},
): string | null {
  return node ? renderNode(node, dialect, params, opts) : null
}

export interface SortSpec {
  column: string
  direction: 'asc' | 'desc'
}

export interface SelectSpec {
  table: TableRef
  columns?: string[]
  filter?: FilterNode
  sort?: SortSpec[]
  limit: number
  offset?: number
  /** Known column names, used to validate filters and sorts. */
  knownColumns?: string[]
  now?: Date
}

export interface BuiltQuery {
  sql: string
  params: unknown[]
}

export function buildSelect(spec: SelectSpec, dialect: Dialect): BuiltQuery {
  const params = new ParamCollector(dialect)
  const cols = spec.columns?.length ? spec.columns.map((c) => dialect.quoteIdent(c)).join(', ') : '*'
  let sql = `SELECT ${cols} FROM ${qualify(dialect, spec.table)}`
  const where = renderFilter(spec.filter, dialect, params, { columns: spec.knownColumns, now: spec.now })
  if (where) sql += ` WHERE ${where}`
  const sort = spec.sort ?? []
  for (const s of sort) {
    if (spec.knownColumns && !spec.knownColumns.includes(s.column))
      throw new FilterError(`Unknown sort column "${s.column}"`)
  }
  if (sort.length) {
    sql += ` ORDER BY ${sort.map((s) => `${dialect.quoteIdent(s.column)} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`).join(', ')}`
  }
  sql = dialect.paginate(sql, spec.limit, spec.offset ?? 0, sort.length > 0)
  return { sql, params: params.values }
}

export function buildCount(
  spec: Pick<SelectSpec, 'table' | 'filter' | 'knownColumns' | 'now'>,
  dialect: Dialect,
): BuiltQuery {
  const params = new ParamCollector(dialect)
  let sql = `SELECT COUNT(*) AS count FROM ${qualify(dialect, spec.table)}`
  const where = renderFilter(spec.filter, dialect, params, { columns: spec.knownColumns, now: spec.now })
  if (where) sql += ` WHERE ${where}`
  return { sql, params: params.values }
}

let idCounter = 0
export function newFilterId(): string {
  idCounter += 1
  return `f${Date.now().toString(36)}${idCounter.toString(36)}`
}

export function emptyFilterGroup(): FilterGroup {
  return { kind: 'group', id: newFilterId(), combinator: 'and', children: [] }
}

/** Counts active leaf conditions — used for the "Filters (3)" badge. */
export function countActiveConditions(node: FilterNode | undefined): number {
  if (!node || node.enabled === false) return 0
  if (node.kind !== 'group') return node.kind === 'raw' && !node.sql.trim() ? 0 : 1
  return node.children.reduce((n, c) => n + countActiveConditions(c), 0)
}

import { qualify, type Dialect } from './dialect.js'
import { ParamCollector, renderFilter, type BuiltQuery, type FilterNode } from './filters.js'
import type { CellValue, TableInfo, TableRef } from './types.js'

/** How many of the most common values a profile lists. */
export const PROFILE_TOP = 10

export interface ColumnProfile {
  /** Rows (with the filter). */
  total: number
  /** Rows where the column is not NULL. */
  filled: number
  /** Unset where the database can't compare the type (PostgreSQL json, SQL Server text). */
  distinct?: number
  min?: CellValue
  max?: CellValue
  top: { value: CellValue; count: number }[]
}

export interface ProfileQueries {
  counts: BuiltQuery
  distinct: BuiltQuery
  range: BuiltQuery
  top: BuiltQuery
}

/** The aggregate queries of a column profile, each with the table tab's filter. */
export function profileQueries(table: TableRef, column: string, filter: FilterNode | undefined, dialect: Dialect, info?: Pick<TableInfo, 'columns'>): ProfileQueries {
  if (info && !info.columns.some((c) => c.name === column)) throw new Error(`Unknown column "${column}"`)
  const c = dialect.quoteIdent(column)
  const from = qualify(dialect, table)
  const knownColumns = info?.columns.map((x) => x.name)
  const columnTypes = info && Object.fromEntries(info.columns.map((x) => [x.name, x.dataType]))
  const build = (select: string, tail = ''): BuiltQuery => {
    const params = new ParamCollector(dialect)
    const where = renderFilter(filter, dialect, params, { columns: knownColumns, columnTypes })
    return { sql: `SELECT ${select} FROM ${from}${where ? ` WHERE ${where}` : ''}${tail}`, params: params.values }
  }
  const top = build(`${c} AS value, COUNT(*) AS n`, ` GROUP BY ${c} ORDER BY COUNT(*) DESC`)
  return {
    counts: build(`COUNT(*) AS total, COUNT(${c}) AS filled`),
    distinct: build(`COUNT(DISTINCT ${c}) AS n`),
    range: build(`MIN(${c}) AS lo, MAX(${c}) AS hi`),
    top: { sql: dialect.paginate(top.sql, PROFILE_TOP, 0, true), params: top.params },
  }
}

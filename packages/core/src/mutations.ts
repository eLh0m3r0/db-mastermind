import { qualify, type Dialect } from './dialect.js'
import { ParamCollector, type BuiltQuery } from './filters.js'
import type { TableRef } from './types.js'

/** Values coming from the editor: text, NULL, or the DEFAULT keyword. */
export type EditValue = string | number | boolean | null | { $default: true }

export type RowChange =
  | { type: 'update'; key: Record<string, EditValue>; values: Record<string, EditValue> }
  | { type: 'insert'; values: Record<string, EditValue> }
  | { type: 'delete'; key: Record<string, EditValue> }

export class MutationError extends Error {
  override name = 'MutationError'
}

const isDefault = (v: EditValue): v is { $default: true } => typeof v === 'object' && v !== null

function valueSql(v: EditValue, params: ParamCollector): string {
  if (v === null) return 'NULL'
  if (isDefault(v)) return 'DEFAULT'
  return params.add(v)
}

function whereKey(key: Record<string, EditValue>, dialect: Dialect, params: ParamCollector): string {
  const entries = Object.entries(key)
  if (entries.length === 0) throw new MutationError('Refusing to change a row without a key')
  return entries
    .map(([col, v]) =>
      v === null ? `${dialect.quoteIdent(col)} IS NULL` : `${dialect.quoteIdent(col)} = ${valueSql(v, params)}`,
    )
    .join(' AND ')
}

/** One parameterized statement per change, in the order given. */
export function buildChangeStatements(table: TableRef, changes: RowChange[], dialect: Dialect): BuiltQuery[] {
  const target = qualify(dialect, table)
  return changes.map((change) => {
    const params = new ParamCollector(dialect)
    switch (change.type) {
      case 'insert': {
        const cols = Object.keys(change.values)
        if (cols.length === 0) {
          return {
            sql: dialect.id === 'mysql' || dialect.id === 'mariadb' ? `INSERT INTO ${target} () VALUES ()` : `INSERT INTO ${target} DEFAULT VALUES`,
            params: [],
          }
        }
        const values = cols.map((c) => valueSql(change.values[c]!, params))
        return {
          sql: `INSERT INTO ${target} (${cols.map((c) => dialect.quoteIdent(c)).join(', ')}) VALUES (${values.join(', ')})`,
          params: params.values,
        }
      }
      case 'update': {
        const cols = Object.keys(change.values)
        if (cols.length === 0) throw new MutationError('Update without changed columns')
        const set = cols.map((c) => `${dialect.quoteIdent(c)} = ${valueSql(change.values[c]!, params)}`).join(', ')
        return { sql: `UPDATE ${target} SET ${set} WHERE ${whereKey(change.key, dialect, params)}`, params: params.values }
      }
      case 'delete':
        return { sql: `DELETE FROM ${target} WHERE ${whereKey(change.key, dialect, params)}`, params: params.values }
    }
  })
}

/** Renders a parameterized query with inlined literals — for previews only, never for execution. */
export function inlineParams(query: BuiltQuery, dialect: Dialect): string {
  const literal = (v: unknown): string => {
    if (v === null || v === undefined) return 'NULL'
    if (typeof v === 'number') return String(v)
    if (typeof v === 'boolean') return v ? dialect.trueLiteral : dialect.falseLiteral
    const text = String(v).replaceAll("'", "''")
    return dialect.id === 'mssql' ? `N'${text}'` : `'${text}'`
  }
  if (dialect.placeholder(1) === '?') {
    let i = 0
    return query.sql.replace(/\?/g, () => literal(query.params[i++]))
  }
  const pattern = dialect.id === 'mssql' || dialect.id === 'bigquery' ? /@p(\d+)/g : dialect.id === 'oracle' ? /:(\d+)/g : dialect.id === 'clickhouse' ? /\{__p(\d+)\}/g : /\$(\d+)/g
  return query.sql.replace(pattern, (_, n: string) => literal(query.params[Number(n) - 1]))
}

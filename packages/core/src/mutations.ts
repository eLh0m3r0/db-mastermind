import { qualify, type Dialect } from './dialect.js'
import { ParamCollector, type BuiltQuery } from './filters.js'
import type { DriverId, TableRef } from './types.js'

/** Values coming from the editor: text, NULL, the DEFAULT keyword, or an SQL expression the user typed (`now()`). */
export type EditValue = string | number | boolean | null | { $default: true } | { $sql: string }

export type RowChange =
  | { type: 'update'; key: Record<string, EditValue>; values: Record<string, EditValue> }
  | { type: 'insert'; values: Record<string, EditValue> }
  | { type: 'delete'; key: Record<string, EditValue> }

export class MutationError extends Error {
  override name = 'MutationError'
}

const isDefault = (v: EditValue): v is { $default: true } => typeof v === 'object' && v !== null && '$default' in v
const isExpression = (v: EditValue): v is { $sql: string } => typeof v === 'object' && v !== null && '$sql' in v

/**
 * An SQL expression for a cell must stay one expression inside its parentheses: no statement separator or comment
 * outside its string literals (a T-SQL batch would run a second statement; `1) --` would comment out the WHERE) and
 * balanced parentheses (`1), other = (2` would change another column). Where the database would read the text
 * differently from this check (backslash escapes in MySQL strings and PostgreSQL E'' strings, PostgreSQL $$ quoting,
 * Oracle q'' quoting), the expression is refused rather than guessed.
 */
export function checkCellExpression(expression: string, driver?: DriverId): string | null {
  if (!expression.trim()) return 'Type an expression, e.g. now()'
  // One line: a line comment the check misread could otherwise end on the next line, with the rest as code.
  if (/[\r\n\u2028\u2029]/.test(expression)) return 'An expression is one line'
  if (/\\/.test(expression)) return 'No backslashes in an expression'
  // $tag$…$tag$ quoting (PostgreSQL, DuckDB, ClickHouse).
  if (/\$[A-Za-z_0-9]*\$/.test(expression)) return 'No dollar-quoted text in an expression'
  // Oracle q'…' / nq'…' (a name is never directly followed by a quote in valid SQL, so any q' is refused).
  if (/[qQ]'/.test(expression)) return "No q'…' quoting in an expression"
  // BigQuery '''…''' and """…""" strings.
  if ((driver === undefined || driver === 'bigquery') && /'''|"""/.test(expression)) return 'No triple-quoted text in an expression'
  // Quoted text and identifiers out: 'it''s' and "name" everywhere, [name] in SQL Server, `name` where it quotes.
  const backticks = driver === 'mysql' || driver === 'mariadb' || driver === 'sqlite' || driver === 'clickhouse' || driver === 'bigquery'
  const quoted = driver === 'mssql' ? /'(?:[^']|'')*'|"(?:[^"]|"")*"|\[[^\]]*\]/g : backticks ? /'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`/g : /'(?:[^']|'')*'|"(?:[^"]|"")*"/g
  const bare = expression.replace(quoted, '_')
  if (/['"`]/.test(bare) || (driver === 'mssql' && /[[\]]/.test(bare))) return 'A quote or bracket is not closed'
  if (/;/.test(bare)) return 'One expression only: no semicolons'
  // `#` starts a comment everywhere but PostgreSQL and DuckDB (operators there); `//` in ClickHouse.
  if (/--|\/\*|\*\/|\/\//.test(bare) || (driver !== 'postgres' && driver !== 'duckdb' && /#/.test(bare))) return 'No comments in an expression'
  let depth = 0
  for (const ch of bare) {
    if (ch === '(') depth++
    else if (ch === ')' && --depth < 0) return 'The parentheses do not match'
  }
  return depth === 0 ? null : 'The parentheses do not match'
}

function valueSql(v: EditValue, params: ParamCollector, driver?: DriverId): string {
  if (v === null) return 'NULL'
  if (isDefault(v)) return 'DEFAULT'
  if (isExpression(v)) {
    const problem = checkCellExpression(v.$sql, driver)
    if (problem) throw new MutationError(problem)
    return `(${v.$sql.trim()})`
  }
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
        const values = cols.map((c) => valueSql(change.values[c]!, params, dialect.id))
        return {
          sql: `INSERT INTO ${target} (${cols.map((c) => dialect.quoteIdent(c)).join(', ')}) VALUES (${values.join(', ')})`,
          params: params.values,
        }
      }
      case 'update': {
        const cols = Object.keys(change.values)
        if (cols.length === 0) throw new MutationError('Update without changed columns')
        const set = cols.map((c) => `${dialect.quoteIdent(c)} = ${valueSql(change.values[c]!, params, dialect.id)}`).join(', ')
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
  const pattern = dialect.id === 'mssql' || dialect.id === 'bigquery' ? /@p(\d+)/g : dialect.id === 'oracle' ? /:(\d+)/g : dialect.id === 'clickhouse' || dialect.id === 'trino' ? /\{__p(\d+)\}/g : /\$(\d+)/g
  return query.sql.replace(pattern, (_, n: string) => literal(query.params[Number(n) - 1]))
}

/**
 * For a grid UPDATE / DELETE (`… WHERE <key>`, built by buildChangeStatements): a SELECT … FOR UPDATE WAIT of the
 * same rows. The key's placeholders come last; Oracle binds by position, so they take the last parameters.
 */
export function lockRowsFirst(statement: BuiltQuery, seconds: number): BuiltQuery | undefined {
  const m = /^(?:UPDATE\s+(.+?)\s+SET\s|DELETE\s+FROM\s+(.+?)\s+WHERE\s)/s.exec(statement.sql)
  const at = statement.sql.lastIndexOf(' WHERE ')
  if (!m || at < 0) return undefined
  const condition = statement.sql.slice(at + 7)
  // Placeholders outside quoted identifiers (a column may be named "K:9").
  const used = condition.replace(/"(?:[^"]|"")*"/g, '').match(/:\d+/g)?.length ?? 0
  return { sql: `SELECT 1 FROM ${m[1] ?? m[2]} WHERE ${condition} FOR UPDATE WAIT ${seconds}`, params: used ? statement.params.slice(-used) : [] }
}

import { familyOf, lex, type LexModes } from './sql-lexer.js'
import type { DriverId } from './types.js'

/**
 * The one way a value becomes SQL text (data-compare sync scripts, Copy as SQL INSERT, SQL exports, the grid's
 * review SQL and audit text, ClickHouse's and Trino's own parameter inlining): a literal the target database reads
 * back as exactly that value. Strings are written per dialect as sql-lexer.ts reads them (MySQL / MariaDB with
 * backslash escapes unless the session's sql_mode has NO_BACKSLASH_ESCAPES; ClickHouse and BigQuery with
 * backslash escapes; the others by doubling quotes, SQL Server as N''); characters a dialect's string can't hold
 * (NUL, and for SQL Server / Oracle / SQLite / DuckDB / Trino a NUL only) are joined in with the database's own
 * character function; a value no literal can carry (NUL in PostgreSQL text, NaN where there is none) is an error,
 * never a changed value.
 *
 * Values: null → NULL, numbers and bigints as numbers, booleans as the dialect's literal, Dates as ISO text, binary
 * ({ $binary: hex }) as the dialect's binary literal, objects and arrays as their JSON text.
 */
export function sqlValue(value: unknown, driver: DriverId | string, modes: LexModes = {}): string {
  const family = familyOf(driver)
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') return numberLiteral(value, driver)
  if (typeof value === 'boolean') return booleanLiteral(value, driver)
  if (value instanceof Date) {
    const iso = value.toISOString()
    if (family === 'clickhouse') return `'${iso.replace('T', ' ').replace('Z', '')}'`
    if (family === 'trino') return `TIMESTAMP '${iso.replace('T', ' ').replace('Z', '')}'`
    return stringValue(iso, driver, modes)
  }
  if (typeof value === 'object' && value && '$binary' in value && typeof (value as { $binary: unknown }).$binary === 'string') {
    const { $binary, length } = value as { $binary: string; length?: number }
    // (A cell holds the first 4 KB of a long binary value only: never write the shortened one as if it were all.)
    if (length !== undefined && length * 2 !== $binary.length) throw new Error(`A binary value of ${length} bytes is shown only in part, so it can't be written as SQL`)
    return binaryLiteral($binary, driver)
  }
  if (Array.isArray(value)) {
    if (family === 'clickhouse') return `[${value.map((v) => sqlValue(v, driver, modes)).join(', ')}]`
    if (family === 'trino') return `ARRAY[${value.map((v) => sqlValue(v, driver, modes)).join(', ')}]`
    // PostgreSQL: the array's text form ({"a","b"}), which an array column reads.
    if (driver === 'postgres') return stringValue(pgArrayText(value), driver, modes)
  }
  if (typeof value === 'object') return stringValue(JSON.stringify(value), driver, modes)
  return stringValue(String(value), driver, modes)
}

function pgArrayText(items: unknown[]): string {
  return `{${items.map((v) => (v === null || v === undefined ? 'NULL' : Array.isArray(v) ? pgArrayText(v) : `"${String(typeof v === 'object' ? JSON.stringify(v) : v).replace(/[\\"]/g, '\\$&')}"`)).join(',')}}`
}

function numberLiteral(n: number, driver: DriverId | string): string {
  // (Oracle's NUMBER literals stop at 1e126 and 1e-130: beyond them a BINARY_DOUBLE literal, with its d.)
  if (Number.isFinite(n) && familyOf(driver) === 'oracle' && n !== 0 && (Math.abs(n) >= 1e125 || Math.abs(n) < 1e-129)) return `${n}d`
  if (Number.isFinite(n)) return Object.is(n, -0) ? '0' : String(n)
  const name = Number.isNaN(n) ? 'NaN' : n > 0 ? 'Infinity' : '-Infinity'
  switch (familyOf(driver)) {
    case 'postgres':
      return `'${name}'`
    case 'clickhouse':
      return Number.isNaN(n) ? 'nan' : n > 0 ? 'inf' : '-inf'
    case 'oracle':
      return Number.isNaN(n) ? 'BINARY_DOUBLE_NAN' : n > 0 ? 'BINARY_DOUBLE_INFINITY' : '-BINARY_DOUBLE_INFINITY'
    case 'bigquery':
      return `CAST('${Number.isNaN(n) ? 'NaN' : n > 0 ? 'inf' : '-inf'}' AS FLOAT64)`
    case 'trino':
      return Number.isNaN(n) ? 'nan()' : n > 0 ? 'infinity()' : '-infinity()'
    default:
      throw new Error(`${driver} has no literal for ${name}`)
  }
}

function booleanLiteral(b: boolean, driver: DriverId | string): string {
  switch (familyOf(driver)) {
    case 'mssql':
    case 'oracle':
    case 'mysql':
    case 'sqlite':
      return b ? '1' : '0'
    case 'clickhouse':
    case 'trino':
      return b ? 'true' : 'false'
    default:
      return b ? 'TRUE' : 'FALSE'
  }
}

function binaryLiteral(hex: string, driver: DriverId | string): string {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2) throw new Error('A binary value that is not hexadecimal')
  switch (driver) {
    case 'postgres':
    case 'cockroachdb':
      return `'\\x${hex}'::bytea`
    case 'duckdb':
      // (A blob literal of escaped bytes: DuckDB's unhex gives text, which a blob column would read escapes in.)
      return `'${hex.replace(/../g, (b) => `\\x${b.toUpperCase()}`)}'::BLOB`
    case 'mssql':
      return `0x${hex}`
    case 'oracle':
      return hex ? `HEXTORAW('${hex}')` : 'EMPTY_BLOB()'
    case 'clickhouse':
      return `unhex('${hex}')`
    case 'bigquery':
      return `FROM_HEX('${hex}')`
    default:
      // MySQL, MariaDB, SQLite, Trino.
      return `X'${hex}'`
  }
}

/** A string as the target reads it back exactly. */
export function stringValue(text: string, driver: DriverId | string, modes: LexModes = {}): string {
  const family = familyOf(driver)
  switch (family) {
    case 'mysql':
      if (modes.noBackslashEscapes) return joinWithChar(text, (s) => `'${s.replaceAll("'", "''")}'`, (c) => `CHAR(${c.codePointAt(0)} USING utf8mb4)`, (parts) => `CONCAT(${parts.join(', ')})`, /\u0000/)
      return `'${text.replaceAll('\\', '\\\\').replaceAll('\u0000', '\\0').replaceAll("'", "''")}'`
    case 'clickhouse':
      return `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\u0000', '\\0').replaceAll('\n', '\\n').replaceAll('\r', '\\r')}'`
    case 'bigquery':
      return `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r').replace(/[\u0000-\u001f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}'`
    case 'postgres':
      if (driver === 'duckdb') return joinWithChar(text, (s) => `'${s.replaceAll("'", "''")}'`, () => 'chr(0)', (parts) => `concat(${parts.join(', ')})`, /\u0000/)
      if (text.includes('\u0000')) throw new Error("PostgreSQL text can't hold a NUL character")
      return `'${text.replaceAll("'", "''")}'`
    case 'mssql':
      // (T-SQL drops a backslash-newline inside a string, a line continuation: that line break is joined in.)
      // (CONCAT takes 254 arguments; the first is nvarchar(max), or the result would stop at 4000 characters.)
      return joinWithChar(text, (s) => `N'${s.replaceAll("'", "''")}'`, (c) => `NCHAR(${c.charCodeAt(0)})`, (parts) => mssqlConcat(['CAST(N\'\' AS nvarchar(max))', ...parts]), (c, prev) => c === '\u0000' || ((c === '\n' || c === '\r') && prev === '\\'))
    case 'oracle': {
      // (A literal holds at most 4000 bytes: longer text is joined from pieces as a CLOB.)
      const piece = (s: string) => joinWithChar(s, (x) => `'${x.replaceAll("'", "''")}'`, () => 'CHR(0)', (parts) => parts.join(' || '), /\u0000/)
      if (text.length <= 1000) return piece(text)
      const parts: string[] = []
      for (let i = 0; i < text.length; i += 1000) parts.push(`TO_CLOB(${piece(text.slice(i, i + 1000))})`)
      return parts.join(' || ')
    }
    case 'sqlite':
      // (SQLite's string functions stop at a NUL: such text is written as its UTF-8 bytes.)
      return text.includes('\u0000') ? `CAST(X'${Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join('')}' AS TEXT)` : `'${text.replaceAll("'", "''")}'`
    case 'trino':
      return joinWithChar(text, (s) => `'${s.replaceAll("'", "''")}'`, () => 'chr(0)', (parts) => `concat(${parts.join(', ')})`, /\u0000/)
  }
  return `'${text.replaceAll("'", "''")}'`
}

function mssqlConcat(parts: string[]): string {
  if (parts.length <= 250) return `CONCAT(${parts.join(', ')})`
  const groups: string[] = []
  for (let i = 0; i < parts.length; i += 249) groups.push(`CONCAT(CAST(N'' AS nvarchar(max)), ${parts.slice(i, i + 249).join(', ')})`)
  return mssqlConcat(groups)
}

/** Text with the characters `special` matches written by `char` and the rest as literals, joined by `join`. */
function joinWithChar(text: string, literal: (s: string) => string, char: (c: string) => string, join: (parts: string[]) => string, special: RegExp | ((c: string, prev: string) => boolean)): string {
  const is = typeof special === 'function' ? special : (c: string) => special.test(c)
  const parts: string[] = []
  let run = ''
  let prev = ''
  let any = false
  for (const c of text) {
    const hit = is(c, prev)
    prev = c
    if (hit) {
      any = true
      if (run) parts.push(literal(run))
      run = ''
      parts.push(char(c))
    } else run += c
  }
  if (!any) return literal(text)
  if (run) parts.push(literal(run))
  return parts.length === 1 ? parts[0]! : join(parts)
}

/**
 * A parameterized statement with its values written in (previews, scripts the user runs, ClickHouse's and Trino's
 * own inlining). Placeholders are found by position in the tokenizer's reading of the statement (never by searching
 * the text: a `?` or `$1` inside a string or a comment is not one), in the dialect's own style: `?`, `$n`, `@pN`,
 * `:N`, `{__pN}`.
 */
export function inlineValues(sql: string, params: readonly unknown[], driver: DriverId | string, modes: LexModes = {}): string {
  const lexed = lex(sql, driver, modes)
  if (!lexed.ok) throw new Error(`The statement could not be read (${lexed.reason}), so its values are not written into it.`)
  const tokens = lexed.tokens
  const family = familyOf(driver)
  const text = (k: number) => (tokens[k] ? sql.slice(tokens[k]!.start, tokens[k]!.end) : '')
  const adjacent = (k: number) => !!tokens[k + 1] && tokens[k + 1]!.start === tokens[k]!.end
  const value = (index: number) => {
    if (index < 0 || index >= params.length) throw new Error(`Missing value for parameter ${index + 1}`)
    return sqlValue(params[index], driver, modes)
  }
  let out = ''
  let at = 0
  let question = 0
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!
    if (t.kind !== 'param' && t.kind !== 'op' && t.kind !== 'word') continue
    const s = text(k)
    let index: number | undefined
    let end = k
    if (t.kind === 'param' && /^\$\d+$/.test(s) && family === 'postgres') index = Number(s.slice(1)) - 1
    else if (s === '?' && (t.kind === 'op' || t.kind === 'param') && (family === 'mysql' || family === 'sqlite')) index = question++
    else if (t.kind === 'word' && /^@p\d+$/i.test(s) && family === 'mssql') index = Number(s.slice(2)) - 1
    else if (s === '@' && adjacent(k) && /^p\d+$/i.test(text(k + 1)) && family === 'bigquery') {
      index = Number(text(k + 1).slice(1)) - 1
      end = k + 1
    } else if (s === ':' && adjacent(k) && tokens[k + 1]!.kind === 'number' && /^\d+$/.test(text(k + 1)) && family === 'oracle') {
      index = Number(text(k + 1)) - 1
      end = k + 1
    } else if (s === '{' && adjacent(k) && /^__p\d+$/.test(text(k + 1)) && adjacent(k + 1) && text(k + 2) === '}' && (family === 'clickhouse' || family === 'trino')) {
      index = Number(text(k + 1).slice(3)) - 1
      end = k + 2
    }
    if (index === undefined) continue
    out += sql.slice(at, t.start) + value(index)
    at = tokens[end]!.end
    k = end
  }
  return out + sql.slice(at)
}

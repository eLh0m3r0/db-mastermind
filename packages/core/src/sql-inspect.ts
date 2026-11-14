import { splitStatements } from './sql-split.js'
import type { DriverId, RoutineInfo, SchemaSnapshot, TableInfo } from './types.js'

/**
 * A light reading of SQL text for the editor: which names are tables (after FROM, JOIN, UPDATE, INTO), which are
 * CTEs and aliases, which are function calls. Not a parser: it only claims what it is sure of, so the warnings it
 * feeds never cry wolf.
 */

interface Token {
  kind: 'word' | 'quoted' | 'punct' | 'string' | 'number' | 'param'
  /** The name (unquoted) for words and quoted identifiers; the character for punctuation. */
  value: string
  start: number
  end: number
}

const IDENT_START = /[A-Za-z_À-￿#@]/
const IDENT_PART = /[A-Za-z0-9_$#@À-￿]/

function tokenize(sql: string, driver: DriverId, offset = 0): Token[] {
  const out: Token[] = []
  const n = sql.length
  let i = 0
  const push = (kind: Token['kind'], value: string, start: number, end: number) => out.push({ kind, value, start: start + offset, end: end + offset })
  while (i < n) {
    const ch = sql[i]!
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? n : nl
      continue
    }
    if (ch === '#' && (driver === 'mysql' || driver === 'mariadb')) {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? n : nl
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    if (ch === "'") {
      const start = i
      i++
      while (i < n) {
        if (sql[i] === '\\' && (driver === 'mysql' || driver === 'mariadb')) i += 2
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2
        else if (sql[i] === "'") break
        else i++
      }
      i++
      push('string', '', start, Math.min(i, n))
      continue
    }
    if (ch === '$' && (driver === 'postgres' || driver === 'duckdb')) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (m) {
        const close = sql.indexOf(m[0], i + m[0].length)
        const start = i
        i = close === -1 ? n : close + m[0].length
        push('string', '', start, i)
        continue
      }
      const p = /^\$\d+/.exec(sql.slice(i))
      if (p) {
        push('param', p[0], i, i + p[0].length)
        i += p[0].length
        continue
      }
    }
    const close = ch === '"' ? '"' : ch === '`' ? '`' : ch === '[' && driver === 'mssql' ? ']' : null
    if (close) {
      const start = i
      let value = ''
      i++
      while (i < n) {
        if (sql[i] === close && sql[i + 1] === close) {
          value += close
          i += 2
        } else if (sql[i] === close) break
        else value += sql[i++]
      }
      i++
      push('quoted', value, start, Math.min(i, n))
      continue
    }
    if (/[0-9]/.test(ch)) {
      const start = i
      while (i < n && /[0-9.eE]/.test(sql[i]!)) i++
      push('number', sql.slice(start, i), start, i)
      continue
    }
    if (ch === ':' && /[A-Za-z_]/.test(sql[i + 1] ?? '') && sql[i - 1] !== ':') {
      const start = i
      i++
      while (i < n && IDENT_PART.test(sql[i]!)) i++
      push('param', sql.slice(start, i), start, i)
      continue
    }
    if (IDENT_START.test(ch)) {
      const start = i
      while (i < n && IDENT_PART.test(sql[i]!)) i++
      push('word', sql.slice(start, i), start, i)
      continue
    }
    push('punct', ch, i, i + 1)
    i++
  }
  return out
}

const isName = (t: Token | undefined): t is Token => !!t && (t.kind === 'word' || t.kind === 'quoted')
const isWord = (t: Token | undefined, ...words: string[]) => !!t && t.kind === 'word' && words.includes(t.value.toUpperCase())
const isPunct = (t: Token | undefined, ch: string) => !!t && t.kind === 'punct' && t.value === ch

/** Words that can follow a table name and are not its alias. */
const NOT_ALIAS = new Set(
  'WHERE ON USING JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL GROUP ORDER HAVING LIMIT OFFSET FETCH UNION INTERSECT EXCEPT MINUS SET VALUES SELECT FROM WINDOW FOR WITH RETURNING OUTPUT AS TABLESAMPLE PIVOT UNPIVOT LATERAL APPLY OPTION INTO DEFAULT KEY STRAIGHT_JOIN USE IGNORE FORCE PARTITION CONNECT START QUALIFY'.split(' '),
)

export interface TableReference {
  /** The written parts: [name], [schema, name] or [catalog, schema, name]. */
  parts: string[]
  quoted: boolean[]
  start: number
  end: number
  /** Where the last part (the table's name) starts, for a fix that replaces it. */
  nameStart: number
  alias?: string
  /** After UPDATE (may name an alias of a later FROM, in T-SQL). */
  updateTarget?: boolean
}

export interface FunctionReference {
  parts: string[]
  start: number
  end: number
}

export interface ColumnReference {
  qualifier: string
  column: string
  quoted: boolean
  start: number
  end: number
}

export interface StatementReading {
  start: number
  end: number
  /** The first keyword (SELECT, UPDATE, …; WITH resolves to what follows the CTEs). */
  verb: string
  tables: TableReference[]
  functions: FunctionReference[]
  columns: ColumnReference[]
  /** CTE names, and tables / views the statement itself creates. */
  defines: string[]
  /** A WHERE outside parentheses (for UPDATE / DELETE). */
  hasWhere: boolean
  /** Range of the first keyword. */
  verbStart: number
  verbEnd: number
}

/** Reads a dotted name (a.b.c) starting at token `i`; returns it and the index after it. */
function readName(tokens: Token[], i: number): { parts: Token[]; next: number } | null {
  if (!isName(tokens[i])) return null
  const parts = [tokens[i]!]
  let j = i + 1
  while (isPunct(tokens[j], '.') && isName(tokens[j + 1]) && tokens[j]!.start === parts.at(-1)!.end && tokens[j + 1]!.start === tokens[j]!.end) {
    parts.push(tokens[j + 1]!)
    j += 2
  }
  return { parts, next: j }
}

function readStatement(text: string, start: number, driver: DriverId): StatementReading {
  const tokens = tokenize(text, driver, start)
  const reading: StatementReading = { start, end: start + text.length, verb: '', tables: [], functions: [], columns: [], defines: [], hasWhere: false, verbStart: start, verbEnd: start }
  // The verb: past a WITH clause's CTEs.
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (isPunct(t, '(')) depth++
    else if (isPunct(t, ')')) depth--
    else if (depth === 0 && t.kind === 'word' && (i === 0 || !isWord(tokens[0], 'WITH') || /^(SELECT|INSERT|UPDATE|DELETE|MERGE)$/i.test(t.value))) {
      if (i === 0 && isWord(t, 'WITH')) continue
      reading.verb = t.value.toUpperCase()
      reading.verbStart = t.start
      reading.verbEnd = t.end
      break
    }
  }
  // Each open parenthesis: does it hold a query (SELECT …), or an expression (EXTRACT(YEAR FROM d), TRIM(x FROM y))?
  const levels: boolean[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (isPunct(t, '(')) {
      levels.push(false)
      continue
    }
    if (isPunct(t, ')')) {
      levels.pop()
      continue
    }
    if (levels.length && isWord(t, 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'WITH', 'VALUES')) levels[levels.length - 1] = true
    const queryLevel = levels.length === 0 || levels.at(-1)!
    if (levels.length === 0 && isWord(t, 'WHERE')) reading.hasWhere = true
    // CTE: name [(columns)] AS (
    if (isName(t) && !isPunct(tokens[i - 1], '.')) {
      let j = i + 1
      if (isPunct(tokens[j], '(')) {
        let d = 0
        for (; j < tokens.length; j++) {
          if (isPunct(tokens[j], '(')) d++
          else if (isPunct(tokens[j], ')') && --d === 0) break
        }
        j++
      }
      if (isWord(tokens[j], 'AS') && (isPunct(tokens[j + 1], '(') || (isWord(tokens[j + 1], 'NOT', 'MATERIALIZED') && j > i + 0))) {
        if (isWord(tokens[i - 1], 'WITH', 'RECURSIVE') || isPunct(tokens[i - 1], ',')) reading.defines.push(t.value.toLowerCase())
      }
    }
    // CREATE [OR REPLACE] [TEMP] TABLE / VIEW name
    if (isWord(t, 'TABLE', 'VIEW') && tokens.slice(Math.max(0, i - 4), i).some((x) => isWord(x, 'CREATE'))) {
      let j = i + 1
      if (isWord(tokens[j], 'IF') && isWord(tokens[j + 1], 'NOT') && isWord(tokens[j + 2], 'EXISTS')) j += 3
      const name = readName(tokens, j)
      if (name) reading.defines.push(name.parts.at(-1)!.value.toLowerCase())
      continue
    }
    const intro = isWord(t, 'FROM', 'JOIN', 'UPDATE', 'INTO', 'APPLY')
    if (!intro || !queryLevel) continue
    if (isWord(t, 'FROM') && isWord(tokens[i - 1], 'DISTINCT')) continue
    // ON CONFLICT DO UPDATE SET, ON DUPLICATE KEY UPDATE, FOR UPDATE, MERGE … THEN UPDATE SET: no table follows.
    if (isWord(t, 'UPDATE') && (isWord(tokens[i - 1], 'DO', 'KEY', 'FOR', 'THEN') || isWord(tokens[i + 1], 'SET'))) continue
    // SELECT … INTO new_table (T-SQL, PostgreSQL) makes a table; INSERT INTO / MERGE INTO name an existing one.
    if (isWord(t, 'INTO') && !isWord(tokens[i - 1], 'INSERT', 'MERGE', 'REPLACE', 'IGNORE')) continue
    // Statements that never name an existing table there: CREATE TABLE … FROM? DROP … FROM? (none), DELETE alias FROM.
    const fromList = isWord(t, 'FROM')
    let j = i + 1
    for (;;) {
      while (isWord(tokens[j], 'ONLY', 'LATERAL')) j++
      if (isPunct(tokens[j], '(')) break
      const name = readName(tokens, j)
      if (!name) break
      j = name.next
      // A table function (generate_series(…), unnest(…)) or INSERT INTO t (columns).
      if (isPunct(tokens[j], '(') && !isWord(t, 'INTO', 'UPDATE')) break
      const ref: TableReference = {
        parts: name.parts.map((p) => p.value),
        quoted: name.parts.map((p) => p.kind === 'quoted'),
        start: name.parts[0]!.start,
        end: name.parts.at(-1)!.end,
        nameStart: name.parts.at(-1)!.start,
        ...(isWord(t, 'UPDATE') ? { updateTarget: true } : {}),
      }
      if (isPunct(tokens[j], '(') && isWord(t, 'INTO')) {
        reading.tables.push(ref)
        break
      }
      if (isWord(tokens[j], 'AS')) j++
      if (isName(tokens[j]) && !NOT_ALIAS.has(tokens[j]!.value.toUpperCase())) {
        ref.alias = tokens[j]!.value
        j++
      }
      reading.tables.push(ref)
      if (fromList && isPunct(tokens[j], ',')) {
        j++
        continue
      }
      break
    }
  }
  // Function calls and qualified columns.
  const tableSpans = new Set(reading.tables.flatMap((r) => tokens.filter((x) => x.start >= r.start && x.end <= r.end).map((x) => x.start)))
  for (let i = 0; i < tokens.length; i++) {
    if (tableSpans.has(tokens[i]!.start)) continue
    const name = readName(tokens, i)
    if (!name) continue
    const after = tokens[name.next]
    if (isPunct(after, '(') && name.parts[0]!.kind === 'word') {
      reading.functions.push({ parts: name.parts.map((p) => p.value), start: name.parts[0]!.start, end: name.parts.at(-1)!.end })
    } else if (name.parts.length === 2 && !isPunct(tokens[i - 1], '.') && !isPunct(after, '*')) {
      const [q, c] = name.parts
      reading.columns.push({ qualifier: q!.value, column: c!.value, quoted: c!.kind === 'quoted', start: c!.start, end: c!.end })
    }
    i = name.next - 1
  }
  return reading
}

/** Every statement of a script, read. */
export function readSql(script: string, driver: DriverId): StatementReading[] {
  return splitStatements(script, driver).map((s) => readStatement(s.text, s.start, driver))
}

const SYSTEM_NAME = /^(pg_|information_schema$|sys$|sysobjects$|dual$|sqlite_|duckdb_|system$|mysql$|performance_schema$|all_|user_|dba_|v\$|gv\$)/i

/**
 * Engines whose snapshot lists every table a statement can name: not BigQuery / Trino catalogs or ClickHouse, and not
 * Oracle (synonyms, and only the user's own schema is read).
 */
export const INSPECTED_DRIVERS: ReadonlySet<DriverId> = new Set(['postgres', 'mysql', 'mariadb', 'mssql', 'sqlite', 'duckdb'])

const lower = (s: string) => s.toLowerCase()

/** The snapshot's table a reference names, `null` when it surely names none, `undefined` when it can't tell. */
export function resolveTable(ref: Pick<TableReference, 'parts'>, schema: SchemaSnapshot): TableInfo | null | undefined {
  if (ref.parts.length > 2) return undefined
  const name = lower(ref.parts.at(-1)!)
  if (ref.parts.length === 2) {
    const s = lower(ref.parts[0]!)
    if (!schema.schemas.some((x) => lower(x) === s)) return undefined
    return schema.tables.find((t) => lower(t.schema ?? '') === s && lower(t.name) === name) ?? null
  }
  if (/^[#@]/.test(name) || SYSTEM_NAME.test(name)) return undefined
  return schema.tables.find((t) => lower(t.name) === name) ?? null
}

export type SqlWarning =
  | { kind: 'unknown-table'; from: number; to: number; name: string; suggestion?: string; replaceFrom: number }
  | { kind: 'unknown-column'; from: number; to: number; column: string; table: string; suggestion?: string }
  | { kind: 'no-where'; from: number; to: number; verb: 'UPDATE' | 'DELETE'; table: string }

function distance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array<number>(n).fill(0)])
  for (let j = 1; j <= n; j++) d[0]![j] = j
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[m]![n]!
}

/** The closest of `names` to `name` (a likely typo), if one is close enough. */
export function closestName(name: string, names: string[]): string | undefined {
  const target = lower(name)
  let best: string | undefined
  let bestDistance = Infinity
  for (const candidate of names) {
    const dist = distance(target, lower(candidate))
    if (dist < bestDistance) {
      best = candidate
      bestDistance = dist
    }
  }
  return best !== undefined && bestDistance > 0 && bestDistance <= Math.max(1, Math.floor(target.length / 4)) ? best : undefined
}

/**
 * What the editor underlines: tables that don't exist, `alias.column` where the table has no such column, and
 * UPDATE / DELETE without WHERE. Only what is certain (see `resolveTable`).
 */
export function inspectSql(script: string, driver: DriverId, schema: SchemaSnapshot | undefined): SqlWarning[] {
  const out: SqlWarning[] = []
  const statements = readSql(script, driver)
  const created = new Set<string>()
  for (const s of statements) {
    if ((s.verb === 'UPDATE' || s.verb === 'DELETE') && !s.hasWhere && s.tables.length) {
      const target = s.tables.find((t) => (s.verb === 'UPDATE' ? t.updateTarget : true)) ?? s.tables[0]!
      out.push({ kind: 'no-where', from: s.verbStart, to: s.verbEnd, verb: s.verb, table: target.parts.at(-1)! })
    }
    if (!schema || !INSPECTED_DRIVERS.has(driver)) {
      for (const d of s.defines) created.add(d)
      continue
    }
    const aliases = new Set(s.tables.map((t) => t.alias && lower(t.alias)).filter(Boolean) as string[])
    const known = (ref: TableReference) => created.has(lower(ref.parts.at(-1)!)) || s.defines.includes(lower(ref.parts.at(-1)!))
    const byQualifier = new Map<string, TableInfo | undefined>()
    for (const ref of s.tables) {
      const table = known(ref) ? undefined : resolveTable(ref, schema)
      // The same alias for two tables (in two subqueries): which one a column means is not certain.
      const name = (key: string) => (byQualifier.has(key) && byQualifier.get(key) !== (table ?? undefined) ? byQualifier.set(key, undefined) : byQualifier.set(key, table ?? undefined))
      if (ref.alias) name(lower(ref.alias))
      name(lower(ref.parts.at(-1)!))
      if (table !== null || known(ref)) continue
      // T-SQL: UPDATE o SET … FROM orders o names the alias.
      if (ref.updateTarget && ref.parts.length === 1 && aliases.has(lower(ref.parts[0]!))) continue
      const candidates = ref.parts.length === 2 ? schema.tables.filter((t) => lower(t.schema ?? '') === lower(ref.parts[0]!)).map((t) => t.name) : schema.tables.map((t) => t.name)
      out.push({ kind: 'unknown-table', from: ref.start, to: ref.end, name: ref.parts.join('.'), suggestion: closestName(ref.parts.at(-1)!, candidates), replaceFrom: ref.nameStart })
    }
    for (const c of s.columns) {
      const qualifier = lower(c.qualifier)
      if (!byQualifier.has(qualifier)) continue
      const table = byQualifier.get(qualifier)
      // Unknown or column-less (a view the driver couldn't describe): nothing to check against.
      if (!table || table.columns.length === 0) continue
      if (table.columns.some((col) => (c.quoted ? col.name === c.column : lower(col.name) === lower(c.column)))) continue
      out.push({ kind: 'unknown-column', from: c.start, to: c.end, column: c.column, table: table.name, suggestion: closestName(c.column, table.columns.map((col) => col.name)) })
    }
    for (const d of s.defines) created.add(d)
  }
  return out
}

export type SqlObjectAt = { kind: 'table'; table: TableInfo; from: number; to: number } | { kind: 'routine'; routine: RoutineInfo; schema?: string; name: string; from: number; to: number }

/** The table, view or routine named at `offset` (⌘-click in the editor), when the snapshot knows it. */
export function objectAt(script: string, offset: number, driver: DriverId, schema: SchemaSnapshot): SqlObjectAt | undefined {
  const s = readSql(script, driver).find((x) => offset >= x.start && offset <= x.end)
  if (!s) return undefined
  const ref = s.tables.find((t) => offset >= t.start && offset <= t.end)
  if (ref) {
    const table = resolveTable(ref, schema)
    return table ? { kind: 'table', table, from: ref.start, to: ref.end } : undefined
  }
  const fn = s.functions.find((f) => offset >= f.start && offset <= f.end)
  if (fn) {
    const name = lower(fn.parts.at(-1)!)
    const owner = fn.parts.length === 2 ? lower(fn.parts[0]!) : undefined
    const routine = schema.routines.find((r) => lower(r.name) === name && (owner === undefined || lower(r.schema ?? '') === owner))
    return routine ? { kind: 'routine', routine, schema: routine.schema, name: routine.name, from: fn.start, to: fn.end } : undefined
  }
  // alias.column or table.column → the table.
  const col = s.columns.find((c) => offset >= c.start - c.qualifier.length - 1 && offset <= c.end)
  if (col) {
    const ref2 = s.tables.find((t) => lower(t.alias ?? '') === lower(col.qualifier) || lower(t.parts.at(-1)!) === lower(col.qualifier))
    const table = ref2 ? resolveTable(ref2, schema) : undefined
    if (table) return { kind: 'table', table, from: col.start - col.qualifier.length - 1, to: col.end }
  }
  return undefined
}

/** Whether `sql` reads or changes `table` (after FROM, JOIN, UPDATE, INTO), as the snapshot resolves the names. */
export function mentionsTable(sql: string, driver: DriverId, schema: SchemaSnapshot, table: Pick<TableInfo, 'schema' | 'name'>): boolean {
  const same = (t: TableInfo | null | undefined) => !!t && t.name === table.name && (t.schema ?? '') === (table.schema ?? '')
  return readSql(sql, driver).some((s) => s.tables.some((ref) => same(resolveTable(ref, schema))))
}

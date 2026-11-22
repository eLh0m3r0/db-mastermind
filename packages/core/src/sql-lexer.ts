import type { DriverId } from './types.js'

/**
 * One total tokenizer per dialect family: every character of the input belongs to a token, or the input is refused
 * (fail closed). What the guards decide is decided on these tokens: where a string, a quoted name or a comment
 * starts and ends exactly as the server reads it. Checked against the servers themselves (sql-lexer.test.ts,
 * sql-differential.integration.test.ts):
 *
 * | dialect            | block comments                  | strings                                                   | quoted names           |
 * |--------------------|---------------------------------|-----------------------------------------------------------|------------------------|
 * | PostgreSQL, DuckDB | nest                            | '' doubling; E'' backslash escapes; U&'', B'', X'';        | "" (U&"")              |
 * |                    |                                 | $tag$…$tag$ (tag: letters incl. non-ASCII, digits, _)      |                        |
 * | MySQL, MariaDB     | don't nest; /*! and /*+ are CODE| '' and "" with backslash escapes (modes can turn them off) | `` (" with ANSI_QUOTES)|
 * | SQL Server         | nest                            | '' doubling, N''                                          | "" and [ ]] ]          |
 * | Oracle             | don't nest                      | '' doubling, q'[…]' / nq'…' alternative quoting           | "" (no escape)         |
 * | SQLite             | don't nest                      | '' doubling                                               | "" `` [ ]              |
 * | ClickHouse         | nest                            | '' with backslash escapes, heredoc $tag$…$tag$            | "" `` (backslashes)    |
 * | BigQuery           | refused inside a comment        | '' "" ''' """ with backslash escapes, r'' raw, b''        | `` (backslashes)       |
 * | Trino              | refused inside a comment        | '' doubling, U&'', X''                                    | ""                     |
 *
 * `#` starts a line comment in MySQL, ClickHouse and BigQuery; `--` everywhere (in MySQL only before a space or a
 * control character: `1--1` is one minus minus one there).
 */
export type TokenKind = 'space' | 'comment' | 'string' | 'ident' | 'word' | 'number' | 'param' | 'semicolon' | 'op' | 'code-open' | 'code-close'

export interface Token {
  kind: TokenKind
  start: number
  end: number
  /** A string's or quoted name's value, decoded (escapes and doubled quotes resolved). */
  value?: string
}

/** On failure, `tokens` are those read before `at`: what comes after can't be told apart. */
export type Lexed = { ok: true; tokens: Token[] } | { ok: false; at: number; reason: string; tokens: Token[] }

export interface LexModes {
  /** MySQL's ANSI_QUOTES: "…" is a name, not a string. */
  ansiQuotes?: boolean
  /** MySQL's NO_BACKSLASH_ESCAPES: a backslash in a string is an ordinary character. */
  noBackslashEscapes?: boolean
}

type Family = 'postgres' | 'mysql' | 'mssql' | 'oracle' | 'sqlite' | 'clickhouse' | 'bigquery' | 'trino'

export function familyOf(driver: DriverId | string): Family {
  switch (driver) {
    case 'postgres':
    case 'duckdb':
    case 'cockroachdb':
      return 'postgres'
    case 'mysql':
    case 'mariadb':
      return 'mysql'
    case 'mssql':
    case 'oracle':
    case 'sqlite':
    case 'clickhouse':
    case 'bigquery':
    case 'trino':
      return driver
    default:
      return 'postgres'
  }
}

const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v'
// Identifier characters: ASCII letters, digits, _ and $ (most servers), and anything beyond ASCII (servers read
// non-ASCII letters as identifier characters; anything else beyond ASCII is an error there, never a delimiter).
const isWordStart = (c: string) => /[A-Za-z_]/.test(c) || c.charCodeAt(0) > 127
const isWordChar = (c: string | undefined) => !!c && (/[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) > 127)

export function lex(sql: string, driver: DriverId | string, modes: LexModes = {}): Lexed {
  const family = familyOf(driver)
  const tokens: Token[] = []
  const n = sql.length
  let i = 0
  // Inside a MySQL /*! … */ or /*+ … */: its text is code, its */ closes it.
  let inCode = false
  const fail = (reason: string, at = i): Lexed => ({ ok: false, at, reason, tokens })
  const push = (kind: TokenKind, start: number, end: number, value?: string) => tokens.push(value === undefined ? { kind, start, end } : { kind, start, end, value })
  const nests = family === 'postgres' || family === 'mssql' || family === 'clickhouse'
  // (Servers end a C string at a NUL, or refuse it: anywhere in the text, it is not ours to guess.)
  const nul = sql.indexOf('\u0000')
  if (nul !== -1) return { ok: false, at: nul, reason: 'a NUL character', tokens: [] }

  /** A quoted run from `open` (index of the opening quote) to its closing `quote`; returns end and value or a failure. */
  const quoted = (open: number, quote: string, opts: { backslash: boolean; doubling: boolean; close?: string; raw?: boolean }): { end: number; value: string } | undefined => {
    const close = opts.close ?? quote
    let value = ''
    let j = open + 1
    while (j < n) {
      const c = sql[j]!
      if (opts.backslash && c === '\\') {
        if (j + 1 >= n) return undefined
        const e = sql[j + 1]!
        // (A raw string keeps both characters; the backslash still keeps the quote after it in.)
        value += opts.raw ? `\\${e}` : ({ n: '\n', t: '\t', r: '\r', b: '\b', '0': '\0', Z: '\x1a', f: '\f' }[e] ?? e)
        j += 2
        continue
      }
      if (c === close) {
        if (opts.doubling && sql[j + 1] === close) {
          value += close
          j += 2
          continue
        }
        return { end: j + 1, value }
      }
      value += c
      j++
    }
    return undefined
  }

  while (i < n) {
    const c = sql[i]!
    const next = sql[i + 1]
    if (c === '\u0000') return fail('a NUL character')
    if (isSpace(c)) {
      let j = i + 1
      while (j < n && isSpace(sql[j]!)) j++
      push('space', i, j)
      i = j
      continue
    }
    // Line comments.
    const dashes = c === '-' && next === '-' && (family !== 'mysql' || i + 2 >= n || sql.charCodeAt(i + 2) <= 32)
    if (dashes || (c === '#' && (family === 'mysql' || family === 'clickhouse' || family === 'bigquery'))) {
      if (inCode) return fail('a line comment inside a MySQL executable comment')
      let j = i
      while (j < n && sql[j] !== '\n' && sql[j] !== '\r') j++
      push('comment', i, j)
      i = j
      continue
    }
    // Block comments.
    if (c === '/' && next === '*') {
      if (inCode) return fail('a comment inside a MySQL executable comment')
      // MySQL runs what's inside /*! … */ and /*+ … */, MariaDB also /*M! … */: code, closed by the next */.
      const mariadbCode = sql[i + 2] === 'M' && sql[i + 3] === '!'
      if (family === 'mysql' && (sql[i + 2] === '!' || sql[i + 2] === '+' || mariadbCode)) {
        let j = i + (mariadbCode ? 4 : 3)
        if (sql[i + 2] === '!' || mariadbCode) while (j < n && /[0-9]/.test(sql[j]!)) j++
        push('code-open', i, j)
        inCode = true
        i = j
        continue
      }
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          if (nests) depth++
          else if (family === 'bigquery' || family === 'trino') return fail('a /* inside a comment', j)
          j += 2
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--
          j += 2
        } else j++
      }
      if (depth > 0) return fail('a /* comment that never closes')
      push('comment', i, j)
      i = j
      continue
    }
    if (c === '*' && next === '/' && inCode) {
      push('code-close', i, i + 2)
      inCode = false
      i += 2
      continue
    }
    // Dollar quotes (PostgreSQL, DuckDB, ClickHouse heredocs) and positional parameters.
    if (c === '$' && (family === 'postgres' || family === 'clickhouse') && !isWordChar(sql[i - 1])) {
      let j = i + 1
      if (next !== undefined && /[0-9]/.test(next)) {
        while (j < n && /[0-9]/.test(sql[j]!)) j++
        push('param', i, j)
        i = j
        continue
      }
      // The tag: an identifier without $ (letters beyond ASCII included), or nothing.
      if (j < n && isWordStart(sql[j]!)) while (j < n && sql[j] !== '$' && isWordChar(sql[j])) j++
      if (sql[j] === '$') {
        const tag = sql.slice(i, j + 1)
        const close = sql.indexOf(tag, j + 1)
        if (close === -1) return fail('a dollar-quoted string that never closes')
        push('string', i, close + tag.length, sql.slice(j + 1, close))
        i = close + tag.length
        continue
      }
      return fail('a $ that starts nothing this database knows')
    }
    // Prefixed strings: E'' U&'' B'' X'' N'' (PostgreSQL), N'' (SQL Server), q'' nq'' (Oracle), r'' b'' (BigQuery).
    const prefixed = /^(?:[EeBbXxNn]|[Uu]&|[Nn]?[Qq]|[Rr][Bb]?|[Bb][Rr]?)['"]/.exec(sql.slice(i, i + 4))
    if (prefixed && !isWordChar(sql[i - 1])) {
      const prefix = prefixed[0].slice(0, -1).toLowerCase()
      const q = prefixed[0].at(-1)!
      const open = i + prefix.length
      const allowed =
        family === 'postgres' ? /^(e|u&|b|x|n)$/.test(prefix) && q === "'" :
        family === 'mssql' ? prefix === 'n' && q === "'" :
        family === 'oracle' ? /^(n|q|nq)$/.test(prefix) && q === "'" :
        family === 'bigquery' ? /^(r|b|rb|br)$/.test(prefix) :
        family === 'trino' ? /^(u&|x)$/.test(prefix) && q === "'" :
        family === 'mysql' ? /^(n|b|x)$/.test(prefix) && q === "'" :
        family === 'sqlite' ? prefix === 'x' && q === "'" :
        family === 'clickhouse' ? false : false
      if (allowed) {
        if (family === 'oracle' && /q$/.test(prefix)) {
          // q'X…X': the delimiter after the quote, closed by its pair and a quote.
          const d = sql[open + 1]
          if (d === undefined || isSpace(d)) return fail("an Oracle q'' string without a delimiter")
          const closing = ({ '[': ']', '{': '}', '(': ')', '<': '>' } as Record<string, string>)[d] ?? d
          const end = sql.indexOf(`${closing}'`, open + 2)
          if (end === -1) return fail("an Oracle q'' string that never closes")
          push('string', i, end + 2, sql.slice(open + 2, end))
          i = end + 2
          continue
        }
        if (family === 'bigquery') {
          const raw = prefix.includes('r')
          const triple = sql.startsWith(q.repeat(3), open)
          const r = triple ? bigQueryTriple(sql, open, q, raw) : quoted(open, q, { backslash: true, doubling: false, raw })
          if (!r) return fail('a string that never closes')
          push('string', i, r.end, r.value)
          i = r.end
          continue
        }
        // E'' takes backslash escapes; the others double their quotes (U&'' escapes are decoded by the server, its
        // quote can't be escaped by a backslash).
        const r = quoted(open, "'", { backslash: prefix === 'e' || (family === 'mysql' && !modes.noBackslashEscapes), doubling: true })
        if (!r) return fail('a string that never closes')
        push('string', i, r.end, r.value)
        i = r.end
        continue
      }
    }
    if (c === "'") {
      const backslash = family === 'mysql' ? !modes.noBackslashEscapes : family === 'clickhouse' || family === 'bigquery'
      if (family === 'bigquery' && sql.startsWith("'''", i)) {
        const r = bigQueryTriple(sql, i, "'", false)
        if (!r) return fail('a string that never closes')
        push('string', i, r.end, r.value)
        i = r.end
        continue
      }
      const r = quoted(i, "'", { backslash, doubling: family !== 'bigquery' })
      if (!r) return fail('a string that never closes')
      push('string', i, r.end, r.value)
      i = r.end
      continue
    }
    if (c === '"') {
      if (family === 'bigquery') {
        const r = sql.startsWith('"""', i) ? bigQueryTriple(sql, i, '"', false) : quoted(i, '"', { backslash: true, doubling: false })
        if (!r) return fail('a string that never closes')
        push('string', i, r.end, r.value)
        i = r.end
        continue
      }
      // A string in MySQL (unless ANSI_QUOTES), a name everywhere else.
      const isString = family === 'mysql' && !modes.ansiQuotes
      const r = quoted(i, '"', { backslash: (isString && !modes.noBackslashEscapes) || family === 'clickhouse', doubling: family !== 'oracle' })
      if (!r) return fail(isString ? 'a string that never closes' : 'a quoted name that never closes')
      push(isString ? 'string' : 'ident', i, r.end, r.value)
      i = r.end
      continue
    }
    if (c === '`') {
      if (family !== 'mysql' && family !== 'sqlite' && family !== 'clickhouse' && family !== 'bigquery') return fail('a backtick (not a quote in this database)')
      const r = quoted(i, '`', { backslash: family === 'clickhouse' || family === 'bigquery', doubling: family === 'mysql' || family === 'sqlite' })
      if (!r) return fail('a quoted name that never closes')
      push('ident', i, r.end, r.value)
      i = r.end
      continue
    }
    if (c === '[' && (family === 'mssql' || family === 'sqlite')) {
      const r = quoted(i, '[', { backslash: false, doubling: family === 'mssql', close: ']' })
      if (!r) return fail('a [name] that never closes')
      push('ident', i, r.end, r.value)
      i = r.end
      continue
    }
    if (/[0-9]/.test(c) || (c === '.' && next !== undefined && /[0-9]/.test(next))) {
      let j = i
      if (c === '0' && /[xXbB]/.test(next ?? '')) {
        j += 2
        while (j < n && /[0-9A-Fa-f_]/.test(sql[j]!)) j++
      } else {
        while (j < n && /[0-9_]/.test(sql[j]!)) j++
        if (sql[j] === '.') {
          j++
          while (j < n && /[0-9_]/.test(sql[j]!)) j++
        }
        if (/[eE]/.test(sql[j] ?? '') && /[-+0-9]/.test(sql[j + 1] ?? '')) {
          j += /[-+]/.test(sql[j + 1]!) ? 2 : 1
          while (j < n && /[0-9]/.test(sql[j]!)) j++
        }
      }
      push('number', i, j)
      i = j
      continue
    }
    if (isWordStart(c) || (c === '@' && family === 'mssql') || (c === '#' && family === 'mssql')) {
      let j = i + 1
      while (j < n && (isWordChar(sql[j]) || ((family === 'mssql' || family === 'mysql') && (sql[j] === '@' || sql[j] === '#')))) j++
      push('word', i, j)
      i = j
      continue
    }
    // SQLite parameters: ?NNN, :name, @name, $name (TCL style).
    if (family === 'sqlite' && (c === '?' || ((c === ':' || c === '@' || c === '$') && isWordChar(next)))) {
      let j = i + 1
      while (j < n && (isWordChar(sql[j]) || sql[j] === ':')) j++
      push('param', i, j)
      i = j
      continue
    }
    if (c === ';') {
      if (inCode) return fail('a semicolon inside a MySQL executable comment')
      push('semicolon', i, i + 1)
      i++
      continue
    }
    if (c === '$') {
      // A $ outside a name: PostgreSQL's case is above; elsewhere only part of names (handled by words).
      push('op', i, i + 1)
      i++
      continue
    }
    push('op', i, i + 1)
    i++
  }
  if (inCode) return fail('a MySQL executable comment that never closes')
  return { ok: true, tokens }
}

/** BigQuery's '''…''' and """…""" (raw ones keep backslashes, but a backslash still keeps the next quote in). */
function bigQueryTriple(sql: string, open: number, q: string, raw: boolean): { end: number; value: string } | undefined {
  const close = q.repeat(3)
  let value = ''
  for (let j = open + 3; j < sql.length; ) {
    if (sql[j] === '\\') {
      if (j + 1 >= sql.length) return undefined
      value += raw ? sql.slice(j, j + 2) : sql[j + 1]
      j += 2
      continue
    }
    if (sql.startsWith(close, j)) return { end: j + 3, value }
    value += sql[j]
    j++
  }
  return undefined
}

/** The tokens that are code (no spaces or comments). */
export const codeTokens = (tokens: Token[]) => tokens.filter((t) => t.kind !== 'space' && t.kind !== 'comment')

/**
 * Statements by the tokens: split at semicolons (and, for SQL Server, at GO lines). Each is the list of its tokens;
 * statements with no code are left out.
 */
export function tokenStatements(sql: string, tokens: Token[], driver: DriverId | string, options: { batches?: boolean } = {}): Token[][] {
  const out: Token[][] = []
  let current: Token[] = []
  const flush = () => {
    if (current.some((t) => t.kind !== 'space' && t.kind !== 'comment')) out.push(current)
    current = []
  }
  for (const t of tokens) {
    // (`batches`: only GO separates, as SQL Server runs a batch: semicolons stay inside it.)
    if (t.kind === 'semicolon' && !options.batches) {
      flush()
      continue
    }
    if (familyOf(driver) === 'mssql' && t.kind === 'word' && /^go$/i.test(sql.slice(t.start, t.end)) && lineAlone(sql, t)) {
      flush()
      continue
    }
    current.push(t)
  }
  flush()
  return out
}

/** Whether a token stands alone on its line (`GO`, a T-SQL batch separator). */
function lineAlone(sql: string, t: Token): boolean {
  let a = t.start - 1
  while (a >= 0 && (sql[a] === ' ' || sql[a] === '\t')) a--
  let b = t.end
  while (b < sql.length && (sql[b] === ' ' || sql[b] === '\t')) b++
  return (a < 0 || sql[a] === '\n' || sql[a] === '\r') && (b >= sql.length || sql[b] === '\n' || sql[b] === '\r')
}

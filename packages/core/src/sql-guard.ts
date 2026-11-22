import { getDialect } from './dialect.js'
import { familyOf, lex, type LexModes, type Token } from './sql-lexer.js'
import type { DriverId } from './types.js'

/**
 * Text a model gives as SQL (a type, a default, a check, an index expression, a collation) goes into generated
 * scripts, and a model is data: a `.dbml` from a stranger is as untrusted as any other file. Such a piece is not
 * copied: it is read with the tokenizer of the dialect it was written for (sql-lexer.ts) and written again from its
 * tokens in the simplest form the target server and our splitter can't read differently: strings as the target's
 * standard literals with their value kept (a MySQL 'C:\\tmp' stays C:\tmp, a PostgreSQL $$…$$ becomes '…'),
 * quoted names through the target's quoting, comments dropped, everything on one line. The result is read again
 * with the target's tokenizer and must come out as the same tokens. A piece that can't be read, holds a statement
 * separator or something that runs as code (MySQL executable comments), or reads differently in the target, has a problem: the
 * generators leave it out and say so (ddl.ts guardChanges).
 */
export type Canonical = { sql: string; problem?: undefined } | { sql?: undefined; problem: string }

/**
 * `modes`: how the target server reads strings (MySQL's sql_mode, ServerInfo.sqlModes, for a script made for a live
 * connection). Without a connection the default is assumed: backslashes escape, "…" is a string.
 */
export function canonicalPiece(text: string, target: DriverId, source: DriverId = target, modes: LexModes = {}): Canonical {
  const read = lex(text, source, source === target ? modes : {})
  if (!read.ok) return { problem: read.reason }
  const parts: string[] = []
  const kinds: string[] = []
  let depth = 0
  let gap = false
  const emit = (piece: string, kind: string) => {
    // A space between tokens that had one (or a comment) between them, and between two that would join.
    const prev = parts.at(-1)
    if (prev !== undefined && (gap || joins(prev, piece))) parts.push(' ')
    parts.push(piece)
    kinds.push(kind)
    gap = false
  }
  const code = read.tokens.filter((t) => t.kind !== 'space' && t.kind !== 'comment')
  const crossing = familyOf(source) !== familyOf(target)
  let skipTo = -1
  for (const t of read.tokens) {
    if (t.start < skipTo) continue
    const raw = text.slice(t.start, t.end)
    if (crossing && t.kind === 'word') {
      const at = code.indexOf(t)
      const next = code[at + 1]
      // A MySQL charset introducer (_utf8mb4'…') says nothing another database reads: the string is its value.
      if (familyOf(source) === 'mysql' && /^_[a-z0-9]+$/i.test(raw) && next?.kind === 'string') continue
      // The current time and a new UUID in the target's words, where the meaning is that clear.
      // SQLite's datetime('now') is the current time too.
      const tok = (k: number) => (code[at + k] ? text.slice(code[at + k]!.start, code[at + k]!.end) : '')
      if (familyOf(source) === 'sqlite' && /^datetime$/i.test(raw) && tok(1) === '(' && code[at + 2]?.kind === 'string' && code[at + 2]!.value === 'now' && tok(3) === ')') {
        emit(NOW[familyOf(target)]!, 'mapped')
        skipTo = code[at + 3]!.end
        continue
      }
      const call = next && text.slice(next.start, next.end) === '(' && code[at + 2] && text.slice(code[at + 2]!.start, code[at + 2]!.end) === ')'
      const mapped = call ? CALLS[raw.toLowerCase()]?.[familyOf(target)] : /^(sysdate|systimestamp|localtimestamp)$/i.test(raw) && !next ? CALLS.now?.[familyOf(target)] : undefined
      if (mapped) {
        emit(mapped, 'mapped')
        if (call) skipTo = code[at + 2]!.end
        continue
      }
    }
    switch (t.kind) {
      case 'space':
      case 'comment':
        gap = true
        break
      case 'semicolon':
        return { problem: 'a semicolon' }
      case 'code-open':
      case 'code-close':
        return { problem: 'a MySQL comment that runs as SQL (/*! or /*+)' }
      case 'param':
        return { problem: `a parameter (${raw})` }
      case 'string': {
        const literal = stringLiteral(raw, t, source, target, modes)
        if (literal === undefined) return { problem: `a string this database can't take as it is (${raw.slice(0, 20)})` }
        emit(literal, 'string')
        break
      }
      case 'ident':
        emit(getDialect(target).quoteIdent(t.value ?? ''), 'ident')
        break
      case 'op':
        if (raw === '(') depth++
        if (raw === ')' && --depth < 0) return { problem: 'a ")" without its "("' }
        if (raw === '\\') return { problem: 'a backslash outside a string' }
        // `#` starts a comment in some databases: as an operator (PostgreSQL's XOR) it only stays where it is one.
        if (raw === '#' && ['mysql', 'clickhouse', 'bigquery'].includes(familyOf(target))) return { problem: 'a # (a comment in this database)' }
        if (raw === '`' || raw === '"' || raw === "'") return { problem: `a stray ${raw}` }
        emit(raw, 'op')
        break
      default:
        emit(raw, t.kind)
    }
  }
  if (kinds.includes('mapped')) {
    // (A mapped call is several tokens of its own: read back as the target's words.)
    const sql = parts.join('')
    const back = lex(sql, target, modes)
    if (!back.ok || back.tokens.some((t) => t.kind === 'semicolon' || t.kind === 'comment' || t.kind === 'code-open')) return { problem: `it reads differently in ${target}` }
    return depth ? { problem: 'a "(" without its ")"' } : { sql }
  }
  if (depth) return { problem: 'a "(" without its ")"' }
  const sql = parts.join('')
  // Read back by the target: the same tokens, nothing that would end or swallow its statement.
  const back = lex(sql, target, modes)
  if (!back.ok) return { problem: `it reads differently in ${target} (${back.reason})` }
  const backKinds = back.tokens.filter((t) => t.kind !== 'space').map((t) => t.kind)
  if (backKinds.join(',') !== kinds.join(',')) return { problem: `it reads differently in ${target}` }
  return { sql }
}

/** Calls whose meaning is the same everywhere, in each family's words (a source's own name is the key). */
const NOW: Record<string, string> = { postgres: 'CURRENT_TIMESTAMP', mysql: 'CURRENT_TIMESTAMP', mssql: 'getdate()', oracle: 'SYSTIMESTAMP', sqlite: 'CURRENT_TIMESTAMP', clickhouse: 'now()', bigquery: 'CURRENT_TIMESTAMP()', trino: 'CURRENT_TIMESTAMP' }
const UUID: Record<string, string> = { postgres: 'gen_random_uuid()', mysql: 'uuid()', mssql: 'newid()', oracle: 'sys_guid()', clickhouse: 'generateUUIDv4()', bigquery: 'GENERATE_UUID()', trino: 'uuid()' }
const CALLS: Record<string, Record<string, string>> = {
  now: NOW,
  getdate: NOW,
  getutcdate: NOW,
  sysdatetime: NOW,
  current_timestamp: NOW,
  newid: UUID,
  gen_random_uuid: UUID,
  uuid: UUID,
  sys_guid: UUID,
}

/** Whether two tokens written next to each other would read as one, or as a comment (`-` `-`, `/` `*`). */
function joins(a: string, b: string): boolean {
  const last = a.at(-1)!
  const first = b[0]!
  const word = (c: string) => /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) > 127
  if (word(last) && word(first)) return true
  if ((last === '-' && first === '-') || (last === '/' && first === '*') || (last === '*' && first === '/')) return true
  // A quote right after a word could make a prefixed string of it (E'…', N'…').
  if (word(last) && (first === "'" || first === '"')) return true
  return false
}

/** A string token as the target's standard literal of the same value, or undefined where that isn't sure. */
function stringLiteral(raw: string, t: Token, source: DriverId, target: DriverId, modes: LexModes = {}): string | undefined {
  const value = t.value ?? ''
  const prefix = /^([A-Za-z&]*)['"$`]/.exec(raw)?.[1]?.toLowerCase() ?? ''
  const sourceFamily = familyOf(source)
  const targetFamily = familyOf(target)
  // Bit and hex literals are not strings: kept as written where they are the same literal, never elsewhere.
  if (/^(b|x)$/.test(prefix) && /^[0-9A-Fa-f]*$/.test(value)) return sourceFamily === targetFamily || ['postgres', 'mysql', 'sqlite'].includes(targetFamily) ? `${prefix.toUpperCase()}'${value}'` : undefined
  // U&'' is decoded by the server (its escapes are not ours to read): only to the same family, as written.
  if (prefix === 'u&') return sourceFamily === targetFamily ? raw : undefined
  if (prefix === 'b' || prefix === 'rb' || prefix === 'br') return undefined
  if (value.includes('\u0000')) return undefined
  const national = prefix === 'n' || (targetFamily === 'mssql' && /[^\x00-\x7f]/.test(value))
  switch (targetFamily) {
    case 'mysql':
      // (With NO_BACKSLASH_ESCAPES a backslash is an ordinary character there.)
      return `'${(modes.noBackslashEscapes ? value : value.replaceAll('\\', '\\\\')).replaceAll("'", "''")}'`
    case 'clickhouse':
    case 'bigquery':
      return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r')}'`
    case 'mssql':
    case 'oracle':
      return `${national ? 'N' : ''}'${value.replaceAll("'", "''")}'`
    default:
      return `'${value.replaceAll("'", "''")}'`
  }
}

/** The problem with a piece (canonicalPiece), or undefined when it can be written. */
export function sqlTextProblem(text: string, driver: DriverId, source: DriverId = driver): string | undefined {
  return canonicalPiece(text, driver, source).problem
}

/** One line for a comment or a warning: line breaks of every kind become spaces, controls go. */
export function oneLine(text: string): string {
  return text
    .replace(/\r\n|[\r\n\u0085\u2028\u2029]/g, ' ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
}

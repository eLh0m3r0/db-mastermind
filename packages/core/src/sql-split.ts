import type { DriverId } from './types.js'

export interface SqlStatement {
  /** Statement text without the trailing delimiter, trimmed. */
  text: string
  /** Offsets into the original script (start of first non-blank char, end exclusive incl. delimiter). */
  start: number
  end: number
}

const isWordChar = (ch: string | undefined) => !!ch && /[A-Za-z0-9_$]/.test(ch)

/**
 * Splits a script into statements, understanding quotes, comments, PostgreSQL dollar quoting,
 * MySQL `DELIMITER`, T-SQL `GO` batch separators and BEGIN…END bodies (SQLite triggers,
 * PostgreSQL BEGIN ATOMIC). With `batchesOnly`, only T-SQL `GO` separates (how SSMS sends batches).
 */
export function splitStatements(
  script: string,
  driver: DriverId,
  options: { batchesOnly?: boolean } = {},
): SqlStatement[] {
  const out: SqlStatement[] = []
  const n = script.length
  let delimiter = ';'
  let stmtStart = 0
  let i = 0
  // Oracle PL/SQL (BEGIN/DECLARE/CREATE PROCEDURE…) ends only at a "/" line, like in SQL*Plus.
  let plsql = false
  // BEGIN…END nesting, only tracked for statements that need it.
  let blockDepth = 0
  let trackBlocks = false
  let lastWords: string[] = []

  const push = (endOfText: number, endIncl: number) => {
    const raw = script.slice(stmtStart, endOfText)
    const leading = raw.length - raw.trimStart().length
    const text = raw.trim()
    if (text && !isOnlyComments(text)) out.push({ text, start: stmtStart + leading, end: endIncl })
    stmtStart = endIncl
    blockDepth = 0
    trackBlocks = false
    plsql = false
    lastWords = []
  }

  const atLineStart = (pos: number) => {
    let j = pos - 1
    while (j >= 0 && (script[j] === ' ' || script[j] === '\t')) j--
    return j < 0 || script[j] === '\n' || script[j] === '\r'
  }

  while (i < n) {
    const ch = script[i]!
    const next = script[i + 1]

    // MySQL client-side DELIMITER command.
    if ((driver === 'mysql' || driver === 'mariadb') && atLineStart(i) && /^delimiter\s/i.test(script.slice(i, i + 10))) {
      const lineEnd = script.indexOf('\n', i)
      const line = script.slice(i, lineEnd === -1 ? n : lineEnd)
      const newDelimiter = line.slice(9).trim()
      if (newDelimiter) {
        push(i, i)
        delimiter = newDelimiter
        i = lineEnd === -1 ? n : lineEnd + 1
        stmtStart = i
        continue
      }
    }

    // Oracle/SQL*Plus terminator: a line containing only "/".
    if (driver === 'oracle' && ch === '/' && atLineStart(i)) {
      const m = /^\/[ \t]*(?:\r?\n|$)/.exec(script.slice(i))
      if (m) {
        push(i, i + m[0].length)
        i += m[0].length
        continue
      }
    }

    // T-SQL batch separator: a line containing only GO.
    if (driver === 'mssql' && (ch === 'G' || ch === 'g') && atLineStart(i)) {
      const m = /^go[ \t]*(?:\r?\n|$)/i.exec(script.slice(i))
      if (m) {
        push(i, i + m[0].length)
        i += m[0].length
        continue
      }
    }

    if (ch === '-' && next === '-') {
      const lineEnd = script.indexOf('\n', i)
      i = lineEnd === -1 ? n : lineEnd + 1
      continue
    }
    if (ch === '#' && (driver === 'mysql' || driver === 'mariadb')) {
      const lineEnd = script.indexOf('\n', i)
      i = lineEnd === -1 ? n : lineEnd + 1
      continue
    }
    if (ch === '/' && next === '*') {
      // PostgreSQL supports nested block comments.
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (script[i] === '/' && script[i + 1] === '*' && driver === 'postgres') {
          depth++
          i += 2
        } else if (script[i] === '*' && script[i + 1] === '/') {
          depth--
          i += 2
        } else i++
      }
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`' || (ch === '[' && driver === 'mssql')) {
      const close = ch === '[' ? ']' : ch
      const backslashEscapes = (driver === 'mysql' || driver === 'mariadb') && ch !== '`'
      i++
      while (i < n) {
        if (backslashEscapes && script[i] === '\\') {
          i += 2
          continue
        }
        if (script[i] === close) {
          if (script[i + 1] === close) {
            i += 2
            continue
          }
          break
        }
        i++
      }
      i++
      continue
    }
    if (ch === '$' && (driver === 'postgres' || driver === 'duckdb') && !isWordChar(script[i - 1])) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(script.slice(i))
      if (m) {
        const tag = m[0]
        const close = script.indexOf(tag, i + tag.length)
        i = close === -1 ? n : close + tag.length
        continue
      }
    }

    if (isWordChar(ch) && !isWordChar(script[i - 1])) {
      let j = i
      while (j < n && isWordChar(script[j])) j++
      const word = script.slice(i, j).toUpperCase()
      lastWords.push(word)
      if (lastWords.length > 6) lastWords.shift()
      if (driver === 'oracle' && !plsql) {
        const head = script.slice(stmtStart, j).replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/, '').toUpperCase()
        if (/^(DECLARE|BEGIN|CREATE\s+(OR\s+REPLACE\s+)?((NON)?EDITIONABLE\s+)?(PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE))\b/.test(head)) plsql = true
      }
      if (!trackBlocks) {
        const head = script.slice(stmtStart, j).trimStart().toUpperCase()
        if (
          (driver === 'sqlite' && /^CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/.test(head)) ||
          (driver === 'postgres' && word === 'ATOMIC' && lastWords.at(-2) === 'BEGIN')
        ) {
          trackBlocks = true
          if (word === 'ATOMIC') blockDepth = 1
        }
      } else if (word === 'BEGIN' || word === 'CASE') {
        blockDepth++
      } else if (word === 'END') {
        blockDepth = Math.max(0, blockDepth - 1)
      }
      i = j
      continue
    }

    if (!options.batchesOnly && !plsql && script.startsWith(delimiter, i) && !(trackBlocks && blockDepth > 0)) {
      push(i, i + delimiter.length)
      i += delimiter.length
      continue
    }
    i++
  }
  push(n, n)
  return out
}

function isOnlyComments(text: string): boolean {
  return text.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim() === ''
}

/** Statement containing the cursor; a cursor right after a delimiter belongs to the previous statement. */
export function statementAtOffset(script: string, offset: number, driver: DriverId): SqlStatement | undefined {
  const statements = splitStatements(script, driver)
  if (statements.length === 0) return undefined
  for (const s of statements) {
    if (offset >= s.start && offset <= s.end) return s
  }
  // Between statements: pick the closest preceding one, else the first.
  let best: SqlStatement | undefined
  for (const s of statements) if (s.end <= offset) best = s
  return best ?? statements[0]
}

export type StatementKind = 'read' | 'write' | 'ddl' | 'transaction' | 'other'

/** Strips leading comments and parentheses so classification sees the first keyword. */
function firstKeywords(sql: string, count: number): string[] {
  const cleaned = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[\s(]+/, '')
  return cleaned
    .split(/[^A-Za-z_]+/)
    .filter(Boolean)
    .slice(0, count)
    .map((w) => w.toUpperCase())
}

const WRITE_WORDS = /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|REPLACE|TRUNCATE|INTO|DROP|ALTER|CREATE|GRANT|REVOKE|CALL|EXEC|EXECUTE|COPY|LOCK)\b/i

export function classifyStatement(sql: string): StatementKind {
  const [first = '', second = ''] = firstKeywords(sql, 2)
  switch (first) {
    case 'SELECT':
    case 'VALUES':
    case 'TABLE':
    case 'SHOW':
    case 'DESCRIBE':
    case 'DESC':
    case 'EXPLAIN':
    case 'PRAGMA':
    case 'DECLARE':
    case 'PRINT':
    case 'USE':
      // SELECT … INTO creates a table; EXPLAIN ANALYZE executes the statement.
      if (first === 'SELECT' && /\bINTO\b/i.test(stripLiterals(sql))) return 'write'
      if (first === 'EXPLAIN' && /\bANALY[SZ]E\b/i.test(sql) && WRITE_WORDS.test(stripLiterals(sql))) return 'write'
      if (first === 'PRAGMA' && /=/.test(sql)) return 'write'
      return 'read'
    case 'WITH': {
      const body = stripLiterals(sql)
      return /\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(body) ? 'write' : 'read'
    }
    case 'INSERT':
    case 'UPDATE':
    case 'DELETE':
    case 'MERGE':
    case 'UPSERT':
    case 'REPLACE':
    case 'COPY':
    case 'CALL':
    case 'EXEC':
    case 'EXECUTE':
    case 'DO':
      return 'write'
    case 'CREATE':
    case 'ALTER':
    case 'DROP':
    case 'TRUNCATE':
    case 'RENAME':
    case 'COMMENT':
    case 'GRANT':
    case 'REVOKE':
      return 'ddl'
    case 'BEGIN':
    case 'START':
    case 'COMMIT':
    case 'ROLLBACK':
    case 'SAVEPOINT':
    case 'RELEASE':
    case 'END':
      return second === 'TRY' || second === 'CATCH' ? 'other' : 'transaction'
    default:
      return 'other'
  }
}

function stripLiterals(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
}

/** True when every statement is a pure read. Unknown statements count as writes. */
export function isReadOnlyScript(script: string, driver: DriverId): boolean {
  return splitStatements(script, driver).every((s) => classifyStatement(s.text) === 'read')
}

/** True when a statement can destroy data without a WHERE clause or drops objects. */
export function isDangerousStatement(sql: string): boolean {
  const body = stripLiterals(sql)
  const [first = ''] = firstKeywords(body, 1)
  if (first === 'DROP' || first === 'TRUNCATE') return true
  if ((first === 'DELETE' || first === 'UPDATE') && !/\bWHERE\b/i.test(body)) return true
  return false
}

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
      if (first === 'PRAGMA') return isReadPragma(sql) ? 'read' : 'write'
      // DECLARE … BEGIN … END is a PL/SQL block, which can do anything.
      if (first === 'DECLARE' && /\bBEGIN\b/i.test(stripLiterals(sql))) return 'other'
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

/** SQLite pragmas that only report something. Others change the database file or connection (or may, like optimize). */
const READ_PRAGMAS = new Set(
  'application_id auto_vacuum automatic_index busy_timeout cache_size cache_spill cell_size_check checkpoint_fullfsync collation_list compile_options data_version database_list defer_foreign_keys encoding foreign_key_check foreign_key_list foreign_keys freelist_count fullfsync function_list hard_heap_limit ignore_check_constraints index_info index_list index_xinfo integrity_check journal_mode journal_size_limit legacy_alter_table locking_mode max_page_count mmap_size module_list page_count page_size pragma_list query_only quick_check read_uncommitted recursive_triggers reverse_unordered_selects schema_version secure_delete soft_heap_limit synchronous table_info table_list table_xinfo temp_store threads trusted_schema user_version wal_autocheckpoint'.split(' '),
)
/** Pragmas whose argument names what to report on (`table_info(users)`); for the others an argument sets a value. */
const READ_PRAGMAS_WITH_ARGUMENT = new Set('foreign_key_check foreign_key_list index_info index_list index_xinfo integrity_check quick_check table_info table_list table_xinfo'.split(' '))

function isReadPragma(sql: string): boolean {
  const m = /^\s*PRAGMA\s+(?:[\w"]+\s*\.\s*)?["]?(\w+)["]?\s*([=(])?/i.exec(stripLiterals(sql).trim())
  if (!m) return false
  const name = m[1]!.toLowerCase()
  if (m[2] === '=') return false
  if (m[2] === '(') return READ_PRAGMAS_WITH_ARGUMENT.has(name)
  return READ_PRAGMAS.has(name)
}

export function stripLiterals(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
}

/** Keywords that end, nest or leave a transaction, or run other code: not allowed inside a read-only guard. */
const ESCAPES_TRANSACTION = /\b(COMMIT|ROLLBACK|SAVEPOINT|RELEASE|EXEC|EXECUTE|CALL|SET\s+TRANSACTION|BEGIN\s+TRAN\w*|SAVE\s+TRAN\w*|START\s+TRANSACTION)\b/i

/** T-SQL that changes data or runs other code. T-SQL needs no semicolons, so it can follow a SELECT in one statement. */
const TSQL_WRITES = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|DENY|INTO|BULK|DBCC|BACKUP|RESTORE|KILL|SHUTDOWN|RECONFIGURE|WRITETEXT|UPDATETEXT|OPENQUERY|OPENROWSET|OPENDATASOURCE)\b/i

/**
 * True when a script may run inside a read-only transaction: only reads, and nothing that could end the transaction.
 * The same as isReadOnlyScript, which already rejects COMMIT, CALL and the like (and their T-SQL forms anywhere).
 */
export function fitsReadOnlyTransaction(script: string, driver: DriverId): boolean {
  return isReadOnlyScript(script, driver)
}

/**
 * True when every statement is a pure read. Unknown statements count as writes. In T-SQL `SELECT 1 DELETE FROM t`
 * (or `SELECT 1 COMMIT`) is one statement starting with SELECT, so the whole text is checked for writes too.
 */
export function isReadOnlyScript(script: string, driver: DriverId): boolean {
  return splitStatements(script, driver).every((s) => {
    if (classifyStatement(s.text) !== 'read') return false
    if (driver !== 'mssql') return true
    const body = stripLiterals(s.text).replace(/\[[^\]]*\]/g, '[]')
    return !TSQL_WRITES.test(body) && !ESCAPES_TRANSACTION.test(body)
  })
}

/**
 * True when free-form filter SQL (typed in the grid, or written by AI) is only a condition: no second statement and
 * nothing that writes, so a filter can't change data even where the connection could.
 */
export function isReadOnlyCondition(condition: string, driver: DriverId): boolean {
  const probe = `SELECT 1 WHERE (${condition})`
  return splitStatements(probe, driver).length === 1 && isReadOnlyScript(probe, driver)
}

/**
 * True when SQL that ran may have changed the schema, so the explorer should reload it. Looks past the first word:
 * a T-SQL batch runs as one statement (`SET XACT_ABORT ON; BEGIN TRANSACTION; CREATE TABLE …`), and so can a
 * statement after a comment.
 */
export function changesSchema(sql: string): boolean {
  return /\b(CREATE|ALTER|DROP|RENAME|COMMENT\s+ON|SP_RENAME)\b/i.test(stripLiterals(sql))
}

/** True when a statement can destroy data without a WHERE clause or drops objects. */
export function isDangerousStatement(sql: string): boolean {
  const body = stripLiterals(sql)
  const [first = ''] = firstKeywords(body, 1)
  if (first === 'DROP' || first === 'TRUNCATE') return true
  if ((first === 'DELETE' || first === 'UPDATE') && !/\bWHERE\b/i.test(body)) return true
  return false
}

/**
 * Whether a transaction is open after running `sql`, given whether one was open before. Explicit BEGIN / START
 * TRANSACTION / BEGIN TRAN open one and COMMIT / ROLLBACK close it; with `implicitDml` (Oracle) a data change opens
 * one too and DDL commits.
 */
export function nextTransactionState(open: boolean, sql: string, implicitDml = false): boolean {
  const body = stripLiterals(sql)
  const re = /\b(START\s+TRANSACTION|BEGIN\s+(?:TRAN|TRANSACTION|WORK)|BEGIN\s+(?:TRY|CATCH|DISTRIBUTED)|COMMIT|ROLLBACK(?:\s+(?:WORK\s+)?TO)?|INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE)\b|^\s*BEGIN\b/gim
  for (const m of body.matchAll(re)) {
    const word = m[0].trim().toUpperCase().replace(/\s+/g, ' ')
    if (word === 'BEGIN' || /^(START TRANSACTION|BEGIN (TRAN|TRANSACTION|WORK))$/.test(word)) open = true
    else if (word === 'COMMIT' || word === 'ROLLBACK') open = false
    else if (implicitDml && /^(INSERT|UPDATE|DELETE|MERGE)$/.test(word)) open = true
    else if (implicitDml && /^(CREATE|ALTER|DROP|TRUNCATE)$/.test(word)) open = false
  }
  return open
}

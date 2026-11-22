import { conditionVerdict, readVerdict } from './sql-readonly.js'
import { lex } from './sql-lexer.js'
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
  // PostgreSQL COPY … FROM STDIN: its data lines (up to a line "\.") belong to it, they are not SQL.
  let copyData = false
  // Strings, quoted names and comments as the database reads them (sql-lexer.ts): skipped whole. From where the
  // lexer can't go on (an unclosed string or comment), the rest of the script belongs to the current statement.
  const lexed = lex(script, driver)
  const skip = new Map<number, number>()
  for (const t of lexed.tokens) if (t.kind === 'comment' || t.kind === 'string' || t.kind === 'ident') skip.set(t.start, t.end)
  const opaqueFrom = lexed.ok ? Infinity : lexed.at

  const push = (endOfText: number, endIncl: number) => {
    const raw = script.slice(stmtStart, endOfText)
    const leading = raw.length - raw.trimStart().length
    const text = raw.trim()
    if (text && !isOnlyComments(text)) {
      out.push({ text, start: stmtStart + leading, end: endIncl })
      if (driver === 'postgres' && isCopyFromStdin(text)) copyData = true
    }
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
    if (copyData) {
      copyData = false
      const end = /^\\\.[ \t]*(?:\r?\n|$)/m.exec(script.slice(i))
      const stop = end ? i + end.index + end[0].length : n
      const last = out[out.length - 1]!
      last.text = script.slice(last.start, stop).trimEnd()
      last.end = stop
      i = stmtStart = stop
      continue
    }
    const ch = script[i]!

    // psql meta-commands (\d users, \timing) end at the end of their line, without a semicolon.
    if (driver === 'postgres' && ch === '\\' && atLineStart(i) && isOnlyComments(script.slice(stmtStart, i).trim() || '--')) {
      const lineEnd = script.indexOf('\n', i)
      // pg_dump (current minor releases) wraps a plain dump in \restrict <token> … \unrestrict <token>: nothing to run.
      if (/^\\(un)?restrict\b/.test(script.slice(i, i + 12))) {
        i = stmtStart = lineEnd === -1 ? n : lineEnd + 1
        continue
      }
      stmtStart = i
      push(lineEnd === -1 ? n : lineEnd, lineEnd === -1 ? n : lineEnd + 1)
      i = stmtStart
      continue
    }
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

    if (i >= opaqueFrom) {
      i = n
      continue
    }
    const skipped = skip.get(i)
    if (skipped !== undefined) {
      i = skipped
      continue
    }

    if (isWordChar(ch) && !isWordChar(script[i - 1]) && !(delimiter !== ';' && script.startsWith(delimiter, i))) {
      let j = i
      // MySQL names may contain `$`: a word still ends where a DELIMITER-set delimiter such as `$$` starts (END$$).
      while (j < n && isWordChar(script[j]) && !(delimiter !== ';' && j > i && script.startsWith(delimiter, j))) j++
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

const NAME_PART = String.raw`(?:"(?:[^"]|"")+"|[\p{L}_][\p{L}\p{N}_$]*)`

/**
 * PostgreSQL `COPY table [(columns)] FROM STDIN`, whose data lines follow it (also after the comments pg_dump writes
 * before it). Not `COPY (query) TO …`, nor a table or a literal that happens to say stdin.
 */
export function isCopyFromStdin(text: string): boolean {
  const body = text.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, '')
  return new RegExp(String.raw`^COPY\s+${NAME_PART}(?:\s*\.\s*${NAME_PART})*(?:\s*\([^)]*\))?\s+FROM\s+STDIN\b`, 'iu').test(body)
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

/**
 * Empties string literals and quoted names and replaces comments with a space, in one pass in source order: a quote
 * inside a comment (`-- Bob's`) or `--` inside a string must not pair with anything. With a driver it also knows that
 * engine's quoting (MySQL backslash escapes, backticks and `#` comments, T-SQL `[names]`, PostgreSQL `$$` bodies and
 * E'' strings), like splitStatements.
 */
export function stripLiterals(sql: string, driver?: DriverId): string {
  const lexed = lex(sql, driver ?? 'postgres')
  let out = ''
  let at = 0
  for (const t of lexed.tokens) {
    out += sql.slice(at, t.start)
    const text = sql.slice(t.start, t.end)
    if (t.kind === 'comment' || t.kind === 'code-open' || t.kind === 'code-close') out += ' '
    else if (t.kind === 'string') out += "''"
    else if (t.kind === 'ident') out += text[0] === '[' ? '[]' : `${text[0]}${text[0]}`
    else out += text
    at = t.end
  }
  // What the lexer could not read (an unclosed string or comment) is no code: it stays out, as a literal would.
  return lexed.ok ? out + sql.slice(at) : `${out}''`
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
  return readVerdict(script, driver).ok
}

/**
 * True when free-form filter SQL (typed in the grid, or written by AI) is only a condition: no second statement and
 * nothing that writes, so a filter can't change data even where the connection could (sql-readonly.ts).
 */
export function isReadOnlyCondition(condition: string, driver: DriverId): boolean {
  return conditionVerdict(condition, driver).ok
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

/** Session and maintenance commands: they change no data, so they never open a transaction of their own. */
const SESSION_WORDS = new Set('SET RESET USE SHOW LISTEN UNLISTEN LOAD INSTALL ATTACH DETACH DISCARD DEALLOCATE PREPARE CHECKPOINT ANALYZE OPTIMIZE PRINT DECLARE PRAGMA'.split(' '))

/** Statements the database refuses inside a transaction block. */
const OUTSIDE_TRANSACTION: Partial<Record<DriverId, RegExp>> = {
  postgres: /^\s*(VACUUM|(CREATE|DROP)\s+(DATABASE|TABLESPACE|SUBSCRIPTION)|ALTER\s+(SYSTEM|SUBSCRIPTION)|(CREATE\s+(UNIQUE\s+)?|DROP\s+)INDEX\s+CONCURRENTLY|REINDEX\b[^;]*\bCONCURRENTLY|ALTER\s+TABLE\b[^;]*\bDETACH\s+PARTITION\b[^;]*\bCONCURRENTLY)\b/i,
  // Keywords, not names: `dbo.Backup` or a column `restore` is no BACKUP / RESTORE statement.
  mssql: /(?<![\w.@#$])((CREATE|ALTER|DROP)\s+(DATABASE|FULLTEXT\s+(CATALOG|INDEX))|(BACKUP|RESTORE)\s+(DATABASE|LOG)\b|(?<=(?:^|;)\s*)RECONFIGURE\b)/im,
  sqlite: /^\s*VACUUM\b/i,
  duckdb: /^\s*(VACUUM|CHECKPOINT|FORCE\s+CHECKPOINT|ATTACH|DETACH)\b/i,
}

/**
 * True when, with manual commit, this statement should first open a transaction: it may change data or the schema
 * and the database can run it inside one. Reads, transaction control and session settings run as they are.
 */
export function opensTransaction(sql: string, driver: DriverId): boolean {
  const body = stripLiterals(sql, driver)
  if (!body.trim()) return false
  // "Reads" that change something or hold locks until the transaction ends.
  if (/\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b|\bLOCK\s+IN\s+SHARE\s+MODE\b|\b(nextval|setval)\s*\(/i.test(body) && !OUTSIDE_TRANSACTION[driver]?.test(body)) return true
  // MariaDB's compound statement outside a routine.
  if ((driver === 'mysql' || driver === 'mariadb') && /^\s*BEGIN\s+NOT\s+ATOMIC\b/i.test(body)) return true
  if (isReadOnlyScript(sql, driver)) return false
  if (OUTSIDE_TRANSACTION[driver]?.test(body)) return false
  if (driver === 'mssql') {
    // A batch that opens its own transaction manages it itself. A COMMIT or ROLLBACK without BEGIN TRAN (`UPDATE …
    // ROLLBACK`, a CATCH block's `IF @@TRANCOUNT > 0 ROLLBACK`) ends the one opened here, so it still needs one.
    if (/\bBEGIN\s+(DISTRIBUTED\s+)?TRAN\w*\b/i.test(body)) return false
    // T-SQL needs no separators (`SET NOCOUNT ON UPDATE t …` is one line): look for anything that writes, anywhere.
    // (A batch may start with a procedure name and no EXEC: `sp_rename 'a', 'b'`.)
    return TSQL_WRITES.test(body) || /\bEXEC(UTE)?\b/i.test(body) || /^\s*(\[?\w+\]?\.)*\[?sp_\w+/i.test(body)
  }
  // An Oracle PL/SQL block (BEGIN … END; or DECLARE … BEGIN … END;) can change anything: it opens one too.
  if (driver === 'oracle' && /^\s*(BEGIN|DECLARE)\b[\s\S]*\bEND\b/i.test(body)) return true
  const kind = classifyStatement(sql)
  if (kind === 'transaction') return false
  const [first = ''] = firstKeywords(body, 1)
  // MySQL's LOAD DATA / LOAD XML insert rows; DuckDB's LOAD only loads an extension.
  if (first === 'LOAD') return /^\s*LOAD\s+(DATA|XML)\b/i.test(body)
  return !SESSION_WORDS.has(first)
}

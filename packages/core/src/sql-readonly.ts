import { codeTokens, familyOf, lex, tokenStatements, type LexModes, type Token } from './sql-lexer.js'
import type { DriverId } from './types.js'

/**
 * Whether SQL nobody confirmed (AI chat, MCP agents, read-only connections, raw grid filters) may run: decided on the
 * tokens of sql-lexer.ts (input it can't read completely is refused), by an allowlist of what may start a statement,
 * and a list of words that never belong in a read anywhere in its code. This is one layer of several: the engine
 * also runs such SQL one statement per call where the protocol allows it, inside a read-only transaction whose
 * state it checks after every statement, and asks SQL Server for its own plan (engine.ts runUnconfirmed).
 */
export interface ReadVerdict {
  ok: boolean
  reason?: string
  /** The statements as the tokens split them: [start, end) offsets into the script. */
  statements: { start: number; end: number; text: string }[]
}

/** What may start a statement nobody confirmed, per dialect family. */
const STARTS: Record<string, Set<string>> = {
  postgres: new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'SHOW', 'EXPLAIN', 'FROM', 'SUMMARIZE', 'DESCRIBE']),
  mysql: new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'SHOW', 'EXPLAIN', 'DESCRIBE', 'DESC']),
  // T-SQL batches: variables and conditions are part of reading; the server's own plan decides on the rest.
  mssql: new Set(['SELECT', 'WITH', 'DECLARE', 'SET', 'IF', 'BEGIN', 'PRINT']),
  oracle: new Set(['SELECT', 'WITH']),
  sqlite: new Set(['SELECT', 'WITH', 'VALUES', 'EXPLAIN', 'PRAGMA']),
  clickhouse: new Set(['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'EXISTS']),
  bigquery: new Set(['SELECT', 'WITH']),
  trino: new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'SHOW', 'EXPLAIN', 'DESCRIBE']),
}

/** Words that never belong anywhere in a read's code (outside strings, names and comments). */
const NEVER = new Set(
  'INSERT DELETE MERGE UPSERT TRUNCATE DROP ALTER CREATE GRANT REVOKE DENY COMMIT ROLLBACK SAVEPOINT ABORT CALL EXEC EXECUTE COPY LOCK UNLOCK PREPARE DEALLOCATE INTO OUTFILE DUMPFILE HANDLER ATTACH DETACH VACUUM REINDEX CLUSTER REFRESH LISTEN NOTIFY CHECKPOINT KILL SHUTDOWN RECONFIGURE BULK DBCC BACKUP RESTORE WRITETEXT UPDATETEXT OPENQUERY OPENROWSET OPENDATASOURCE WAITFOR INSTALL IMPORT EXPORT'.split(' '),
)

/** SQLite pragmas that only report something (see sql-split.ts READ_PRAGMAS). */
const READ_PRAGMAS = new Set(
  'application_id auto_vacuum automatic_index busy_timeout cache_size cache_spill cell_size_check checkpoint_fullfsync collation_list compile_options data_version database_list defer_foreign_keys encoding foreign_key_check foreign_key_list foreign_keys freelist_count fullfsync function_list hard_heap_limit ignore_check_constraints index_info index_list index_xinfo integrity_check journal_mode journal_size_limit legacy_alter_table locking_mode max_page_count mmap_size module_list page_count page_size pragma_list query_only quick_check read_uncommitted recursive_triggers reverse_unordered_selects schema_version secure_delete soft_heap_limit synchronous table_info table_list table_xinfo temp_store threads trusted_schema user_version wal_autocheckpoint'.split(' '),
)
const READ_PRAGMAS_WITH_ARGUMENT = new Set('foreign_key_check foreign_key_list index_info index_list index_xinfo integrity_check quick_check table_info table_list table_xinfo'.split(' '))

export function readVerdict(script: string, driver: DriverId | string, modes: LexModes = {}): ReadVerdict {
  const lexed = lex(script, driver, modes)
  if (!lexed.ok) return { ok: false, reason: `It could not be read completely (${lexed.reason}), so it is not run.`, statements: [] }
  const family = familyOf(driver)
  if (lexed.tokens.some((t) => t.kind === 'code-open')) return { ok: false, reason: 'MySQL runs what is inside /*! … */ and /*+ … */: such comments are not allowed here.', statements: [] }
  const statements = tokenStatements(script, lexed.tokens, driver)
  const out: ReadVerdict['statements'] = []
  for (const tokens of statements) {
    const code = codeTokens(tokens)
    const start = tokens[0]!.start
    const end = tokens.at(-1)!.end
    out.push({ start, end, text: script.slice(start, end).trim() })
    const problem = statementProblem(script, code, family)
    if (problem) return { ok: false, reason: problem, statements: out }
  }
  if (!out.length) return { ok: false, reason: 'There is no statement to run.', statements: out }
  return { ok: true, statements: out }
}

const word = (script: string, t: Token) => (t.kind === 'word' ? script.slice(t.start, t.end).toUpperCase() : '')

function statementProblem(script: string, code: Token[], family: string): string | undefined {
  const words = code.map((t) => word(script, t))
  // A parenthesised query: its first word counts.
  let first = 0
  while (code[first] && code[first]!.kind === 'op' && script[code[first]!.start] === '(') first++
  const head = words[first] ?? ''
  const starts = STARTS[family] ?? STARTS.postgres!
  if (!starts.has(head)) return `Only reads are allowed here (read-only): a statement starting with ${head || script.slice(code[0]!.start, code[0]!.end)} is not run.`
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!
    if (NEVER.has(w)) return `Only reads are allowed here (read-only): ${w} is not.`
    // UPDATE only in FOR UPDATE / FOR NO KEY UPDATE (row locks): refused too, a read takes no locks here.
    if (w === 'UPDATE') return 'Only reads are allowed here (read-only): UPDATE is not.'
    // (REPLACE(…) is a string function; REPLACE INTO is MySQL's insert.)
    if (w === 'REPLACE' && script[code[k + 1]?.start ?? -1] !== '(') return 'Only reads are allowed here (read-only): REPLACE is not.'
    if ((w === 'START' && words[k + 1] === 'TRANSACTION') || (w === 'RELEASE' && words[k + 1] === 'SAVEPOINT') || (w === 'LOAD' && (words[k + 1] === 'DATA' || words[k + 1] === 'XML'))) return `Only reads are allowed here (read-only): ${w} ${words[k + 1]} is not.`
    if (w === 'FOR' && ['SHARE', 'KEY', 'NO'].includes(words[k + 1] ?? '')) return 'Only reads are allowed here (read-only): row locks are not.'
  }
  // EXPLAIN ANALYZE runs what it explains: only of a read.
  if (head === 'EXPLAIN' && words.some((w) => w === 'ANALYZE' || w === 'ANALYSE')) {
    const rest = words.slice(first + 1).find((w) => ['SELECT', 'WITH', 'VALUES', 'TABLE'].includes(w))
    if (!rest) return 'Only reads are allowed here (read-only): EXPLAIN ANALYZE of something that is not a query is not.'
  }
  // A transaction ends with END in PostgreSQL: only CASE … END is allowed.
  const cases = words.filter((w) => w === 'CASE').length
  const ends = words.filter((w) => w === 'END').length
  if (family !== 'mssql' && ends > cases) return 'Only reads are allowed here (read-only): END is not.'
  if (family === 'mssql') {
    // T-SQL: SET only of a variable (SET @x = …), BEGIN only of a block (not TRAN), no transaction words anywhere.
    for (let k = 0; k < words.length; k++) {
      const w = words[k]!
      if (w === 'SET' && !/^@/.test(script.slice(code[k + 1]?.start ?? 0, code[k + 1]?.end ?? 0))) {
        // (SET is also part of UPDATE … SET, refused above.)
        return 'Only reads are allowed here (read-only): SET is only for variables (SET @x = …).'
      }
      if (w === 'BEGIN' && ['TRAN', 'TRANSACTION', 'DISTRIBUTED', 'DIALOG', 'CONVERSATION'].includes(words[k + 1] ?? '')) return 'Only reads are allowed here (read-only): BEGIN TRANSACTION is not.'
      if (w === 'SAVE' && ['TRAN', 'TRANSACTION'].includes(words[k + 1] ?? '')) return 'Only reads are allowed here (read-only): SAVE TRANSACTION is not.'
      if (w === 'GO' || w === 'USE' || w === 'SETUSER' || w === 'REVERT') return `Only reads are allowed here (read-only): ${w} is not.`
    }
    // A name that starts with sp_ / xp_ at the head of a batch runs a procedure without EXEC.
    if (/^(SP|XP)_/.test(head)) return 'Only reads are allowed here (read-only): procedures are not.'
  }
  if (head === 'SET' && family !== 'mssql') return 'Only reads are allowed here (read-only): SET is not.'
  if (head === 'PRAGMA') {
    const name = words[first + 1]?.toLowerCase() ?? ''
    const after = code[first + 2] ? script.slice(code[first + 2]!.start, code[first + 2]!.end) : ''
    // (A schema-qualified pragma: main.table_info(t).)
    const [pragma, sign] = after === '.' ? [words[first + 3]?.toLowerCase() ?? '', code[first + 4] ? script.slice(code[first + 4]!.start, code[first + 4]!.end) : ''] : [name, after]
    if (sign === '=') return 'Only reads are allowed here (read-only): a PRAGMA that sets something is not.'
    if (sign === '(' ? !READ_PRAGMAS_WITH_ARGUMENT.has(pragma) : !READ_PRAGMAS.has(pragma)) return `Only reads are allowed here (read-only): PRAGMA ${pragma} is not.`
  }
  return undefined
}

/**
 * A raw grid filter (typed, or written by AI) is a condition only: it reads completely, has no statement separator
 * and no unbalanced parenthesis, and `SELECT 1 WHERE (condition)` is a read.
 */
export function conditionVerdict(condition: string, driver: DriverId | string, modes: LexModes = {}): { ok: boolean; reason?: string } {
  const lexed = lex(condition, driver, modes)
  if (!lexed.ok) return { ok: false, reason: `The filter could not be read completely (${lexed.reason}).` }
  let depth = 0
  for (const t of lexed.tokens) {
    if (t.kind === 'semicolon' || t.kind === 'code-open' || t.kind === 'code-close') return { ok: false, reason: 'A filter is one condition.' }
    if (t.kind === 'op' && condition[t.start] === '(') depth++
    if (t.kind === 'op' && condition[t.start] === ')' && --depth < 0) return { ok: false, reason: 'A filter is one condition.' }
    if (familyOf(driver) === 'mssql' && t.kind === 'word' && /^go$/i.test(condition.slice(t.start, t.end))) return { ok: false, reason: 'A filter is one condition.' }
  }
  if (depth !== 0) return { ok: false, reason: 'A filter is one condition.' }
  const probe = readVerdict(`SELECT 1 WHERE (${condition})`, driver, modes)
  return probe.ok && probe.statements.length === 1 ? { ok: true } : { ok: false, reason: probe.reason ?? 'A filter is one condition.' }
}

import { codeTokens, familyOf, lex, tokenStatements, type LexModes, type Token } from './sql-lexer.js'
import type { DriverId } from './types.js'

/**
 * Whether SQL may run on the guarded path: decided on the tokens of sql-lexer.ts (input it can't read completely
 * is refused), by an allowlist of what may start a statement, words that never belong in a read, and a list of
 * functions that have effects a read-only transaction doesn't stop (REFUSED_CALLS). One layer of several: the engine
 * also runs such SQL one statement per call where the protocol allows, inside a read-only transaction whose state
 * it checks after every statement, and asks SQL Server for its own plan (engine.ts runUnconfirmed).
 *
 * Two profiles, because two different people are behind this path:
 * - `agent`: SQL nobody confirmed (AI assistant, MCP agents): an adversary may have written it. Reads only.
 * - `user`: the user's own SQL in the editor on a connection they marked read-only: the same layers, and a few
 *   harmless session statements so that ordinary read work isn't refused (USER_SESSION below).
 */
export type ReadProfile = 'agent' | 'user'

export interface ReadOptions {
  modes?: LexModes
  profile?: ReadProfile
}

export interface ReadVerdict {
  ok: boolean
  reason?: string
  /**
   * The statements to run, as the server takes them ([start, end) offsets into the script): one per call where the
   * protocol allows it, a whole batch for SQL Server. `session`: a PostgreSQL SET or RESET of the user profile,
   * run outside the read-only transaction so that it lasts on the tab's session.
   */
  statements: { start: number; end: number; text: string; session?: boolean }[]
}

/** What may start a statement nobody confirmed, per dialect family. */
const STARTS: Record<string, Set<string>> = {
  postgres: new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'SHOW', 'EXPLAIN', 'FROM', 'SUMMARIZE', 'DESCRIBE']),
  mysql: new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'SHOW', 'EXPLAIN', 'DESCRIBE', 'DESC']),
  // T-SQL batches: variables and conditions are part of reading; the server's own plan decides on the rest.
  mssql: new Set(['SELECT', 'WITH', 'DECLARE', 'SET', 'IF', 'BEGIN', 'END', 'ELSE', 'PRINT']),
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

/**
 * Functions with effects a read-only transaction doesn't stop, refused on the guarded path wherever they are
 * called (also schema-qualified or quoted). A name list closes the known doors only: what the guard promises is that
 * no data is changed or deleted and no transaction escapes; a login used with AI or agents should have only the
 * rights it needs (SECURITY.md). `*` ends a prefix.
 */
const REFUSED_CALLS: [families: string[], name: string, what: string][] = [
  [['postgres'], 'pg_terminate_backend', "ends another session's connection"],
  [['postgres'], 'pg_cancel_backend', "cancels another session's query"],
  [['postgres'], 'pg_read_file', 'reads a file on the server'],
  [['postgres'], 'pg_read_binary_file', 'reads a file on the server'],
  [['postgres'], 'pg_stat_file', 'reads file details on the server'],
  [['postgres'], 'pg_ls_*', 'lists server directories (logs, WAL, data)'],
  [['postgres'], 'pg_file_*', 'writes, renames or deletes server files (adminpack)'],
  [['postgres'], 'pg_advisory_*', 'takes an advisory lock that outlives the statement'],
  [['postgres'], 'pg_try_advisory_*', 'takes an advisory lock that outlives the statement'],
  [['postgres'], 'lo_*', 'large objects: lo_import and lo_export read and write server files'],
  [['postgres'], 'dblink*', 'runs SQL over another connection, outside the read-only transaction'],
  [['postgres'], 'query_to_xml*', 'runs the SQL text it is given'],
  [['postgres'], 'cursor_to_xml*', 'reads a cursor the SQL text opened'],
  [['postgres'], 'ts_stat', 'runs the SQL text it is given'],
  [['postgres'], 'pg_notify', 'sends a notification to listeners'],
  [['postgres'], 'set_config', 'changes settings, also the ones the guard relies on'],
  [['postgres'], 'pg_sleep*', 'holds the session for as long as it is told'],
  [['postgres'], 'pg_reload_conf', 'reloads the server configuration'],
  [['postgres'], 'pg_rotate_logfile', 'rotates the server log'],
  [['postgres'], 'pg_switch_wal', 'switches the write-ahead log'],
  [['postgres'], 'pg_create_restore_point', 'writes a restore point'],
  [['postgres'], 'pg_logical_emit_message', 'writes a message into the write-ahead log'],
  [['postgres'], 'pg_promote', 'promotes a standby'],
  [['postgres'], 'pg_backup_*', 'starts or stops a backup'],
  [['postgres'], 'nextval', 'advances a sequence'],
  [['postgres'], 'setval', 'sets a sequence'],
  [['postgres'], 'getenv', "reads the machine's environment (DuckDB)"],
  [['mysql'], 'get_lock', 'takes a named lock that outlives the statement'],
  [['mysql'], 'release_lock', 'releases a named lock'],
  [['mysql'], 'release_all_locks', 'releases named locks'],
  [['mysql'], 'load_file', 'reads a file on the server'],
  [['mysql'], 'sleep', 'holds the connection for as long as it is told'],
  [['mysql'], 'benchmark', 'runs an expression a given number of times'],
  [['mysql'], 'master_pos_wait', 'waits on replication'],
  [['mysql'], 'source_pos_wait', 'waits on replication'],
  [['mysql'], 'wait_for_executed_gtid_set', 'waits on replication'],
  [['mysql'], 'sys_exec', 'runs a command on the server (a UDF)'],
  [['mysql'], 'sys_eval', 'runs a command on the server (a UDF)'],
  [['mssql'], 'openrowset', 'reads files or other servers'],
  [['mssql'], 'openquery', 'runs SQL on a linked server'],
  [['mssql'], 'opendatasource', 'connects to another server'],
  [['mssql'], 'xp_*', 'extended procedures (files, commands, registry)'],
  [['mssql'], 'sp_*', 'system procedures'],
  [['mssql'], 'fn_xe_file_target_read_file', 'reads files on the server'],
  [['mssql'], 'fn_get_audit_file', 'reads files on the server'],
  [['mssql'], 'fn_trace_gettable', 'reads files on the server'],
  [['oracle'], 'utl_*', 'UTL_FILE, UTL_HTTP, UTL_TCP, UTL_SMTP: files and the network'],
  [['oracle'], 'dbms_*', 'DBMS_ packages: locks, pipes, jobs, alerts, LOBs on files'],
  [['oracle'], 'httpuritype', 'fetches a URL'],
  [['oracle'], 'sys_context', 'reads session details (harmless, but some contexts are not)'],
  [['clickhouse'], 'file', 'reads files on the server'],
  [['clickhouse'], 'url', 'fetches a URL'],
  [['clickhouse'], 'urlcluster', 'fetches URLs'],
  [['clickhouse'], 'remote', 'connects to another server'],
  [['clickhouse'], 'remotesecure', 'connects to another server'],
  [['clickhouse'], 'cluster', 'runs on other servers of a cluster'],
  [['clickhouse'], 'clusterallreplicas', 'runs on other servers of a cluster'],
  [['clickhouse'], 's3*', 'reads object storage'],
  [['clickhouse'], 'gcs', 'reads object storage'],
  [['clickhouse'], 'azureblobstorage*', 'reads object storage'],
  [['clickhouse'], 'hdfs*', 'reads HDFS'],
  [['clickhouse'], 'mysql', 'connects to a MySQL server'],
  [['clickhouse'], 'postgresql', 'connects to a PostgreSQL server'],
  [['clickhouse'], 'mongodb', 'connects to a MongoDB server'],
  [['clickhouse'], 'redis', 'connects to a Redis server'],
  [['clickhouse'], 'sqlite', 'opens an SQLite file on the server'],
  [['clickhouse'], 'jdbc', 'connects through JDBC'],
  [['clickhouse'], 'odbc', 'connects through ODBC'],
  [['clickhouse'], 'executable', 'runs a program on the server'],
  [['clickhouse'], 'input', 'reads the request body'],
  [['clickhouse'], 'deltalake*', 'reads object storage'],
  [['clickhouse'], 'hudi*', 'reads object storage'],
  [['clickhouse'], 'iceberg*', 'reads object storage'],
  [['clickhouse'], 'sleep*', 'holds the query for as long as it is told'],
  [['sqlite'], 'load_extension', 'loads native code'],
  [['bigquery'], 'external_query', 'runs SQL on an external database'],
  [['trino'], 'query', 'passes SQL through to the connector, which may write'],
]

/** PostgreSQL settings the user profile may SET or RESET: none of them can weaken the guard. */
const PG_SETTINGS = new Set(['search_path', 'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout', 'datestyle', 'intervalstyle', 'timezone', 'application_name', 'work_mem', 'jit', 'extra_float_digits', 'client_min_messages'])
/** SQL Server SET options the user profile may use. */
const MSSQL_OPTIONS = new Set(['NOCOUNT', 'ROWCOUNT', 'DATEFORMAT', 'LANGUAGE', 'ARITHABORT', 'DATEFIRST', 'TEXTSIZE', 'CONCAT_NULL_YIELDS_NULL', 'NUMERIC_ROUNDABORT', 'QUOTED_IDENTIFIER', 'STATISTICS'])

/** SQLite pragmas that only report something (see sql-split.ts READ_PRAGMAS). */
const READ_PRAGMAS = new Set(
  'application_id auto_vacuum automatic_index busy_timeout cache_size cache_spill cell_size_check checkpoint_fullfsync collation_list compile_options data_version database_list defer_foreign_keys encoding foreign_key_check foreign_key_list foreign_keys freelist_count fullfsync function_list hard_heap_limit ignore_check_constraints index_info index_list index_xinfo integrity_check journal_mode journal_size_limit legacy_alter_table locking_mode max_page_count mmap_size module_list page_count page_size pragma_list query_only quick_check read_uncommitted recursive_triggers reverse_unordered_selects schema_version secure_delete soft_heap_limit synchronous table_info table_list table_xinfo temp_store threads trusted_schema user_version wal_autocheckpoint'.split(' '),
)
const READ_PRAGMAS_WITH_ARGUMENT = new Set('foreign_key_check foreign_key_list index_info index_list index_xinfo integrity_check quick_check table_info table_list table_xinfo'.split(' '))

/** The sentence a refusal starts with: what the person behind the SQL can do about it differs. */
const refuse = (profile: ReadProfile, what: string, instead?: string) =>
  profile === 'user' ? `This connection is read-only: ${what} can't be run here. ${instead ?? "Open the connection's settings to allow writes."}` : `Only reads are allowed here (read-only): ${what} is not.`

export function readVerdict(script: string, driver: DriverId | string, options: ReadOptions | LexModes = {}): ReadVerdict {
  const { modes = {}, profile = 'agent' } = 'profile' in options || 'modes' in options ? (options as ReadOptions) : { modes: options as LexModes }
  const family = familyOf(driver)
  // MySQL and MariaDB write and read server files with these; there is no server-side stop for them in a read-only
  // transaction, so they are refused anywhere in the text, inside strings and comments too.
  if (family === 'mysql' && /outfile|dumpfile|load_file/i.test(script)) {
    return { ok: false, reason: profile === 'user' ? "This connection is read-only: OUTFILE, DUMPFILE and LOAD_FILE can't be used here, not even inside strings or comments (they write and read files on the server)." : 'Only reads are allowed here (read-only): OUTFILE, DUMPFILE and LOAD_FILE are not, not even inside strings or comments (they write and read files on the server).', statements: [] }
  }
  const lexed = lex(script, driver, modes)
  if (!lexed.ok) return { ok: false, reason: `It could not be read completely (${lexed.reason}), so it is not run.`, statements: [] }
  if (lexed.tokens.some((t) => t.kind === 'code-open')) return { ok: false, reason: refuse(profile, 'a comment MySQL or MariaDB runs as code (/*! … */, /*M! … */, /*+ … */)', 'Write it without the comment.'), statements: [] }
  // A block comment that starts with anything but a space (/*x): some databases run such comments as code, and a
  // form not known yet is not guessed at.
  const odd = lexed.tokens.find((t) => t.kind === 'comment' && script.startsWith('/*', t.start) && !/[\s*]/.test(script[t.start + 2] ?? ' '))
  if (odd && (profile === 'agent' || family === 'mysql')) return { ok: false, reason: refuse(profile, `a comment that starts ${script.slice(odd.start, odd.start + 3)}`, 'Put a space after /* or leave the comment out.'), statements: [] }
  const pieces = tokenStatements(script, lexed.tokens, driver)
  const out: ReadVerdict['statements'] = []
  for (const tokens of pieces) {
    const code = codeTokens(tokens)
    const start = tokens[0]!.start
    const end = tokens.at(-1)!.end
    const text = script.slice(start, end).trim()
    const session = profile === 'user' ? sessionStatement(script, code, String(driver)) : undefined
    const problem = session === undefined ? statementProblem(script, code, family, profile) : session ? undefined : undefined
    if (problem) return { ok: false, reason: problem, statements: out }
    const called = refusedCall(script, code, family)
    if (called) return { ok: false, reason: refuse(profile, called), statements: out }
    out.push({ start, end, text, ...(session ? { session: true } : {}) })
  }
  if (!out.length) return { ok: false, reason: 'There is no statement to run.', statements: out }
  // SQL Server runs a batch as one: it is planned and run whole (only GO separates batches).
  if (family === 'mssql') {
    const batches = tokenStatements(script, lexed.tokens, driver, { batches: true })
    return { ok: true, statements: batches.map((b) => ({ start: b[0]!.start, end: b.at(-1)!.end, text: script.slice(b[0]!.start, b.at(-1)!.end).trim() })) }
  }
  return { ok: true, statements: out }
}

const word = (script: string, t: Token) => (t.kind === 'word' ? script.slice(t.start, t.end).toUpperCase() : '')
const text = (script: string, t: Token | undefined) => (t ? script.slice(t.start, t.end) : '')

/**
 * A harmless session statement of the user profile: `true` when it must outlast the statement (PostgreSQL SET /
 * RESET, run outside the read-only transaction), `false` when it is run like a read, undefined when it is none.
 */
function sessionStatement(script: string, code: Token[], driver: string): boolean | undefined {
  const words = code.map((t) => word(script, t))
  const family = familyOf(driver)
  if (driver === 'postgres') {
    if (words[0] === 'RESET' && code.length === 2) return PG_SETTINGS.has(words[1]!.toLowerCase()) || /^ENABLE_/.test(words[1]!) ? true : undefined
    if (words[0] !== 'SET') return undefined
    let k = 1
    const local = words[k] === 'LOCAL'
    if (words[k] === 'SESSION' || local) k++
    // SET TIME ZONE x
    if (words[k] === 'TIME' && words[k + 1] === 'ZONE') return !local
    const name = words[k]?.toLowerCase() ?? ''
    if (!(PG_SETTINGS.has(name) || /^enable_/.test(name))) return undefined
    const sign = text(script, code[k + 1])
    if (!(sign === '=' || words[k + 1] === 'TO')) return undefined
    return !local
  }
  if (family === 'mysql') {
    if (words[0] === 'USE' && code.length === 2) return false
    if (words[0] === 'SET' && words[1] === 'NAMES') return false
    // SET @a = 1, @b = 2: user variables only (never @@ system variables, never sql_mode).
    if (words[0] === 'SET') {
      for (let k = 1; k < code.length; k++) if (text(script, code[k]) === '@' && text(script, code[k + 1]) === '@') return undefined
      const targets = code.filter((t, k) => k === 1 || text(script, code[k - 1]) === ',')
      return targets.every((t) => text(script, t) === '@') ? false : undefined
    }
  }
  return undefined
}

function statementProblem(script: string, code: Token[], family: string, profile: ReadProfile): string | undefined {
  const words = code.map((t) => word(script, t))
  // A parenthesised query: its first word counts.
  let first = 0
  while (code[first] && code[first]!.kind === 'op' && script[code[first]!.start] === '(') first++
  const head = words[first] ?? ''
  const starts = STARTS[family] ?? STARTS.postgres!
  const userMssql = profile === 'user' && family === 'mssql'
  // The user profile on SQL Server: USE and #temp tables are part of reading (the plan checks every write is a #temp one).
  const userStart = userMssql && (head === 'USE' || head === 'INSERT' || head === 'UPDATE' || head === 'DELETE')
  if (!starts.has(head) && !userStart) return refuse(profile, `a statement starting with ${head || text(script, code[0])}`)
  const temp = (t: Token | undefined) => !!t && /^#/.test(text(script, t))
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!
    // The user profile: SELECT … INTO @var (MySQL), SELECT … INTO #temp and writes to #temp (SQL Server).
    if (w === 'INTO' && profile === 'user' && family === 'mysql' && text(script, code[k + 1]) === '@' && text(script, code[k + 2]) !== '@') continue
    if (userMssql && (w === 'INTO' || w === 'INSERT' || w === 'UPDATE' || w === 'DELETE' || w === 'FROM')) {
      const target = w === 'INSERT' || (w === 'DELETE' && words[k + 1] === 'FROM') ? (words[k + 1] === 'INTO' || words[k + 1] === 'FROM' ? code[k + 2] : code[k + 1]) : code[k + 1]
      if (w === 'FROM') continue
      if (temp(target)) continue
    }
    if (userMssql && w === 'USE' && k === first) continue
    if (NEVER.has(w)) return refuse(profile, w)
    // UPDATE only in FOR UPDATE / FOR NO KEY UPDATE (row locks): refused too, a read takes no locks here.
    if (w === 'UPDATE') return refuse(profile, 'UPDATE')
    // (REPLACE(…) is a string function; REPLACE INTO is MySQL's insert.)
    if (w === 'REPLACE' && script[code[k + 1]?.start ?? -1] !== '(') return refuse(profile, 'REPLACE')
    if ((w === 'START' && words[k + 1] === 'TRANSACTION') || (w === 'RELEASE' && words[k + 1] === 'SAVEPOINT') || (w === 'LOAD' && (words[k + 1] === 'DATA' || words[k + 1] === 'XML'))) return refuse(profile, `${w} ${words[k + 1]}`)
    if (w === 'FOR' && ['SHARE', 'KEY', 'NO'].includes(words[k + 1] ?? '')) return refuse(profile, 'a row lock (FOR SHARE, FOR UPDATE)')
    // SQL Server's NEXT VALUE FOR advances a sequence.
    if (family === 'mssql' && w === 'NEXT' && words[k + 1] === 'VALUE' && words[k + 2] === 'FOR') return refuse(profile, 'NEXT VALUE FOR (it advances a sequence)')
  }
  // EXPLAIN ANALYZE runs what it explains: only of a read.
  if (head === 'EXPLAIN' && words.some((w) => w === 'ANALYZE' || w === 'ANALYSE')) {
    const rest = words.slice(first + 1).find((w) => ['SELECT', 'WITH', 'VALUES', 'TABLE'].includes(w))
    if (!rest) return refuse(profile, 'EXPLAIN ANALYZE of something that is not a query')
  }
  // A transaction ends with END in PostgreSQL: only CASE … END is allowed.
  const cases = words.filter((w) => w === 'CASE').length
  const ends = words.filter((w) => w === 'END').length
  if (family !== 'mssql' && ends > cases) return refuse(profile, 'END')
  if (family === 'mssql') {
    // T-SQL: SET only of a variable (SET @x = …) or, for the user profile, a listed option; BEGIN only of a block.
    for (let k = 0; k < words.length; k++) {
      const w = words[k]!
      // (UPDATE #temp SET …: the user profile's write to a #temp table, checked above and by the plan.)
      if (w === 'SET' && userMssql && words.slice(0, k).includes('UPDATE')) continue
      if (w === 'SET' && !/^@/.test(text(script, code[k + 1]))) {
        const option = words[k + 1] ?? ''
        if (!(profile === 'user' && (MSSQL_OPTIONS.has(option) || /^ANSI_/.test(option)))) return refuse(profile, `SET ${option}`, profile === 'user' ? 'Only SET NOCOUNT, ROWCOUNT, DATEFORMAT, LANGUAGE, ANSI_ options, ARITHABORT and variables are allowed here.' : undefined)
      }
      if (w === 'BEGIN' && ['TRAN', 'TRANSACTION', 'DISTRIBUTED', 'DIALOG', 'CONVERSATION'].includes(words[k + 1] ?? '')) return refuse(profile, 'BEGIN TRANSACTION')
      if (w === 'SAVE' && ['TRAN', 'TRANSACTION'].includes(words[k + 1] ?? '')) return refuse(profile, 'SAVE TRANSACTION')
      if (w === 'GO' || w === 'SETUSER' || w === 'REVERT' || (w === 'USE' && !userMssql)) return refuse(profile, w)
    }
  }
  if (head === 'SET' && family !== 'mssql') return refuse(profile, 'SET', profile === 'user' ? 'Only SET of search_path, statement_timeout, time zone and similar display settings (PostgreSQL), and USE, SET NAMES and @variables (MySQL) are allowed here.' : undefined)
  if (head === 'PRAGMA') {
    const name = words[first + 1]?.toLowerCase() ?? ''
    const after = text(script, code[first + 2])
    // (A schema-qualified pragma: main.table_info(t).)
    const [pragma, sign] = after === '.' ? [words[first + 3]?.toLowerCase() ?? '', text(script, code[first + 4])] : [name, after]
    if (sign === '=') return refuse(profile, 'a PRAGMA that sets something')
    if (sign === '(' ? !READ_PRAGMAS_WITH_ARGUMENT.has(pragma) : !READ_PRAGMAS.has(pragma)) return refuse(profile, `PRAGMA ${pragma}`)
  }
  return undefined
}

/** A call (or, for prefixes, any name) of REFUSED_CALLS in the code: what it is and does, or undefined. */
function refusedCall(script: string, code: Token[], family: string): string | undefined {
  const entries = REFUSED_CALLS.filter(([families]) => families.includes(family))
  for (let k = 0; k < code.length; k++) {
    const t = code[k]!
    if (t.kind !== 'word' && t.kind !== 'ident') continue
    const name = (t.kind === 'ident' ? (t.value ?? '') : text(script, t)).toLowerCase()
    const call = text(script, code[k + 1]) === '('
    const member = text(script, code[k + 1]) === '.'
    for (const [, entry, what] of entries) {
      const prefix = entry.endsWith('*') ? entry.slice(0, -1) : undefined
      // A prefix (UTL_, DBMS_, xp_, pg_advisory_…) counts called or as a package; a plain name only when called.
      const hit = prefix ? name.startsWith(prefix) && (call || member || family === 'oracle' || family === 'mssql') : name === entry && call
      if (hit) return `${name}() (it ${what})`
    }
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
  const probe = readVerdict(`SELECT 1 WHERE (${condition})`, driver, { modes })
  return probe.ok && probe.statements.length === 1 ? { ok: true } : { ok: false, reason: probe.reason ?? 'A filter is one condition.' }
}

/** The refused-call table, for SECURITY.md and tests: [families, name (a `*` ends a prefix), what it does]. */
export const refusedCalls = (): readonly (readonly [string[], string, string])[] => REFUSED_CALLS

/**
 * SQL text from another tool's file (drawDB, MySQL Workbench, Mermaid): a stranger's file can put anything into a
 * default, a check or a type, and these end up in the scripts the app runs. Only what a conservative grammar
 * recognises is taken as SQL; the rest is kept as a note on the column and counted as left out.
 */

// A string literal without backslashes: MySQL reads `\'` as an escaped quote where other databases end the string.
const LITERAL = String.raw`N?'(?:[^'\\]|'')*'`
const NUMBER = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?`
const TYPE_WORDS = String.raw`[A-Za-z_][\w.]*(?:\s+[A-Za-z_]\w*)*`

/** Words a type name may continue with, and modifiers after its arguments (nothing else follows a type). */
const TYPE_FOLLOW = new Set(
  'precision varying character char varchar varbinary binary text blob raw large object national nchar double long int integer time timestamp zone with without local unsigned signed zerofill interval year month day hour minute second to bit byte varbit array'.split(' '),
)
/** Modifiers that take a name after them: `charset utf8mb4`, `character set latin1`, `collate utf8mb4_bin`. */
const NAMED = new Set(['charset', 'set', 'collate'])

/**
 * A column type: a type name (a word, or a schema-qualified one, then words of the type vocabulary: `double
 * precision`, `character varying`), optional arguments (numbers, `max`, plain literals for enum values, words such
 * as PostGIS's `Point`), an optional `[]`, and known modifiers (unsigned, zerofill, with/without time zone,
 * charset/collate with a name). Nothing else: `int references victim on delete cascade` is no type. Read token by
 * token (linear: no regex can backtrack over a long input).
 */
export function isPlainType(type: string): boolean {
  const s = type.trim()
  if (!s || s.length > 4096) return false
  const token = new RegExp(String.raw`\s+|${LITERAL}|\d+|[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*|[(),\[\]]`, 'y')
  let depth = 0
  let words = 0
  let named = false
  let closedArgs = false
  for (let i = 0; i < s.length; ) {
    token.lastIndex = i
    const t = token.exec(s)?.[0]
    if (!t) return false
    i += t.length
    if (/^\s/.test(t)) continue
    if (t === '(') {
      if (depth || closedArgs || !words) return false
      depth = 1
      continue
    }
    if (t === ')') {
      if (!depth) return false
      depth = 0
      closedArgs = true
      continue
    }
    if (depth) {
      // Inside the arguments: numbers, literals, words, commas.
      continue
    }
    // Numbers, literals and commas belong inside the arguments.
    if (t === ',' || /^N?'/.test(t) || /^\d/.test(t)) return false
    if (t === '[') {
      if (s[i] !== ']' && !/^\d+\]/.test(s.slice(i, i + 12))) return false
      i = s.indexOf(']', i) + 1
      continue
    }
    if (t === ']') return false
    // A word.
    const w = t.toLowerCase()
    if (named) {
      named = false
      continue
    }
    if (NAMED.has(w) && words) {
      named = true
      continue
    }
    if (words && !TYPE_FOLLOW.has(w)) return false
    if (words && w.includes('.')) return false
    words++
  }
  return !depth && !named && words > 0
}

/** Functions a default may call, with no arguments or literal ones only. */
const DEFAULT_FUNCTIONS = new Set(
  ['now', 'gen_random_uuid', 'uuid', 'uuid_generate_v4', 'uuid_generate_v1', 'getdate', 'getutcdate', 'sysdatetime', 'sysutcdatetime', 'sysdatetimeoffset', 'newid', 'newsequentialid', 'current_timestamp', 'localtimestamp', 'current_date', 'current_time', 'curdate', 'curtime', 'utc_timestamp', 'utc_date', 'random', 'datetime', 'date', 'time', 'strftime', 'nextval', 'transaction_timestamp', 'statement_timestamp', 'clock_timestamp', 'timezone', 'sys_guid', 'systimestamp', 'sysdate', 'unix_timestamp', 'json_array', 'json_object', 'to_jsonb', 'array'].map((f) => f.toLowerCase()),
)
const KEYWORD_DEFAULT = /^(?:current_timestamp|current_date|current_time|localtimestamp|localtime|sysdate|systimestamp)(?:\s*\(\s*\d*\s*\))?$/i
const CAST = String.raw`(?:\s*::\s*${TYPE_WORDS}(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(?:\[\])?)?`
const VALUE = new RegExp(String.raw`^(?:${NUMBER}|${LITERAL}|[bBxX]'[0-9a-fA-F]*'|true|false|null)${CAST}$`, 'i')
const CALL = new RegExp(String.raw`^([A-Za-z_]\w*)\s*\(\s*((?:${NUMBER}|${LITERAL})${CAST}(?:\s*,\s*(?:${NUMBER}|${LITERAL})${CAST})*)?\s*\)${CAST}$`)

/** A default that is a value or a known function call (as SQL), else undefined. Outer parentheses are MySQL 8's. */
export function plainDefault(text: string): string | undefined {
  const v = text.trim()
  if (!v || v.length > 4096) return undefined
  const inner = /^\((.*)\)$/s.exec(v)?.[1]
  if (inner !== undefined) return plainDefault(inner) !== undefined ? v : undefined
  if (VALUE.test(v) || KEYWORD_DEFAULT.test(v)) return v
  const call = CALL.exec(v)
  return call && DEFAULT_FUNCTIONS.has(call[1]!.toLowerCase()) ? v : undefined
}

export interface CheckOptions {
  /** Whether double-quoted names may stay (the file's database is known and is not MySQL or MariaDB). */
  doubleQuotes?: boolean
}

/** Whether a file's database reads double quotes as identifiers (unknown: maybe MySQL, so no). */
export const readsDoubleQuotesAsNames = (database: string | undefined) => !!database && database !== 'mysql' && database !== 'mariadb'

/**
 * An index part from another tool's file: a column of the table (as named there), or a parenthesised expression the
 * check grammar takes. Anything else is no index part.
 */
export function plainIndexPart(part: string, columns: string[], options: CheckOptions = {}): string | undefined {
  if (columns.includes(part)) return part
  const s = part.trim()
  return /^\(.*\)$/s.test(s) && isPlainCheck(s, options) ? s : undefined
}

/** Words that never belong in a check condition (statements, not expressions). */
const STATEMENT = /^(select|insert|update|delete|drop|create|alter|truncate|grant|revoke|exec|execute|call|merge|commit|rollback|begin|declare|set|into|from|union|load|copy|attach|detach|pragma|shutdown|kill|waitfor|go)$/i

/**
 * A check condition made of names, numbers, plain literals, operators and balanced parentheses only: nothing in
 * it can end the CHECK ( … ) it is written into (no semicolon, comment, unbalanced parenthesis or literal a database
 * reads differently) or start a statement.
 */
export function isPlainCheck(text: string, options: CheckOptions = {}): boolean {
  const s = text.trim()
  if (!s || s.length > 4096) return false
  // No quoted token holds a backslash (MySQL reads `\"` as an escape and the text after as code). Double quotes are
  // identifiers in standard SQL but strings in MySQL: taken only where the file's database is known not to be one.
  const token = new RegExp(String.raw`\s+|${LITERAL}|${NUMBER}|"[^"\\]*"|\x60[^\x60\\]*\x60|\[[^\]\\]*\]|[A-Za-z_][\w$]*|::|<>|!=|<=|>=|\|\||[=<>+\-*/%(),~.]`, 'y')
  let depth = 0
  for (let i = 0; i < s.length; ) {
    token.lastIndex = i
    const m = token.exec(s)
    if (!m || !m[0]) return false
    const t = m[0]
    if (t[0] === '"' && !options.doubleQuotes) return false
    if (t === '-' && s[i + 1] === '-') return false
    if (t === '/' && s[i + 1] === '*') return false
    if (t === '(') depth++
    else if (t === ')' && --depth < 0) return false
    else if (t === ',' && depth === 0) return false
    else if (STATEMENT.test(t)) return false
    i += t.length
  }
  return depth === 0
}

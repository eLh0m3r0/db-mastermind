/**
 * SQL text from another tool's file (drawDB, MySQL Workbench, Mermaid): a stranger's file can put anything into a
 * default, a check or a type, and these end up in the scripts the app runs. Only what a conservative grammar
 * recognises is taken as SQL; the rest is kept as a note on the column and counted as left out.
 */

// A string literal without backslashes: MySQL reads `\'` as an escaped quote where other databases end the string.
const LITERAL = String.raw`N?'(?:[^'\\]|'')*'`
const NUMBER = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?`
const TYPE_WORDS = String.raw`[A-Za-z_][\w.]*(?:\s+[A-Za-z_]\w*)*`
const TYPE_ARG = String.raw`(?:\d+|max|${LITERAL})`
const TYPE = new RegExp(String.raw`^${TYPE_WORDS}(?:\s*\(\s*${TYPE_ARG}(?:\s*,\s*${TYPE_ARG})*\s*\))?(?:\s+[A-Za-z_]\w*)*(?:\s*\[\s*\d*\s*\])*$`)

/** A column type: words, an optional argument list of numbers or plain literals (enum values), `[]`. */
export function isPlainType(type: string): boolean {
  return type.length <= 4096 && TYPE.test(type.trim())
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

/** Words that never belong in a check condition (statements, not expressions). */
const STATEMENT = /^(select|insert|update|delete|drop|create|alter|truncate|grant|revoke|exec|execute|call|merge|commit|rollback|begin|declare|set|into|from|union|load|copy|attach|detach|pragma|shutdown|kill|waitfor|go)$/i

/**
 * A check condition made of names, numbers, plain literals, operators and balanced parentheses only: nothing in
 * it can end the CHECK ( … ) it is written into (no semicolon, comment, unbalanced parenthesis or literal a database
 * reads differently) or start a statement.
 */
export function isPlainCheck(text: string): boolean {
  const s = text.trim()
  if (!s || s.length > 4096) return false
  const token = new RegExp(String.raw`\s+|${LITERAL}|${NUMBER}|"[^"]*"|\x60[^\x60]*\x60|\[[^\]]*\]|[A-Za-z_][\w$]*|::|<>|!=|<=|>=|\|\||[=<>+\-*/%(),~.]`, 'y')
  let depth = 0
  for (let i = 0; i < s.length; ) {
    token.lastIndex = i
    const m = token.exec(s)
    if (!m || !m[0]) return false
    const t = m[0]
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

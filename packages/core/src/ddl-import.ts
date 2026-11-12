import { DuckDBDriver } from './drivers/duckdb.js'
import { splitStatements } from './sql-split.js'
import type { TableInfo } from './types.js'

export interface DdlImportResult {
  tables: TableInfo[]
  /** Statements DuckDB couldn't run (skipped). */
  skipped: { sql: string; error: string }[]
}

/** Applies `change` to the text outside string literals and comments, so that what they say stays as written. */
function outsideStrings(sql: string, change: (code: string) => string): string {
  let out = ''
  let last = 0
  for (const m of sql.matchAll(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g)) {
    out += change(sql.slice(last, m.index)) + m[0]
    last = m.index + m[0].length
  }
  return out + change(sql.slice(last))
}

/** Smooths over dialect syntax DuckDB doesn't speak (MySQL, SQL Server, PostgreSQL extras). */
function normalize(sql: string): string {
  // Table options and MySQL column comments take their literal along; everything else leaves literals alone
  // (a comment that mentions DATETIME or [brackets] is not a type or a name).
  const whole = sql
    .replace(/^\s*GO\s*$/gim, ';')
    // Table options (ENGINE=…, CHARSET=…) always have '='; column COLLATE doesn't.
    .replace(/\)\s*(?:ENGINE|DEFAULT\s+CHARSET|CHARSET|COLLATE|ROW_FORMAT|COMMENT|AUTO_INCREMENT)\b(?:'(?:[^']|'')*'|[^;()'])*;/gi, ');')
    .replace(/\bCOMMENT\s+'(?:[^']|'')*'/gi, '')
  return outsideStrings(whole, (code) =>
    code
      // Default schemas map to DuckDB's main schema.
      .replace(/(^|[\s(,])(?:"?public"?|"?dbo"?|\[dbo\])\s*\.\s*(?=["\[`\w])/gi, '$1')
      .replace(/`([^`]+)`/g, '"$1"')
      .replace(/\[([^\]\r\n]+)\]/g, '"$1"')
      // SSMS brackets type names too: [int], [nvarchar](max).
      .replace(/"(int|bigint|smallint|tinyint|bit|nvarchar|varchar|nchar|char|datetime2?|smalldatetime|date|time|datetimeoffset|decimal|numeric|float|real|money|smallmoney|uniqueidentifier|varbinary|binary|text|ntext|xml|image|sysname)"/gi, '$1')
      .replace(/\s+(ASC|DESC)(?=\s*[,)])/gi, '')
      .replace(/\b(TEXTIMAGE_ON|ON)\s+"PRIMARY"/gi, '')
      .replace(/\bIDENTITY\s*\(\s*\d+\s*,\s*\d+\s*\)/gi, '')
      .replace(/\bAUTO_INCREMENT\b(\s*=\s*\d+)?/gi, '')
      .replace(/\b(GENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY(\s*\([^)]*\))?)/gi, '')
      .replace(/\b(CHARACTER\s+SET|CHARSET)\s+\w+/gi, '')
      .replace(/\bCOLLATE\s+"?[\w.]+"?/gi, '')
      .replace(/\bUNSIGNED\b/gi, '')
      .replace(/\b(N?VARCHAR|NCHAR|VARBINARY)\s*\(\s*MAX\s*\)/gi, '$1')
      .replace(/\bON\s+UPDATE\s+CURRENT_TIMESTAMP(\(\d*\))?/gi, '')
      .replace(/\bWITH\s*\((?:[^()]|\([^)]*\))*\)\s*(ON\s+"?PRIMARY"?)?/gi, '')
      .replace(/\bON\s+PRIMARY\b/gi, '')
      .replace(/\bCLUSTERED\b|\bNONCLUSTERED\b/gi, '')
      .replace(/\bDATETIME2\b|\bSMALLDATETIME\b/gi, 'TIMESTAMP')
      .replace(/\bDATETIME\b/gi, 'TIMESTAMP')
      .replace(/\b(TINYTEXT|MEDIUMTEXT|LONGTEXT|NTEXT)\b/gi, 'TEXT')
      .replace(/\bNVARCHAR\b/gi, 'VARCHAR')
      .replace(/\b(MEDIUMINT)\b/gi, 'INTEGER')
      .replace(/\bBIT\b/gi, 'BOOLEAN')
      .replace(/\bTINYINT\s*\(\s*1\s*\)/gi, 'BOOLEAN')
      .replace(/\b(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT)\s*\(\s*\d+\s*\)/gi, '$1')
      .replace(/\bJSONB\b/gi, 'JSON')
      .replace(/\bBYTEA\b/gi, 'BLOB')
      .replace(/\b(CITEXT|INET|CIDR|MACADDR|TSVECTOR)\b/gi, 'VARCHAR')
      .replace(/(CREATE\s+SEQUENCE\s+\S+)\s+AS\s+\w+/gi, '$1')
      .replace(/\bUSING\s+(btree|hash|gin|gist|brin)\b/gi, '')
      .replace(/\bSERIAL\b/gi, 'INTEGER')
      .replace(/\bBIGSERIAL\b/gi, 'BIGINT'),
  )
}

const RELEVANT = /^\s*(CREATE\s+(TABLE|UNIQUE\s+INDEX|INDEX|VIEW)|COMMENT\s+ON)\b/i
const NAME = String.raw`(?:"[^"]+"|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|[\w$]+))?`
const tableKey = (name: string) => name.replace(/"/g, '').split('.').pop()!.trim().toLowerCase()

/** Statement text without the comments dumps put in front of it. */
function stripLeadingComments(sql: string): string {
  let s = sql
  for (;;) {
    const t = s.replace(/^\s*--[^\n]*\n?/, '').replace(/^\s*\/\*(?!!)[\s\S]*?\*\//, '')
    if (t === s) return s.trim()
    s = t
  }
}

/** MySQL declares indexes inside CREATE TABLE (`KEY name (cols)`): move them to CREATE INDEX statements. */
function extractInlineIndexes(statement: string): string[] {
  const m = new RegExp(`^\\s*CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${NAME})\\s*\\(`, 'i').exec(statement)
  if (!m) return [statement]
  const indexes: string[] = []
  const lines = statement.split('\n')
  const kept: string[] = []
  for (const line of lines) {
    const ix = /^\s*(UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?(?:KEY|INDEX)\s+("[^"]+"|[\w$]+)\s*(\([^)]*\))\s*,?\s*$/i.exec(line)
    if (!ix) {
      kept.push(line)
      continue
    }
    if (/FULLTEXT|SPATIAL/i.test(ix[1] ?? '')) continue
    const cols = ix[3]!.replace(/\(\d+\)/g, '')
    indexes.push(`CREATE ${ix[1]?.trim().toUpperCase() === 'UNIQUE' ? 'UNIQUE ' : ''}INDEX ${ix[2]} ON ${m[1]} ${cols}`)
  }
  // Removing lines can leave a dangling comma before the closing parenthesis.
  const body = kept.join('\n').replace(/,(\s*\n\s*\))/, '$1')
  return [body, ...indexes]
}

/**
 * DuckDB can't add keys to an existing table, but dumps declare them with ALTER TABLE … ADD CONSTRAINT after
 * the CREATE TABLE: fold those clauses into the CREATE statements.
 */
function foldConstraints(statements: string[]): string[] {
  const creates = new Map<string, number>()
  statements.forEach((s, i) => {
    const m = new RegExp(`^\\s*CREATE\\s+(?:UNLOGGED\\s+|TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${NAME})`, 'i').exec(s)
    if (m) creates.set(tableKey(m[1]!), i)
  })
  const out = [...statements]
  for (let i = 0; i < out.length; i++) {
    const m = new RegExp(`^\\s*ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(?:IF\\s+EXISTS\\s+)?(${NAME})\\s+ADD\\s+((?:CONSTRAINT\\s+\\S+\\s+)?(?:PRIMARY\\s+KEY|FOREIGN\\s+KEY|UNIQUE)[\\s\\S]*)$`, 'i').exec(out[i]!)
    if (!m) continue
    const target = creates.get(tableKey(m[1]!))
    if (target === undefined) continue
    const create = out[target]!
    const close = create.lastIndexOf(')')
    // NOT VALID / DEFERRABLE mean nothing to the model (referential actions are read from the folded clause).
    const clause = m[2]!.replace(/\b(NOT\s+VALID|(NOT\s+)?DEFERRABLE(\s+INITIALLY\s+\w+)?|USING\s+INDEX\b.*)$/gi, '')
    out[target] = `${create.slice(0, close).trimEnd()},\n  ${clause.trim()}\n${create.slice(close)}`
    out[i] = ''
  }
  return out.filter(Boolean)
}

interface DeclaredColumn {
  type: string
  identity: boolean
  /** The default as written, and the comment of a MySQL column. */
  defaultValue?: string
  comment?: string
}

interface DeclaredTable {
  schema?: string
  name: string
  comment?: string
  columns: Map<string, DeclaredColumn>
}

const literal = (quoted: string) => quoted.replace(/^N?'|'$/gi, '').replaceAll("''", "'")

const unquote = (name: string) => name.trim().replace(/^"([\s\S]*)"$/, '$1')
/** Joins a table's schema and name into the one name it has inside DuckDB. */
const JOIN = '__dbm__'
/** Where a column's type ends: the first constraint or option after it. */
const AFTER_TYPE = /^(NOT|NULL|DEFAULT|PRIMARY|REFERENCES|UNIQUE|CHECK|CONSTRAINT|COLLATE|IDENTITY|GENERATED|AUTO_INCREMENT|AUTOINCREMENT|COMMENT|CHARACTER\s+SET|CHARSET|ON\s+UPDATE|ENCODE|SPARSE|ROWGUIDCOL|FILESTREAM|MASKED|AS|WITH(?!\s+(?:LOCAL\s+)?TIME\s+ZONE)|INVISIBLE|VISIBLE|STORAGE|COLUMN_FORMAT|SRID)\b/i
const TABLE_PART = /^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|KEY|INDEX|CHECK|FULLTEXT|SPATIAL|PERIOD|EXCLUDE|LIKE)\b/i

/** Splits at commas outside parentheses and quotes. */
function topLevel(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!
    if (quote) {
      if (ch === quote) quote = ''
    } else if (ch === "'" || ch === '"') quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      out.push(body.slice(start, i))
      start = i + 1
    }
  }
  out.push(body.slice(start))
  return out.map((x) => x.trim()).filter(Boolean)
}

/** A column's type as the script declares it, and whether the column numbers itself. */
function declaredColumn(definition: string): (DeclaredColumn & { name: string }) | undefined {
  const m = /^("[^"]+"|[\w$]+)\s+([\s\S]+)$/.exec(definition)
  if (!m) return undefined
  const rest = m[2]!
  let depth = 0
  let end = rest.length
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]!
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (depth === 0 && /\s/.test(ch) && AFTER_TYPE.test(rest.slice(i + 1).trimStart())) {
      end = i
      break
    }
  }
  let type = rest
    .slice(0, end)
    .replace(/"/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s*\)/g, ')')
    .replace(/\b(unsigned|zerofill)\b/gi, '')
    .trim()
    .toLowerCase()
  // Display widths of MySQL integers say nothing about the type (tinyint(1) is how MySQL spells a flag).
  type = type.replace(/\b(smallint|mediumint|int|integer|bigint)\(\d+\)/g, '$1')
  const after = rest.slice(end)
  // Keywords count outside literals only (a comment may well say "identity").
  let identity = /\bIDENTITY\b|\bAUTO_?INCREMENT\b|\bGENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\b/i.test(after.replace(/'(?:[^']|'')*'/g, "''"))
  const serial = /^(small|big)?serial[248]?$/.exec(type)
  if (serial) {
    type = serial[1] === 'small' ? 'smallint' : serial[1] === 'big' ? 'bigint' : 'integer'
    identity = true
  }
  const comment = /\bCOMMENT\s+('(?:[^']|'')*')/i.exec(after)?.[1]
  // DEFAULT NULL is no default; MySQL dumps quote the defaults of numbers ('0.00').
  let defaultValue = defaultOf(after)
  if (defaultValue && /^null$/i.test(defaultValue)) defaultValue = undefined
  // A sequence's next value is how pg_dump writes a serial column.
  if (defaultValue && /^nextval\s*\(/i.test(defaultValue)) {
    defaultValue = undefined
    identity = true
  }
  const quotedNumber = defaultValue && /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real)\b/.test(type) ? /^'(-?\d+(?:\.\d+)?)'$/.exec(defaultValue) : null
  if (quotedNumber) defaultValue = String(Number(quotedNumber[1]))
  return type ? { name: unquote(m[1]!), type, identity, ...(comment ? { comment: literal(comment) } : {}), ...(defaultValue ? { defaultValue } : {}) } : undefined
}

/** Where a column's default is in the text after its type. */
function defaultSpan(after: string): { start: number; end: number } | undefined {
  // The keyword outside literals and parentheses (a comment may say "default" too).
  let at = -1
  for (let i = 0, depth = 0, quoted = false; i < after.length && at < 0; i++) {
    const ch = after[i]!
    if (quoted) quoted = ch !== "'"
    else if (ch === "'") quoted = true
    else if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (depth === 0 && (i === 0 || /\s/.test(after[i - 1]!)) && /^DEFAULT\s/i.test(after.slice(i))) at = i
  }
  if (at < 0) return undefined
  const start = at
  let depth = 0
  let quoted = false
  let i = at + /^DEFAULT\s+/i.exec(after.slice(at))![0].length
  for (; i < after.length; i++) {
    const ch = after[i]!
    if (quoted) {
      if (ch === "'") quoted = false
    } else if (ch === "'") quoted = true
    else if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (depth === 0 && /\s/.test(ch) && AFTER_TYPE.test(after.slice(i + 1).trimStart())) break
  }
  return { start, end: i }
}

function defaultOf(after: string): string | undefined {
  const span = defaultSpan(after)
  return span ? after.slice(span.start, span.end).replace(/^DEFAULT\s+/i, '').trim() || undefined : undefined
}

/** A CREATE TABLE without check constraints (a condition DuckDB can't bind; checks are compared by name). */
function withoutChecks(sql: string): string {
  const m = CREATE_TABLE.exec(sql)
  if (!m) return sql
  const { start, end } = tableBody(sql, m)
  const check = /\s*(?:CONSTRAINT\s+("[^"]+"|[\w$]+)\s+)?CHECK\s*\(/i
  const parts = topLevel(sql.slice(start, end)).flatMap((part) => {
    if (/^(?:CONSTRAINT\s+("[^"]+"|[\w$]+)\s+)?CHECK\b/i.test(part)) return []
    let out = part
    for (let found = check.exec(out); found; found = check.exec(out)) {
      let depth = 1
      let i = found.index + found[0].length
      for (; i < out.length && depth > 0; i++) {
        if (out[i] === '(') depth++
        else if (out[i] === ')') depth--
      }
      out = `${out.slice(0, found.index)} ${out.slice(i)}`.trim()
    }
    return [out]
  })
  return `${sql.slice(0, start)}\n  ${parts.join(',\n  ')}\n${sql.slice(end)}`
}

/** A CREATE TABLE without its columns' defaults (for a default DuckDB can't evaluate: getdate(), newid()…). */
function withoutDefaults(sql: string): string {
  const m = CREATE_TABLE.exec(sql)
  if (!m) return sql
  const { start, end } = tableBody(sql, m)
  const parts = topLevel(sql.slice(start, end)).map((part) => {
    const column = /^("[^"]+"|[\w$]+)\s+/.exec(part)
    if (!column || TABLE_PART.test(part)) return part
    const after = part.slice(column[0].length)
    const span = defaultSpan(after)
    return span ? `${column[0]}${after.slice(0, span.start)}${after.slice(span.end)}` : part
  })
  return `${sql.slice(0, start)}\n  ${parts.join(',\n  ')}\n${sql.slice(end)}`
}

/** The tables of a script as written: schemas, column types and identities DuckDB would not keep. */
function declaredTables(script: string): DeclaredTable[] {
  const text = outsideStrings(script.replace(/^\s*GO\s*$/gim, ';'), (code) => code.replace(/`([^`]+)`/g, '"$1"').replace(/\[([^\]\r\n]+)\]/g, '"$1"'))
  const out: DeclaredTable[] = []
  for (const statement of splitStatements(text, 'postgres')) {
    const sql = stripLeadingComments(statement.text)
    const m = new RegExp(`^\\s*CREATE\\s+(?:UNLOGGED\\s+|TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${NAME})\\s*\\(`, 'i').exec(sql)
    if (!m) continue
    const parts = m[1]!.match(/"[^"]+"|[\w$]+/g)!.map(unquote)
    let depth = 1
    let i = m[0].length
    for (; i < sql.length && depth > 0; i++) {
      if (sql[i] === '(') depth++
      else if (sql[i] === ')') depth--
    }
    const columns = new Map<string, DeclaredColumn>()
    for (const part of topLevel(sql.slice(m[0].length, i - 1))) {
      if (TABLE_PART.test(part)) continue
      const column = declaredColumn(part)
      if (column) columns.set(column.name.toLowerCase(), column)
    }
    const comment = /^[^;]*?\bCOMMENT\s*=?\s*('(?:[^']|'')*')/i.exec(sql.slice(i))?.[1]
    out.push({ schema: parts.length > 1 ? parts[0] : undefined, name: parts.at(-1)!, columns, ...(comment ? { comment: literal(comment) } : {}) })
  }
  // SQL Server keeps comments as extended properties (MS_Description), added after the tables; pg_dump makes
  // identity columns after the tables too.
  for (const statement of splitStatements(text, 'postgres')) {
    const sql = stripLeadingComments(statement.text)
    const identity = new RegExp(`^\\s*ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(${NAME})\\s+ALTER\\s+(?:COLUMN\\s+)?("[^"]+"|[\\w$]+)\\s+(?:ADD\\s+GENERATED\\s+(?:ALWAYS|BY\\s+DEFAULT)\\s+AS\\s+IDENTITY\\b|SET\\s+DEFAULT\\s+nextval\\s*\\()`, 'i').exec(sql)
    if (identity) {
      const parts = identity[1]!.match(/"[^"]+"|[\w$]+/g)!.map(unquote)
      const table = out.find((d) => d.name.toLowerCase() === parts.at(-1)!.toLowerCase() && (parts.length < 2 || !d.schema || d.schema.toLowerCase() === parts[0]!.toLowerCase()))
      const column = table?.columns.get(unquote(identity[2]!).toLowerCase())
      if (column) column.identity = true
      continue
    }
    if (!/^\s*EXEC(?:UTE)?\s+(?:sys\s*\.\s*)?sp_addextendedproperty\b/i.test(sql)) continue
    const order = ['name', 'value', 'level0type', 'level0name', 'level1type', 'level1name', 'level2type', 'level2name']
    const args: Record<string, string> = {}
    let n = 0
    for (const a of sql.matchAll(/(?:@(\w+)\s*=\s*)?(N?'(?:[^']|'')*')/gi)) {
      args[(a[1] ?? order[n] ?? '').toLowerCase()] = literal(a[2]!)
      n++
    }
    if (args.name?.toLowerCase() !== 'ms_description' || args.level1type?.toUpperCase() !== 'TABLE' || args.value === undefined) continue
    const table = out.find((d) => d.name.toLowerCase() === args.level1name?.toLowerCase() && (!d.schema || !args.level0name || d.schema.toLowerCase() === args.level0name.toLowerCase()))
    if (!table) continue
    if (args.level2type?.toUpperCase() === 'COLUMN') {
      const column = table.columns.get((args.level2name ?? '').toLowerCase())
      if (column) column.comment = args.value
    } else if (!args.level2type) table.comment = args.value
  }
  return out
}

const names = (list: string) => list.split(',').map((x) => unquote(x.replace(/\s+(ASC|DESC)\s*$/i, ''))).filter(Boolean)
const ACTION = String.raw`(CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION)`
const actions = (text: string) => ({
  onDelete: new RegExp(`\\bON\\s+DELETE\\s+${ACTION}`, 'i').exec(text)?.[1]?.replace(/\s+/g, ' ').toUpperCase(),
  onUpdate: new RegExp(`\\bON\\s+UPDATE\\s+${ACTION}`, 'i').exec(text)?.[1]?.replace(/\s+/g, ' ').toUpperCase(),
})
const CREATE_TABLE = new RegExp(`^\\s*CREATE\\s+(?:UNLOGGED\\s+|TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${NAME})\\s*\\(`, 'i')

/** The body of a CREATE TABLE statement between its outer parentheses. */
function tableBody(sql: string, m: RegExpExecArray): { start: number; end: number } {
  let depth = 1
  let i = m[0].length
  for (; i < sql.length && depth > 0; i++) {
    if (sql[i] === '(') depth++
    else if (sql[i] === ')') depth--
  }
  return { start: m[0].length, end: i - 1 }
}

interface DeclaredKey {
  name?: string
  columns: string[]
  refTable: string
  refColumns: string[]
  onDelete?: string
  onUpdate?: string
}

/**
 * Takes the foreign keys out of a CREATE TABLE statement (DuckDB can't create a table that references itself or
 * a table created after it, and drops referential actions): the statement without them, and the keys as written.
 */
function withoutForeignKeys(sql: string): { sql: string; table?: string; keys: DeclaredKey[] } {
  const m = CREATE_TABLE.exec(sql)
  if (!m) return { sql, keys: [] }
  const { start, end } = tableBody(sql, m)
  const keys: DeclaredKey[] = []
  const kept: string[] = []
  for (const part of topLevel(sql.slice(start, end))) {
    const table = new RegExp(`^(?:CONSTRAINT\\s+("[^"]+"|[\\w$]+)\\s+)?FOREIGN\\s+KEY\\s*\\(([^)]*)\\)\\s*REFERENCES\\s+(${NAME})\\s*(?:\\(([^)]*)\\))?`, 'i').exec(part)
    if (table) {
      keys.push({ name: table[1] ? unquote(table[1]) : undefined, columns: names(table[2]!), refTable: unquote(table[3]!.match(/"[^"]+"|[\w$]+/g)!.at(-1)!), refColumns: table[4] ? names(table[4]) : [], ...actions(part) })
      continue
    }
    const reference = new RegExp(`\\s(?:CONSTRAINT\\s+("[^"]+"|[\\w$]+)\\s+)?REFERENCES\\s+(${NAME})(?:\\s*\\(([^)]*)\\))?((?:\\s+(?:MATCH\\s+\\w+|ON\\s+(?:DELETE|UPDATE)\\s+${ACTION}|(?:NOT\\s+)?DEFERRABLE|INITIALLY\\s+\\w+))*)`, 'i').exec(part)
    const column = /^("[^"]+"|[\w$]+)\s/.exec(part)
    if (reference && column && !TABLE_PART.test(part)) {
      keys.push({ name: reference[1] ? unquote(reference[1]) : undefined, columns: [unquote(column[1]!)], refTable: unquote(reference[2]!.match(/"[^"]+"|[\w$]+/g)!.at(-1)!), refColumns: reference[3] ? names(reference[3]) : [], ...actions(reference[4] ?? '') })
      kept.push(`${part.slice(0, reference.index)} ${part.slice(reference.index + reference[0].length)}`.trim())
      continue
    }
    kept.push(part)
  }
  const name = unquote(m[1]!.match(/"[^"]+"|[\w$]+/g)!.at(-1)!)
  return { sql: `${sql.slice(0, start)}\n  ${kept.join(',\n  ')}\n${sql.slice(end)}`, table: name.toLowerCase(), keys }
}

/**
 * DuckDB reads a script's structure (keys, references, indexes) but keeps its own types (no lengths of varchar,
 * no serial) and its own schema for the default one: put back what the script itself says.
 */
function asDeclared(tables: TableInfo[], script: string): TableInfo[] {
  const declared = declaredTables(script)
  const schemaOf = new Map<string, string | undefined>()
  const lower = (s: string | undefined) => (s ?? '').toLowerCase()
  const out = tables.map((given) => {
    const at = given.name.indexOf(JOIN)
    // Names DuckDB made up from the table's name (keys, unique constraints) lose the joined schema too.
    const plain = (name: string) => (at > 0 ? name.replaceAll(given.name.slice(0, at + JOIN.length), '') : name)
    const table = at > 0 ? { ...given, schema: given.name.slice(0, at), name: given.name.slice(at + JOIN.length), indexes: given.indexes.map((i) => ({ ...i, name: plain(i.name) })), foreignKeys: given.foreignKeys.map((f) => ({ ...f, name: plain(f.name) })) } : given
    const named = declared.filter((d) => d.name.toLowerCase() === table.name.toLowerCase())
    const found =
      named.length === 1
        ? named[0]
        : named.find((d) => lower(d.schema) === lower(table.schema) || (lower(table.schema) === 'main' && (!d.schema || /^(public|dbo|main)$/i.test(d.schema))))
    if (!found) return table
    schemaOf.set(`${lower(given.schema)}.${given.name.toLowerCase()}`, found.schema)
    return {
      ...table,
      schema: found.schema,
      ...(found.comment !== undefined ? { comment: found.comment } : {}),
      columns: table.columns.map((c) => {
        const d = found.columns.get(c.name.toLowerCase())
        if (!d) return c
        // Defaults as the script writes them: DuckDB rewrites them in its own words (CAST('x' AS VARCHAR)), and
        // one it could not take was left out of what it ran.
        return { ...c, dataType: d.type, isIdentity: c.isIdentity || d.identity, ...(d.comment !== undefined ? { comment: d.comment } : {}), ...(d.identity ? {} : { defaultValue: d.defaultValue ?? null }) }
      }),
    }
  })
  return out.map((table) => ({
    ...table,
    foreignKeys: table.foreignKeys.map((fk) => {
      const key = `${lower(fk.refSchema ?? 'main')}.${fk.refTable.toLowerCase()}`
      const at = fk.refTable.indexOf(JOIN)
      const refTable = at > 0 ? fk.refTable.slice(at + JOIN.length) : fk.refTable
      return schemaOf.has(key) ? { ...fk, refSchema: schemaOf.get(key), refTable } : { ...fk, refTable }
    }),
  }))
}

/**
 * Tables from a SQL DDL script (pg_dump --schema-only, mysqldump --no-data, SSMS "script as CREATE"…), read by
 * running it in a scratch in-memory DuckDB. Statements DuckDB can't run are reported and skipped.
 */
export async function tablesFromDdl(script: string): Promise<DdlImportResult> {
  const driver = new DuckDBDriver({ id: 'ddl-import', name: 'ddl-import', driver: 'duckdb' })
  await driver.connect()
  const skipped: DdlImportResult['skipped'] = []
  try {
    // DuckDB refuses foreign keys between schemas: every table goes into its default schema under a name that
    // says its own schema too, and gets both back when it is read.
    const schemas = new Set(declaredTables(script).map((d) => d.schema?.toLowerCase()).filter((x): x is string => !!x && !/^(public|dbo|main)$/.test(x)))
    const mangled = outsideStrings(normalize(script), (code) => code.replace(/(?<![\w$".])("[^"]+"|[\w$]+)\s*\.\s*("[^"]+"|[\w$]+)/g, (whole, a: string, b: string) => (schemas.has(unquote(a).toLowerCase()) ? `"${unquote(a)}${JOIN}${unquote(b)}"` : whole)))
    // Foreign keys are taken as written and left out of what DuckDB runs (see withoutForeignKeys).
    const keysOf = new Map<string, DeclaredKey[]>()
    const statements = foldConstraints(splitStatements(mangled, 'postgres').flatMap((s) => extractInlineIndexes(stripLeadingComments(s.text)))).map((statement) => {
      const { sql, table, keys } = withoutForeignKeys(statement)
      if (table) keysOf.set(table, [...(keysOf.get(table) ?? []), ...keys])
      return sql.replace(/\bON\s+(DELETE|UPDATE)\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION)/gi, '')
    })
    // Other schemas than the default ones become DuckDB schemas.
    // CREATE SCHEMA statements in the script are fine to fail: the schemas are created up front.
    for (const m of statements.join('\n').matchAll(/\bTABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([\w$]+)"?\s*\.\s*"?[\w$]+/gi)) {
      await driver.execute(`CREATE SCHEMA IF NOT EXISTS "${m[1]!.replaceAll('"', '')}"`).catch(() => {})
    }
    // Foreign keys may point at tables created later in the script: retry failed statements until nothing changes.
    let pending = statements.filter((s) => RELEVANT.test(s))
    for (let round = 0; round < 5 && pending.length; round++) {
      const failed: string[] = []
      for (let sql of pending) {
        // A type DuckDB doesn't know (domains, extensions) becomes VARCHAR; the model only needs the column.
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            await driver.execute(sql)
            sql = ''
            break
          } catch (err) {
            const message = err instanceof Error ? err.message : ''
            // A default DuckDB can't evaluate (another database's function or literal): the table without
            // defaults, which come back from the script's text (asDeclared).
            if (/Function with name|Sequence with name|Binder Error|Conversion Error|\bCHECK\b/i.test(message) && CREATE_TABLE.test(sql)) {
              const simpler = [withoutDefaults, withoutChecks].map((f) => f(sql)).find((x) => x !== sql)
              if (simpler) {
                sql = simpler
                continue
              }
            }
            const type = /Type with name "?([\w$.]+)"? does not exist/i.exec(message)?.[1]
            if (!type) break
            sql = sql.replace(new RegExp(`(?<![\\w$"])${type.replace(/[.$]/g, '\\$&')}(?![\\w$"])(\\s*\\([^)]*\\))?`, 'gi'), 'VARCHAR')
          }
        }
        if (sql) failed.push(sql)
      }
      if (failed.length === pending.length) break
      pending = failed
    }
    for (const sql of pending) {
      try {
        await driver.execute(sql)
      } catch (err) {
        skipped.push({ sql: sql.slice(0, 300), error: err instanceof Error ? err.message.split('\n')[0]! : String(err) })
      }
    }
    const snapshot = await driver.introspect()
    const byName = new Map(snapshot.tables.map((t) => [t.name.toLowerCase(), t]))
    const tables = snapshot.tables.map((t) => ({
      ...t,
      foreignKeys: (keysOf.get(t.name.toLowerCase()) ?? []).flatMap((k): TableInfo['foreignKeys'] => {
        const target = byName.get(k.refTable.toLowerCase())
        // A key without its columns points at the other table's primary key.
        const refColumns = k.refColumns.length ? k.refColumns : (target?.primaryKey ?? [])
        if (!target || refColumns.length !== k.columns.length) return []
        return [{ name: k.name ?? `fk_${t.name}_${k.columns.join('_')}`.replace(new RegExp(`^fk_[^_]*${JOIN}`), 'fk_'), columns: k.columns, refSchema: target.schema, refTable: target.name, refColumns, ...(k.onDelete ? { onDelete: k.onDelete } : {}), ...(k.onUpdate ? { onUpdate: k.onUpdate } : {}) }]
      }),
    }))
    return { tables: asDeclared(tables, script), skipped }
  } finally {
    await driver.close()
  }
}

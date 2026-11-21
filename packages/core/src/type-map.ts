import type { DriverId, TableInfo } from './types.js'
import { stripLiterals } from './sql-split.js'

type Family = 'bool' | 'json' | 'text' | 'string' | 'timestamp' | 'timestamptz' | 'uuid' | 'double' | 'real' | 'binary' | 'tinyint' | 'datetime'

const TARGETS: Record<DriverId, Partial<Record<Family, string>>> = {
  postgres: { bool: 'boolean', json: 'jsonb', text: 'text', string: 'varchar(255)', timestamp: 'timestamp', timestamptz: 'timestamptz', uuid: 'uuid', double: 'double precision', real: 'real', binary: 'bytea', tinyint: 'smallint', datetime: 'timestamp' },
  mssql: { bool: 'bit', json: 'nvarchar(max)', text: 'nvarchar(max)', string: 'nvarchar(255)', timestamp: 'datetime2', timestamptz: 'datetimeoffset', uuid: 'uniqueidentifier', double: 'float', real: 'real', binary: 'varbinary(max)', datetime: 'datetime2' },
  mysql: { bool: 'tinyint(1)', json: 'json', text: 'text', string: 'varchar(255)', timestamp: 'datetime', timestamptz: 'timestamp', uuid: 'char(36)', double: 'double', real: 'float', binary: 'blob', datetime: 'datetime' },
  mariadb: { bool: 'tinyint(1)', json: 'json', text: 'text', string: 'varchar(255)', timestamp: 'datetime', timestamptz: 'timestamp', uuid: 'uuid', double: 'double', real: 'float', binary: 'blob', datetime: 'datetime' },
  sqlite: { bool: 'BOOLEAN', json: 'TEXT', text: 'TEXT', string: 'TEXT', timestamp: 'TEXT', timestamptz: 'TEXT', uuid: 'TEXT', double: 'REAL', real: 'REAL', binary: 'BLOB', tinyint: 'INTEGER', datetime: 'TEXT' },
  oracle: { bool: 'NUMBER(1)', json: 'CLOB', text: 'CLOB', string: 'VARCHAR2(255)', timestamp: 'TIMESTAMP', timestamptz: 'TIMESTAMP WITH TIME ZONE', uuid: 'VARCHAR2(36)', double: 'BINARY_DOUBLE', real: 'BINARY_FLOAT', binary: 'BLOB', tinyint: 'NUMBER(3)', datetime: 'TIMESTAMP' },
  duckdb: { bool: 'BOOLEAN', json: 'JSON', text: 'VARCHAR', string: 'VARCHAR', timestamp: 'TIMESTAMP', timestamptz: 'TIMESTAMPTZ', uuid: 'UUID', double: 'DOUBLE', real: 'REAL', binary: 'BLOB', datetime: 'TIMESTAMP' },
  clickhouse: { bool: 'Bool', json: 'String', text: 'String', string: 'String', timestamp: 'DateTime64(3)', timestamptz: 'DateTime64(3)', uuid: 'UUID', double: 'Float64', real: 'Float32', binary: 'String', tinyint: 'Int8', datetime: 'DateTime' },
  trino: { bool: 'boolean', json: 'json', text: 'varchar', string: 'varchar', timestamp: 'timestamp(3)', timestamptz: 'timestamp(3) with time zone', uuid: 'uuid', double: 'double', real: 'real', binary: 'varbinary', tinyint: 'tinyint', datetime: 'timestamp(3)' },
  bigquery: { bool: 'BOOL', json: 'JSON', text: 'STRING', string: 'STRING', timestamp: 'DATETIME', timestamptz: 'TIMESTAMP', uuid: 'STRING', double: 'FLOAT64', real: 'FLOAT64', binary: 'BYTES', tinyint: 'INT64', datetime: 'DATETIME' },
}

function family(type: string): Family | null {
  const t = type.trim().toLowerCase()
  if (/^(bool|boolean|bit)$/.test(t) || t === 'tinyint(1)' || t === 'number(1)') return 'bool'
  if (/^jsonb?$/.test(t)) return 'json'
  if (/^(text|clob|nclob|ntext|mediumtext|longtext|tinytext|citext|memo|long)$/.test(t) || /^n?varchar\s*\(\s*max\s*\)$/.test(t)) return 'text'
  if (/^(varchar|nvarchar|character varying|string|varchar2|nvarchar2)$/.test(t)) return 'string'
  if (/^(timestamptz|timestamp with time zone|datetimeoffset)$/.test(t)) return 'timestamptz'
  if (/^(timestamp|timestamp without time zone|datetime2)$/.test(t)) return 'timestamp'
  if (/^(datetime|smalldatetime)$/.test(t)) return 'datetime'
  if (/^(uuid|uniqueidentifier)$/.test(t)) return 'uuid'
  if (/^(double|double precision|float8|binary_double)$/.test(t) || t === 'float') return 'double'
  if (/^(real|float4|binary_float)$/.test(t)) return 'real'
  if (/^(bytea|blob|longblob|mediumblob|image|raw)$/.test(t) || /^varbinary\s*\(\s*max\s*\)$/.test(t)) return 'binary'
  if (t === 'tinyint') return 'tinyint'
  return null
}

/** MySQL and MariaDB are one family: a model drawn for one needs no translation for the other. */
const sameEngine = (a: DriverId | undefined, b: DriverId) => !!a && (a === b || (['mysql', 'mariadb'].includes(a) && ['mysql', 'mariadb'].includes(b)))

/** Whole numbers by their number of digits, for databases that have no NUMBER(n). */
const integerOf = (digits: number) => (digits <= 4 ? 'smallint' : digits <= 9 ? 'integer' : digits <= 18 ? 'bigint' : `numeric(${digits})`)

/**
 * A column type written for another database, e.g. `boolean` → `bit` for SQL Server. Unknown types pass through,
 * and so does everything when the type was written for this database (`from`): `json` stays `json`.
 */
export function translateType(type: string, to: DriverId, from?: DriverId): string {
  // Types no version of the target has (DeZign's database-independent INT64, STRING(n)) are translated regardless.
  const own = otherEngineType(type.trim(), to)
  if (own) return own
  if (sameEngine(from, to)) return type
  // UNSIGNED and ZEROFILL are MySQL's alone: any other database refuses `decimal(10,2) unsigned` (whole numbers are
  // widened above).
  if (to !== 'mysql' && to !== 'mariadb' && /\b(unsigned|zerofill)\b/i.test(type)) return translateType(type.replace(/\s+(unsigned|zerofill)\b/gi, '').trim(), to, from)
  const f = family(type)
  const mapped = f ? TARGETS[to][f] : undefined
  if (mapped) return mapped
  // Length-limited strings keep their length; SQL Server and Oracle prefer their national/2 variants.
  const m = /^(?:n?varchar2?|character varying|nvarchar2?)\s*\(\s*(\d+)\s*\)$/i.exec(type.trim())
  if (m) {
    const n = m[1]
    // nvarchar holds up to 4,000 characters; longer is nvarchar(max).
    if (to === 'mssql') return Number(n) > 4000 ? 'nvarchar(max)' : `nvarchar(${n})`
    if (to === 'oracle') return `VARCHAR2(${n})`
    if (to === 'sqlite') return 'TEXT'
    if (to === 'clickhouse') return 'String'
    if (to === 'bigquery') return 'STRING'
    // MySQL's varchar holds 65,535 bytes, 16,383 characters of utf8mb4.
    if ((to === 'mysql' || to === 'mariadb') && Number(n) > 16383) return 'mediumtext'
    return `varchar(${n})`
  }
  if (to === 'bigquery' && /^(integer|int|bigint|smallint|serial|bigserial)$/i.test(type.trim())) return 'INT64'
  if (to === 'oracle' && /^(integer|int|bigint|smallint)$/i.test(type.trim())) return /^bigint$/i.test(type.trim()) ? 'NUMBER(19)' : 'NUMBER(10)'
  return type
}

/** Spellings only one database (or DeZign's database-independent models) has, for the databases that lack them. */
function otherEngineType(t: string, to: DriverId): string | null {
  const my = to === 'mysql' || to === 'mariadb'
  const sized = /^(\w+)\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)$/.exec(t)
  const name = (sized?.[1] ?? t).toLowerCase()
  // Oracle's NUMBER: a whole number of n digits, a decimal, or any number.
  if (name === 'number' && to !== 'oracle' && t.toLowerCase() !== 'number(1)') {
    if (!sized) return to === 'bigquery' ? 'NUMERIC' : 'numeric'
    if (sized[3] && sized[3] !== '0') return `${to === 'bigquery' ? 'NUMERIC' : 'numeric'}(${sized[2]},${sized[3]})`
    return to === 'bigquery' ? 'INT64' : to === 'clickhouse' ? 'Int64' : to === 'sqlite' ? 'INTEGER' : integerOf(Number(sized[2]))
  }
  // MySQL's display widths (`int(11)`) and its unsigned and medium integers.
  const integer = /^(tinyint|smallint|mediumint|int|integer|bigint)(?:\s*\(\s*(\d+)\s*\))?(\s+unsigned)?$/i.exec(t)
  if (integer && !my && (integer[2] || integer[3] || /^mediumint$/i.test(integer[1]!)) && !(integer[1]!.toLowerCase() === 'tinyint' && integer[2] === '1')) {
    const base = integer[1]!.toLowerCase()
    if (to === 'bigquery') return 'INT64'
    if (to === 'oracle') return base === 'bigint' ? 'NUMBER(19)' : 'NUMBER(10)'
    if (to === 'sqlite') return 'INTEGER'
    if (base === 'tinyint') return to === 'mssql' ? 'tinyint' : 'smallint'
    return base === 'mediumint' || base === 'int' ? (to === 'mssql' ? 'int' : 'integer') : base
  }
  // A time of day with a time zone is PostgreSQL's alone: the time elsewhere.
  if (/^(time with time zone|timetz|time without time zone)$/i.test(t) && to !== 'postgres') return to === 'oracle' ? 'TIMESTAMP WITH TIME ZONE' : to === 'sqlite' ? 'TEXT' : to === 'bigquery' ? 'TIME' : to === 'clickhouse' ? 'String' : 'time'
  // MySQL's CHAR holds 255 characters.
  const fixed = /^(?:character|char)\s*\(\s*(\d+)\s*\)$/i.exec(t)
  if (fixed && my && Number(fixed[1]) > 255) return translateType(`varchar(${fixed[1]})`, to)
  if (name === 'int64' && to !== 'bigquery' && to !== 'clickhouse') return to === 'oracle' ? 'NUMBER(19)' : to === 'sqlite' ? 'INTEGER' : 'bigint'
  if (name === 'string' && sized && !sized[3]) return translateType(`varchar(${sized[2]})`, to)
  // MySQL's ENUM and SET: a short string elsewhere.
  if (/^(enum|set)\s*\(/i.test(t) && !my && to !== 'postgres') return translateType('varchar(255)', to)
  if (/^(enum|set)\s*\(/i.test(t) && to === 'postgres') return 'varchar(255)'
  if ((name === 'money' || name === 'smallmoney') && to !== 'mssql' && to !== 'postgres') return to === 'oracle' ? 'NUMBER(19,4)' : to === 'bigquery' ? 'NUMERIC' : to === 'sqlite' ? 'NUMERIC' : 'decimal(19,4)'
  if (name === 'smallmoney' && to === 'postgres') return 'money'
  if ((name === 'binary' || name === 'varbinary') && sized && !my && to !== 'mssql') return translateType('blob', to)
  if (name === 'binary' && !sized && !my && to !== 'mssql') return translateType('blob', to)
  return null
}

/** A default value written for another database (timestamps and booleans; other expressions pass through). */
export function translateDefault(value: string, to: DriverId): string {
  const v = value.trim()
  if (/^(now\(\)|current_timestamp(\(\))?|getdate\(\)|sysdatetime\(\)|systimestamp|sysdate|localtimestamp)$/i.test(v)) {
    return to === 'mssql' ? 'SYSDATETIME()' : to === 'oracle' ? 'SYSTIMESTAMP' : to === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  }
  if (/^(current_date|curdate\(\)|\(current_date\))$/i.test(v)) {
    return to === 'mssql' ? 'CAST(GETDATE() AS date)' : to === 'oracle' ? 'TRUNC(SYSDATE)' : to === 'mysql' || to === 'mariadb' ? '(CURRENT_DATE)' : 'CURRENT_DATE'
  }
  const bool = /^(?:cast\s*\(\s*)?'?(t|f|true|false)'?(?:\s+as\s+boolean\s*\))?$/i.exec(v)
  if (bool) {
    const on = /^t/i.test(bool[1]!)
    return to === 'postgres' || to === 'duckdb' ? (on ? 'true' : 'false') : on ? '1' : '0'
  }
  return v
}

/** Bounded strings for key columns: MySQL can't index TEXT, SQL Server can't index nvarchar(max) (900-byte keys). */
const KEY_STRING: Partial<Record<DriverId, string>> = { mysql: 'varchar(255)', mariadb: 'varchar(255)', mssql: 'nvarchar(450)', oracle: 'VARCHAR2(1000)' }

/** Tables with column types and defaults written for `to`; untouched when they were written for it (`from`). */
export function translateTables(tables: TableInfo[], to: DriverId, from?: DriverId): TableInfo[] {
  if (sameEngine(from, to)) return tables.map((t) => ({ ...t, columns: t.columns.map((c) => ({ ...c, dataType: translateType(c.dataType, to, from) })) }))
  return tables.map((t) => {
    const keyed = new Set([...t.primaryKey, ...t.indexes.flatMap((i) => i.columns), ...t.foreignKeys.flatMap((f) => f.columns)])
    return {
      ...t,
      columns: t.columns.map((given) => {
        // PostgreSQL's serial is an integer that numbers itself: elsewhere the integer, as an identity column.
        const serial = /^(small|big)?serial[248]?$/i.exec(given.dataType.trim())
        const c = serial ? { ...given, dataType: serial[1]?.toLowerCase() === 'big' ? 'bigint' : serial[1]?.toLowerCase() === 'small' ? 'smallint' : 'integer', isIdentity: true } : given
        const f = family(c.dataType)
        let dataType = keyed.has(c.name) && (f === 'text' || f === 'json' || f === 'string') && KEY_STRING[to] ? KEY_STRING[to]! : translateType(c.dataType, to)
        // A one-digit number that defaults to something other than 0 or 1 was never a flag.
        if (f === 'bool' && /\(1\)$/.test(c.dataType.trim()) && c.defaultValue && !/^[01]$/.test(c.defaultValue.trim())) dataType = translateType('smallint', to)
        let defaultValue = c.defaultValue ? translateDefault(c.defaultValue, to) : c.defaultValue
        // A flag kept as 0/1 where the target has real booleans.
        if (defaultValue && f === 'bool' && (to === 'postgres' || to === 'duckdb') && /^[01]$/.test(defaultValue)) defaultValue = defaultValue === '1' ? 'true' : 'false'
        // (A collation is a name of the database the model was written for: another one has its own.)
        return { ...c, dataType, defaultValue, collation: undefined }
      }),
    }
  })
    .map((t) => (t.checks ? { ...t, checks: t.checks.map((c) => ({ ...c, expression: translateCondition(c.expression, to) })).filter((c) => !((to === 'oracle' || to === 'mysql' || to === 'mariadb') && NOT_IN_MYSQL_CHECK.test(c.expression))) } : t))
    .map((t) => (['mysql', 'mariadb', 'mssql', 'oracle'].includes(to) ? oneIdentity(t) : t))
    .map((t) => (to === 'mysql' || to === 'mariadb' ? forMySql(t, to) : t))
}

/** MySQL, SQL Server and Oracle number one column per table: the key's, if it is one of them. */
function oneIdentity(t: TableInfo): TableInfo {
  const auto = t.columns.filter((c) => c.isIdentity)
  if (auto.length < 2) return t
  const kept = auto.find((c) => c.name.toLowerCase() === t.primaryKey[0]?.toLowerCase()) ?? auto[0]
  return { ...t, columns: t.columns.map((c) => (c.isIdentity && c !== kept ? { ...c, isIdentity: false } : c)) }
}

/** The time and the date in a condition, as the target database says them (MySQL and Oracle allow neither in a check). */
function translateCondition(expression: string, to: DriverId): string {
  if (to !== 'mssql') return expression
  return expression.replace(/\b(now\s*\(\s*\)|current_timestamp|localtimestamp|clock_timestamp\s*\(\s*\))/gi, 'SYSDATETIME()').replace(/\bcurrent_date\b/gi, 'CAST(GETDATE() AS date)')
}

/** Bytes a MySQL row takes for a column (utf8mb4: four per character), BLOB and TEXT not counted. */
function mySqlBytes(type: string): number {
  const sized = /^(?:var)?char(?:acter)?(?: varying)?\s*\(\s*(\d+)\s*\)$/i.exec(type.trim())
  if (sized) return Number(sized[1]) * 4 + 2
  return /text|blob|json/i.test(type) ? 0 : 8
}

/**
 * Only deterministic conditions are allowed in a MySQL check. Functions count where they are called, and the words
 * only outside strings and quoted names: `role IN ('user')` or a column `uuid` is no call.
 */
const NONDETERMINISTIC = /(?<![\w.$])((now|curdate|curtime|sysdate|utc_date|utc_time|utc_timestamp|rand|uuid|connection_id)\s*\(|(current_timestamp|current_date|current_time|localtime|localtimestamp|current_user|user)\b(?!\s*\.))/i
const NOT_IN_MYSQL_CHECK = { test: (expression: string) => NONDETERMINISTIC.test(stripLiterals(expression)) }

/**
 * What MySQL refuses in a table that other databases take: a row wider than 65,535 bytes (the longest strings
 * that are not keys become TEXT), an auto-increment column that does not lead a key (it gets a unique constraint),
 * and checks that ask for the time or a random value.
 */
function forMySql(t: TableInfo, to: 'mysql' | 'mariadb'): TableInfo {
  const keyed = new Set([...t.primaryKey, ...t.indexes.flatMap((i) => i.columns), ...t.foreignKeys.flatMap((f) => f.columns)])
  const columns = [...t.columns]
  let width = columns.reduce((sum, c) => sum + mySqlBytes(c.dataType), 0)
  while (width > 65535) {
    const widest = columns.map((c, i) => ({ c, i, bytes: mySqlBytes(c.dataType) })).filter((x) => !keyed.has(x.c.name) && x.bytes > 8).sort((a, b) => b.bytes - a.bytes)[0]
    if (!widest) break
    columns[widest.i] = { ...widest.c, dataType: 'text' }
    width -= widest.bytes
  }
  // The auto-increment column has to lead a key when the table is created: a unique constraint, which its values
  // are anyway.
  const leads = new Set([t.primaryKey[0], ...t.indexes.map((i) => i.columns[0])].filter(Boolean).map((c) => c!.toLowerCase()))
  const indexes = [...t.indexes]
  for (const c of columns) {
    if (c.isIdentity && !leads.has(c.name.toLowerCase())) indexes.push({ name: `${t.name}_${c.name}_ai`.slice(0, 64), columns: [c.name], unique: true, primary: false, constraint: true })
  }
  // MySQL takes no literal default on TEXT, BLOB, JSON or spatial columns, only an expression: ('x') (8.0.13+).
  // MariaDB takes the literal.
  if (to === 'mysql') {
    for (const [i, c] of columns.entries()) {
      const d = c.defaultValue?.trim()
      if (d && !/^\(/.test(d) && !/^null$/i.test(d) && /^((tiny|medium|long)?(text|blob)|json|geometry|point|linestring|polygon)\b/i.test(c.dataType.trim())) columns[i] = { ...c, defaultValue: `(${d})` }
    }
  }
  const checks = t.checks?.filter((ch) => !NOT_IN_MYSQL_CHECK.test(ch.expression))
  return { ...t, columns, indexes, ...(t.checks ? { checks } : {}) }
}

/** What a column type is, whatever database spells it: what code generators (orm-export.ts) map from. */
export type TypeFamily =
  | 'smallint'
  | 'integer'
  | 'bigint'
  | 'tinyint'
  | 'mediumint'
  | 'decimal'
  | 'money'
  | 'real'
  | 'double'
  | 'boolean'
  | 'char'
  | 'varchar'
  | 'text'
  | 'uuid'
  | 'date'
  | 'time'
  | 'timetz'
  | 'timestamp'
  | 'timestamptz'
  | 'interval'
  | 'year'
  | 'json'
  | 'jsonb'
  | 'binary'
  | 'bit'
  | 'xml'
  | 'network'
  | 'enum'
  | 'set'
  | 'other'

export interface ColumnType {
  family: TypeFamily
  /** The type's own name, lower case, without its arguments (`varchar`, `datetime2`, `mediumtext`). */
  name: string
  /** Length (strings, binary, bits) or precision (decimals, fractional seconds). */
  length?: number
  scale?: number
  /** `varchar(max)`, `nvarchar(max)`. */
  max?: boolean
  unsigned?: boolean
  /** Numbers itself (serial, bigserial). */
  serial?: boolean
  /** An array of it (PostgreSQL `integer[]`). */
  array?: boolean
  /** National characters (SQL Server nvarchar, nchar, ntext). */
  national?: boolean
  /** MySQL ENUM / SET values. */
  values?: string[]
}

const FAMILIES: [RegExp, TypeFamily][] = [
  [/^(smallint|int2|smallserial|serial2)$/, 'smallint'],
  [/^(integer|int|int4|serial|serial4|pls_integer|binary_integer)$/, 'integer'],
  [/^(bigint|int8|bigserial|serial8|int64|long|hugeint)$/, 'bigint'],
  [/^(tinyint|int1|utinyint)$/, 'tinyint'],
  [/^(mediumint|int3)$/, 'mediumint'],
  [/^(decimal|numeric|dec|number|fixed|bignumeric)$/, 'decimal'],
  [/^(money|smallmoney)$/, 'money'],
  [/^(real|float4|binary_float|float32)$/, 'real'],
  [/^(double|double precision|float8|binary_double|float64|float)$/, 'double'],
  [/^(boolean|bool)$/, 'boolean'],
  [/^(char|character|nchar|bpchar|national char|national character)$/, 'char'],
  [/^(varchar|character varying|nvarchar|varchar2|nvarchar2|string|national varchar|varying character)$/, 'varchar'],
  [/^(text|ntext|tinytext|mediumtext|longtext|clob|nclob|citext|long varchar|memo)$/, 'text'],
  [/^(uuid|uniqueidentifier)$/, 'uuid'],
  [/^date$/, 'date'],
  [/^(time|time without time zone)$/, 'time'],
  [/^(timetz|time with time zone)$/, 'timetz'],
  [/^(timestamp|timestamp without time zone|datetime|datetime2|smalldatetime|datetime64)$/, 'timestamp'],
  [/^(timestamptz|timestamp with time zone|timestamp with local time zone|datetimeoffset)$/, 'timestamptz'],
  [/^interval$/, 'interval'],
  [/^year$/, 'year'],
  [/^json$/, 'json'],
  [/^jsonb$/, 'jsonb'],
  [/^(bytea|blob|tinyblob|mediumblob|longblob|image|raw|long raw|binary|varbinary|bytes|binary varying)$/, 'binary'],
  [/^(bit|varbit|bit varying)$/, 'bit'],
  [/^(xml|xmltype)$/, 'xml'],
  [/^(inet|cidr|macaddr|macaddr8)$/, 'network'],
]

/**
 * A column type read into its family and its arguments: `varchar(255)` is a varchar of 255, `int unsigned` an
 * unsigned integer, `tinyint(1)` and Oracle's `NUMBER(1)` flags, `NUMBER(10)` a whole number.
 */
export function classifyType(type: string, /** The database the type is written for: `bit` is a flag in SQL Server and MySQL, a bit string in PostgreSQL. */ database?: DriverId | 'cockroachdb'): ColumnType {
  let t = type.trim().toLowerCase().replace(/\s+/g, ' ')
  let array = false
  if (/\[\s*\d*\s*\]$/.test(t)) {
    array = true
    t = t.replace(/(\s*\[\s*\d*\s*\])+$/, '')
  } else if (/^_[a-z]/.test(t)) {
    // PostgreSQL's catalog names arrays `_int4`.
    array = true
    t = t.slice(1)
  }
  if (/^(enum|set)\s*\(/.test(t)) {
    const values = [...type.slice(type.indexOf('(') + 1, type.lastIndexOf(')')).matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replaceAll("''", "'"))
    return { family: t.startsWith('enum') ? 'enum' : 'set', name: t.startsWith('enum') ? 'enum' : 'set', values }
  }
  const unsigned = /\bunsigned\b/.test(t)
  const zerofill = /\bzerofill\b/.test(t)
  t = t.replace(/\b(unsigned|signed|zerofill)\b/g, '').trim()
  // `timestamp(3) with time zone`, `time(6) without time zone`: the precision sits inside the name.
  const inner = /^(timestamp|time)\s*\(\s*(\d+)\s*\)\s*(with(?:out)? (?:local )?time zone)$/.exec(t)
  const m = inner ? null : /^(.*?)\s*\(\s*([^)]*)\)\s*(.*)$/.exec(t)
  const name = inner ? `${inner[1]} ${inner[3]}` : m ? `${m[1]}${m[3] ? ` ${m[3]}` : ''}`.trim() : t
  const args = inner ? [inner[2]!] : m ? m[2]!.split(',').map((a) => a.trim()) : []
  const max = args[0] === 'max'
  const nums = args.map((a) => (/^\d+$/.test(a) ? Number(a) : undefined))
  const base: Omit<ColumnType, 'family'> = { name, ...(nums[0] !== undefined ? { length: nums[0] } : {}), ...(nums[1] !== undefined ? { scale: nums[1] } : {}), ...(max ? { max } : {}), ...(unsigned || zerofill ? { unsigned: true } : {}), ...(array ? { array } : {}) }
  if (/serial/.test(name)) base.serial = true
  if (/^(nvarchar|nchar|ntext|nvarchar2|nclob|national)/.test(name)) base.national = true
  // MySQL's flag, Oracle's flag and SQL Server's one-bit boolean.
  // (PostgreSQL's bit and bit(1) are bit strings, as prisma db pull reads them: String @db.Bit(1).)
  const pgBit = name === 'bit' && (database === 'postgres' || database === 'cockroachdb')
  if (pgBit) return { ...base, length: nums[0] ?? 1, family: 'bit' }
  if ((name === 'tinyint' && nums[0] === 1) || (name === 'number' && nums[0] === 1 && !nums[1]) || (name === 'bit' && (nums[0] === undefined || nums[0] === 1))) return { ...base, family: 'boolean' }
  // Oracle's NUMBER(n) and NUMBER(n, 0) are whole numbers.
  if (name === 'number' && nums[0] !== undefined && !nums[1]) return { ...base, family: nums[0] <= 4 ? 'smallint' : nums[0] <= 9 ? 'integer' : nums[0] <= 18 ? 'bigint' : 'decimal' }
  if (max && /^(n?varchar|varbinary)$/.test(name)) return { ...base, family: name === 'varbinary' ? 'binary' : 'text' }
  // `float(n)`: up to 24 bits of precision is a single.
  if (name === 'float' && nums[0] !== undefined && nums[0] <= 24) return { ...base, family: 'real' }
  // DuckDB's and BigQuery's STRING / VARCHAR without a length is any length.
  for (const [re, family] of FAMILIES) if (re.test(name)) return { ...base, family }
  if (/^(serial|bigserial|smallserial)$/.test(name)) return { ...base, family: 'integer' }
  if (/^u?(int16|uint16|usmallint)$/.test(name)) return { ...base, family: 'smallint' }
  if (/^u?(int32|uint32|uinteger)$/.test(name)) return { ...base, family: 'integer' }
  if (/^u?(int64|uint64|ubigint)$/.test(name)) return { ...base, family: 'bigint' }
  if (/^(fixedstring|lowcardinality)/.test(name)) return { ...base, family: 'varchar' }
  return { ...base, family: 'other' }
}

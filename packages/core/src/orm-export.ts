import type { ColumnInfo, DriverId, ForeignKeyInfo, TableInfo } from './types.js'
import { classifyType, type ColumnType } from './type-map.js'
import { defaultFkName } from './dbml.js'
import { commentLines, commentText, docstring, stringLiteral, templateText } from './code-text.js'

/**
 * Code from a model for the tools people build on: a Prisma schema (what `prisma db pull` writes), a Drizzle schema
 * (what `drizzle-kit pull` writes), SQLAlchemy 2.0 declarative models and plain TypeScript types. Every generator
 * reads a column's type through one classifier (`classifyType`); each knows only how its tool spells a family.
 * Checked against the tools themselves: test/orm-export.tools.test.ts (DBM_ORM_TOOLS=1).
 */

export type CodeFormat = 'prisma' | 'drizzle' | 'sqlalchemy' | 'typescript'
/** The database the code is for: a driver, or CockroachDB (which the app reaches through the PostgreSQL driver). */
export type CodeDatabase = DriverId | 'cockroachdb'

export interface CodeOptions {
  /** The database the model is for; PostgreSQL when it has none. */
  database?: CodeDatabase
  /** Named enum types (DBML `Enum`, PostgreSQL `CREATE TYPE … AS ENUM`): columns typed with one get its values. */
  enums?: Record<string, string[]>
  /** The schema tables without one belong to (public, dbo): not written out. */
  defaultSchema?: string
}

export const CODE_FORMATS: { id: CodeFormat; label: string; file: string }[] = [
  { id: 'prisma', label: 'Prisma schema', file: 'schema.prisma' },
  { id: 'drizzle', label: 'Drizzle schema (TypeScript)', file: 'schema.ts' },
  { id: 'sqlalchemy', label: 'SQLAlchemy models (Python)', file: 'models.py' },
  { id: 'typescript', label: 'TypeScript types', file: 'types.ts' },
]

const PRISMA_PROVIDERS: Partial<Record<CodeDatabase, string>> = { postgres: 'postgresql', cockroachdb: 'cockroachdb', mysql: 'mysql', mariadb: 'mysql', mssql: 'sqlserver', sqlite: 'sqlite' }
const DRIZZLE_DIALECTS: Partial<Record<CodeDatabase, 'pg' | 'mysql' | 'sqlite'>> = { postgres: 'pg', cockroachdb: 'pg', mysql: 'mysql', mariadb: 'mysql', sqlite: 'sqlite' }

/** The formats a database can have: Prisma and Drizzle only where the tool supports the database. */
export function codeFormatsFor(database: CodeDatabase = 'postgres'): CodeFormat[] {
  return CODE_FORMATS.map((f) => f.id).filter((f) => (f === 'prisma' ? !!PRISMA_PROVIDERS[database] : f === 'drizzle' ? !!DRIZZLE_DIALECTS[database] : true))
}

export function exportCode(format: CodeFormat, tables: TableInfo[], options: CodeOptions = {}): string {
  switch (format) {
    case 'prisma':
      return toPrisma(tables, options)
    case 'drizzle':
      return toDrizzle(tables, options)
    case 'sqlalchemy':
      return toSqlAlchemy(tables, options)
    case 'typescript':
      return toTypeScript(tables, options)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// What every generator needs to know about a model.

interface Model {
  tables: TableInfo[]
  /** The table a foreign key points at, when the model has it. */
  target(t: TableInfo, fk: ForeignKeyInfo): TableInfo | undefined
  /** The schema to write for a table: none for the default one. */
  schemaOf(t: { schema?: string }): string | undefined
  /** A named enum a column is typed with. */
  enumOf(c: ColumnInfo): { name: string; values: string[] } | undefined
}

/**
 * MySQL can't put a key on TEXT, SQL Server not on nvarchar(max): such a column in a key is a bounded string there,
 * as the app's own scripts make it (`translateTables`).
 */
const KEY_STRING: Partial<Record<CodeDatabase, string>> = { mysql: 'varchar(255)', mariadb: 'varchar(255)', mssql: 'nvarchar(450)' }

function modelOf(tables: TableInfo[], options: CodeOptions): Model {
  const keyString = KEY_STRING[options.database ?? 'postgres']
  const list = tables
    .filter((t) => t.type === 'table')
    .map((t) => {
      if (!keyString) return t
      const keyed = new Set([...t.primaryKey, ...t.indexes.flatMap((i) => i.columns), ...t.foreignKeys.flatMap((f) => f.columns)])
      const unbounded = (c: ColumnInfo) => keyed.has(c.name) && ['text', 'json', 'jsonb'].includes(classifyType(c.dataType, options.database).family)
      // (BLOB and varbinary(max) can't be keyed either: a bounded binary string.)
      const blob = (c: ColumnInfo) => {
        const type = classifyType(c.dataType, options.database)
        return keyed.has(c.name) && type.family === 'binary' && (type.max || type.length === undefined)
      }
      const binaryKey = options.database === 'mssql' ? 'varbinary(900)' : 'varbinary(255)'
      return t.columns.some((c) => unbounded(c) || blob(c)) ? { ...t, columns: t.columns.map((c) => (unbounded(c) ? { ...c, dataType: keyString } : blob(c) ? { ...c, dataType: binaryKey } : c)) } : t
    })
  const defaults = new Set([options.defaultSchema, 'public', 'dbo', 'main'].filter(Boolean).map((s) => s!.toLowerCase()))
  const schemaOf = (t: { schema?: string }) => (t.schema && !defaults.has(t.schema.toLowerCase()) ? t.schema : undefined)
  const enums = new Map(Object.entries(options.enums ?? {}).map(([name, values]) => [name.toLowerCase(), { name, values }]))
  const model: Model = {
    tables: list,
    target: (t, fk) => {
      const same = model.tables.filter((x) => x.name === fk.refTable)
      const schema = fk.refSchema ?? t.schema
      return same.find((x) => (schemaOf(x) ?? '') === (schemaOf({ schema }) ?? '')) ?? (same.length === 1 ? same[0] : undefined)
    },
    schemaOf,
    // (PostgreSQL's catalog qualifies a type outside the search path: `app.status`; DBML may quote it.)
    enumOf: (c) => enums.get(c.dataType.trim().replace(/"/g, '').toLowerCase()) ?? enums.get(c.dataType.trim().replace(/"/g, '').split('.').pop()!.toLowerCase()),
  }
  return model
}

type Default =
  | { kind: 'autoincrement' }
  | { kind: 'now' }
  | { kind: 'number'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'expr'; sql: string }

/** A column's default read into what code can say: a number, a text, a flag, the current time, or an expression. */
function defaultOf(c: ColumnInfo, type: ColumnType): Default | undefined {
  if (c.isIdentity || type.serial) return { kind: 'autoincrement' }
  let d = c.defaultValue?.trim()
  if (!d) return undefined
  if (/^nextval\s*\(/i.test(d)) return { kind: 'autoincrement' }
  // SQL Server wraps its defaults: ((0)), (N'x'), (getdate()).
  while (/^\(.*\)$/s.test(d) && balanced(d.slice(1, -1))) d = d.slice(1, -1).trim()
  if (/^null$/i.test(d) || /^null::/i.test(d)) return undefined
  if (/^(now\(\)|current_timestamp(\(\s*\d*\s*\))?|getdate\(\)|sysdatetime\(\)|sysutcdatetime\(\)|getutcdate\(\)|localtimestamp(\(\s*\d*\s*\))?|systimestamp|statement_timestamp\(\)|transaction_timestamp\(\))$/i.test(d)) {
    return ['timestamp', 'timestamptz'].includes(type.family) ? { kind: 'now' } : { kind: 'expr', sql: d }
  }
  // PostgreSQL's catalog adds the type: 'x'::character varying, '0'::numeric.
  const cast = /^(.*?)::[\w\s."[\]()]+$/s.exec(d)
  const plain = cast && /^('.*'|-?\d+(\.\d+)?)$/s.test(cast[1]!.trim()) ? cast[1]!.trim() : d
  const str = /^[nN]?'((?:[^']|'')*)'$/s.exec(plain)
  if (type.family === 'boolean') {
    const v = (str ? str[1]! : plain).toLowerCase()
    if (/^(true|t|1|b'1'|yes|on)$/.test(v)) return { kind: 'bool', value: true }
    if (/^(false|f|0|b'0'|no|off)$/.test(v)) return { kind: 'bool', value: false }
  }
  if (/^-?\d+(\.\d+)?$/.test(plain)) return { kind: 'number', value: plain }
  if (str) {
    const value = str[1]!.replaceAll("''", "'")
    if (isNumberFamily(type) && /^-?\d+(\.\d+)?$/.test(value)) return { kind: 'number', value }
    return { kind: 'string', value }
  }
  return { kind: 'expr', sql: d }
}

const balanced = (s: string) => {
  let depth = 0
  for (const ch of s) {
    if (ch === '(') depth++
    else if (ch === ')' && --depth < 0) return false
  }
  return depth === 0
}

const isNumberFamily = (t: ColumnType) => ['smallint', 'integer', 'bigint', 'tinyint', 'mediumint', 'decimal', 'money', 'real', 'double', 'year'].includes(t.family)
const isIntegerFamily = (t: ColumnType) => ['smallint', 'integer', 'bigint', 'tinyint', 'mediumint'].includes(t.family)

/** Column lists that identify a row: the primary key, then unique indexes and constraints (each once). */
function uniqueSets(t: TableInfo): string[][] {
  const out: string[][] = []
  const key = (cols: string[]) => [...cols].sort().join('\u0000')
  const seen = new Set<string>()
  for (const cols of [t.primaryKey, ...t.indexes.filter((i) => i.unique && !i.primary && !i.definition?.match(/\bwhere\b/i)).map((i) => i.columns)]) {
    if (!cols.length || seen.has(key(cols))) continue
    seen.add(key(cols))
    out.push(cols)
  }
  return out
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))

/** A name made of letters, digits and `_` that starts with a letter (or `_` where allowed). */
function identifier(name: string, options: { leading?: string; underscore?: boolean } = {}): string {
  let s = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_]+/g, '_')
  if (!s) s = 'x'
  if (!/^[A-Za-z]/.test(s) && !(options.underscore && /^_/.test(s))) s = `${options.leading ?? 'x'}${/^_/.test(s) ? '' : '_'}${s}`
  return s
}

function pascal(name: string): string {
  const words = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean)
  const s = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('')
  return /^[A-Za-z]/.test(s) ? s : `T${s}`
}

function camel(name: string): string {
  // A name that is already camelCase stays as it is (drizzle-kit pull does the same).
  if (/^[a-z][A-Za-z0-9]*$/.test(name)) return name
  const words = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (!words.length) return 'x'
  const s = words.map((w, i) => (i === 0 ? (/^[A-Z0-9_]+$/.test(w) ? w.toLowerCase() : w[0]!.toLowerCase() + w.slice(1)) : w[0]!.toUpperCase() + w.slice(1).toLowerCase())).join('')
  return /^[A-Za-z_$]/.test(s) ? s : `_${s}`
}

/** Gives each wanted name once: a second one gets a number. */
function namer(taken: Iterable<string> = [], fold = (s: string) => s) {
  const used = new Set([...taken].map(fold))
  return (wanted: string) => {
    let name = wanted
    for (let n = 2; used.has(fold(name)); n++) name = `${wanted}${n}`
    used.add(fold(name))
    return name
  }
}

/** Tables in an order where a referenced table comes before the tables that reference it, as far as cycles allow. */
function referencedFirst(model: Model): TableInfo[] {
  const out: TableInfo[] = []
  const state = new Map<TableInfo, 'visiting' | 'done'>()
  const visit = (t: TableInfo) => {
    if (state.get(t)) return
    state.set(t, 'visiting')
    for (const fk of t.foreignKeys) {
      const target = model.target(t, fk)
      if (target && target !== t && !state.get(target)) visit(target)
    }
    state.set(t, 'done')
    out.push(t)
  }
  model.tables.forEach(visit)
  return out
}

const jsString = (s: string) => stringLiteral(s, 'js')
const prismaString = (s: string) => stringLiteral(s, 'prisma')
const pyString = (s: string) => stringLiteral(s, 'python')
const HEADER = 'Generated by DB Mastermind'

// ---------------------------------------------------------------------------------------------------------------
// Prisma

const PRISMA_RESERVED = new Set(
  'async await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return super switch this throw true try typeof var void while with yield PrismaClient Prisma String Int BigInt Float Decimal Boolean DateTime Json Bytes Unsupported'.split(' '),
)
const PRISMA_ACTIONS: Record<string, string> = { CASCADE: 'Cascade', RESTRICT: 'Restrict', 'NO ACTION': 'NoAction', 'SET NULL': 'SetNull', 'SET DEFAULT': 'SetDefault' }

interface PrismaField {
  column: ColumnInfo
  name: string
  type: ColumnType
  scalar: string
  native?: string
  enumName?: string
  /** The enum's members by their value in the database (the names Prisma gets for them). */
  members?: Map<string, string>
  list?: boolean
}

/** A column's Prisma type and native type (`@db.*`) for a provider, as `prisma db pull` maps them. */
function prismaType(type: ColumnType, raw: string, provider: string): { scalar: string; native?: string } {
  const n = type.length
  const s = type.scale
  const unsupported = { scalar: `Unsupported(${prismaString(raw.trim())})` }
  const u = type.unsigned ? 'Unsigned' : ''
  switch (provider) {
    case 'postgresql':
    case 'cockroachdb': {
      const crdb = provider === 'cockroachdb'
      switch (type.family) {
        case 'smallint':
        case 'tinyint':
          return { scalar: 'Int', native: crdb ? 'Int2' : 'SmallInt' }
        case 'integer':
        case 'mediumint':
          return { scalar: 'Int' }
        case 'bigint':
          return { scalar: 'BigInt' }
        case 'decimal':
          return { scalar: 'Decimal', native: n !== undefined ? `Decimal(${n}, ${s ?? 0})` : 'Decimal' }
        case 'money':
          return crdb ? { scalar: 'Decimal', native: 'Decimal(19, 4)' } : { scalar: 'Decimal', native: 'Money' }
        case 'real':
          return { scalar: 'Float', native: crdb ? 'Float4' : 'Real' }
        case 'double':
          return { scalar: 'Float' }
        case 'boolean':
          return { scalar: 'Boolean' }
        case 'char':
          return { scalar: 'String', native: `Char(${n ?? 1})` }
        case 'varchar':
          return { scalar: 'String', native: crdb ? (n ? `String(${n})` : undefined) : n ? `VarChar(${n})` : 'VarChar' }
        case 'text':
          return { scalar: 'String', native: type.name === 'citext' && !crdb ? 'Citext' : undefined }
        case 'uuid':
          return { scalar: 'String', native: 'Uuid' }
        case 'date':
          return { scalar: 'DateTime', native: 'Date' }
        case 'time':
          return { scalar: 'DateTime', native: `Time(${n ?? 6})` }
        case 'timetz':
          return { scalar: 'DateTime', native: `Timetz(${n ?? 6})` }
        // (Prisma's own DateTime is timestamp(3): that one needs no native type.)
        case 'timestamp':
          return { scalar: 'DateTime', native: n === 3 ? undefined : `Timestamp(${Math.min(n ?? 6, 6)})` }
        case 'timestamptz':
          return { scalar: 'DateTime', native: `Timestamptz(${Math.min(n ?? 6, 6)})` }
        case 'json':
          return crdb ? { scalar: 'Json' } : { scalar: 'Json', native: 'Json' }
        case 'jsonb':
          return { scalar: 'Json' }
        case 'binary':
          return { scalar: 'Bytes' }
        case 'bit':
          return { scalar: 'String', native: type.name.startsWith('var') || type.name === 'bit varying' ? `VarBit${n ? `(${n})` : ''}` : `Bit(${n ?? 1})` }
        case 'xml':
          return crdb ? unsupported : { scalar: 'String', native: 'Xml' }
        case 'network':
          return type.name === 'inet' ? { scalar: 'String', native: 'Inet' } : unsupported
        case 'year':
          return { scalar: 'Int' }
        default:
          return unsupported
      }
    }
    case 'mysql':
      switch (type.family) {
        case 'tinyint':
          return { scalar: 'Int', native: `${u}TinyInt` }
        case 'smallint':
          return { scalar: 'Int', native: `${u}SmallInt` }
        case 'mediumint':
          return { scalar: 'Int', native: `${u}MediumInt` }
        case 'integer':
          return { scalar: 'Int', native: type.unsigned ? 'UnsignedInt' : undefined }
        case 'bigint':
          return { scalar: 'BigInt', native: type.unsigned ? 'UnsignedBigInt' : undefined }
        case 'decimal':
          return { scalar: 'Decimal', native: `Decimal(${n ?? 10}, ${s ?? 0})` }
        case 'money':
          return { scalar: 'Decimal', native: 'Decimal(19, 4)' }
        case 'real':
          return { scalar: 'Float', native: 'Float' }
        case 'double':
          // MySQL's FLOAT is single precision.
          return type.name === 'float' ? { scalar: 'Float', native: 'Float' } : { scalar: 'Float' }
        case 'boolean':
          return type.name === 'bit' ? { scalar: 'Boolean', native: 'Bit(1)' } : { scalar: 'Boolean' }
        case 'char':
          return { scalar: 'String', native: `Char(${n ?? 1})` }
        case 'varchar':
          return { scalar: 'String', native: `VarChar(${n ?? 255})` }
        case 'text':
          return { scalar: 'String', native: type.name === 'tinytext' ? 'TinyText' : type.name === 'mediumtext' ? 'MediumText' : type.name === 'longtext' ? 'LongText' : 'Text' }
        case 'uuid':
          return { scalar: 'String', native: 'Char(36)' }
        case 'date':
          return { scalar: 'DateTime', native: 'Date' }
        case 'time':
        case 'timetz':
          return { scalar: 'DateTime', native: `Time(${n ?? 0})` }
        case 'timestamp':
          return { scalar: 'DateTime', native: type.name === 'timestamp' ? `Timestamp(${n ?? 0})` : `DateTime(${Math.min(n ?? 0, 6)})` }
        case 'timestamptz':
          return { scalar: 'DateTime', native: `Timestamp(${Math.min(n ?? 0, 6)})` }
        case 'year':
          return { scalar: 'Int', native: 'Year' }
        case 'json':
        case 'jsonb':
          return { scalar: 'Json' }
        case 'binary':
          if (type.name === 'binary') return { scalar: 'Bytes', native: `Binary(${n ?? 1})` }
          if (type.name === 'varbinary' && n) return { scalar: 'Bytes', native: `VarBinary(${n})` }
          return { scalar: 'Bytes', native: type.name === 'tinyblob' ? 'TinyBlob' : type.name === 'blob' ? 'Blob' : type.name === 'mediumblob' ? 'MediumBlob' : 'LongBlob' }
        case 'bit':
          return { scalar: 'Bytes', native: `Bit(${n ?? 1})` }
        default:
          return unsupported
      }
    case 'sqlserver':
      switch (type.family) {
        case 'tinyint':
          return { scalar: 'Int', native: 'TinyInt' }
        case 'smallint':
          return { scalar: 'Int', native: 'SmallInt' }
        case 'integer':
        case 'mediumint':
        case 'year':
          return { scalar: 'Int' }
        case 'bigint':
          return { scalar: 'BigInt' }
        case 'decimal':
          return { scalar: 'Decimal', native: `Decimal(${n ?? 18}, ${s ?? 0})` }
        case 'money':
          return { scalar: 'Float', native: type.name === 'smallmoney' ? 'SmallMoney' : 'Money' }
        case 'real':
          return { scalar: 'Float', native: 'Real' }
        case 'double':
          return { scalar: 'Float' }
        case 'boolean':
          return { scalar: 'Boolean' }
        case 'char':
          return { scalar: 'String', native: `${type.national ? 'NChar' : 'Char'}(${n ?? 1})` }
        case 'varchar':
          return { scalar: 'String', native: `${type.name === 'varchar' ? 'VarChar' : 'NVarChar'}(${n ?? 255})` }
        case 'text':
          return { scalar: 'String', native: type.name === 'text' ? 'Text' : type.name === 'ntext' ? 'NText' : type.name === 'varchar' ? 'VarChar(Max)' : 'NVarChar(Max)' }
        case 'uuid':
          return { scalar: 'String', native: 'UniqueIdentifier' }
        case 'date':
          return { scalar: 'DateTime', native: 'Date' }
        case 'time':
        case 'timetz':
          return { scalar: 'DateTime', native: 'Time' }
        case 'timestamp':
          return { scalar: 'DateTime', native: type.name === 'datetime' ? 'DateTime' : type.name === 'smalldatetime' ? 'SmallDateTime' : undefined }
        case 'timestamptz':
          return { scalar: 'DateTime', native: 'DateTimeOffset' }
        // SQL Server has no JSON type: Prisma keeps JSON there as text.
        case 'json':
        case 'jsonb':
          return { scalar: 'String', native: 'NVarChar(Max)' }
        case 'binary':
          if (type.name === 'binary') return { scalar: 'Bytes', native: `Binary(${n ?? 1})` }
          if (type.name === 'varbinary' && n) return { scalar: 'Bytes', native: `VarBinary(${n})` }
          return type.name === 'image' ? { scalar: 'Bytes', native: 'Image' } : { scalar: 'Bytes' }
        case 'xml':
          return { scalar: 'String', native: 'Xml' }
        default:
          return unsupported
      }
    default:
      // SQLite: no native types.
      switch (type.family) {
        case 'smallint':
        case 'integer':
        case 'tinyint':
        case 'mediumint':
        case 'year':
          return { scalar: 'Int' }
        case 'bigint':
          return { scalar: 'BigInt' }
        case 'decimal':
        case 'money':
          return { scalar: 'Decimal' }
        case 'real':
        case 'double':
          return { scalar: 'Float' }
        case 'boolean':
          return { scalar: 'Boolean' }
        case 'char':
        case 'varchar':
        case 'text':
        case 'uuid':
        case 'xml':
        case 'network':
        case 'interval':
          return { scalar: 'String' }
        case 'date':
        case 'time':
        case 'timetz':
        case 'timestamp':
        case 'timestamptz':
          return { scalar: 'DateTime' }
        case 'json':
        case 'jsonb':
          return { scalar: 'Json' }
        case 'binary':
          return { scalar: 'Bytes' }
        default:
          // SQLite takes any type name; what Prisma can't map it reads as text.
          return type.name === '' ? { scalar: 'String' } : unsupported
      }
  }
}

/** A Prisma schema: what `prisma db pull` writes for these tables (Prisma 7: the connection URL is in prisma.config.ts). */
export function toPrisma(tables: TableInfo[], options: CodeOptions = {}): string {
  const database = options.database ?? 'postgres'
  const provider = PRISMA_PROVIDERS[database]
  if (!provider) throw new Error(`Prisma has no provider for ${database}`)
  const model = modelOf(tables, options)
  const enumsSupported = provider !== 'sqlserver'
  // Several schemas: each model says its own (`@@schema`); otherwise tables of the same name are told apart by name.
  const schemaNames = [...new Set(model.tables.map((t) => model.schemaOf(t) ?? ''))]
  const defaultSchema = options.defaultSchema ?? (provider === 'sqlserver' ? 'dbo' : 'public')
  const multiSchema = ['postgresql', 'cockroachdb', 'sqlserver'].includes(provider) && schemaNames.some(Boolean)
  const schemaOf = (t: TableInfo) => model.schemaOf(t) ?? defaultSchema
  // Without schemas Prisma holds one table of a name (MySQL databases, SQLite): the others are left out.
  const leftOut = multiSchema ? [] : model.tables.filter((t, i) => model.tables.findIndex((o) => o.name.toLowerCase() === t.name.toLowerCase()) !== i)
  model.tables = model.tables.filter((t) => !leftOut.includes(t))

  const typeName = namer(PRISMA_RESERVED)
  const clash = new Set(model.tables.filter((t) => model.tables.some((o) => o !== t && o.name === t.name)).map((t) => t)) // same name in two schemas
  const modelNames = new Map<TableInfo, string>()
  for (const t of model.tables) modelNames.set(t, typeName(identifier(clash.has(t) && model.schemaOf(t) ? `${model.schemaOf(t)}_${t.name}` : t.name)))

  // Enums: the model's named ones and MySQL's inline ENUM(…) columns (named table_column, as db pull names them).
  const enums = new Map<string, { name: string; values: string[]; schema: string; source: string; members: Map<string, string> }>()
  const enumFor = (t: TableInfo, c: ColumnInfo, type: ColumnType): string | undefined => {
    if (!enumsSupported) return undefined
    const named = model.enumOf(c)
    const key = named ? `named:${named.name}` : type.family === 'enum' ? `inline:${t.name}.${c.name}` : undefined
    if (!key) return undefined
    const wanted = named ? named.name : `${t.name}_${c.name}`
    if (!enums.has(key)) {
      const name = typeName(identifier(wanted))
      // (MySQL's inline enums have no name in the database to map to.)
      const values = named ? named.values : (type.values ?? [])
      // Members are identifiers (a value that isn't one is @map-ped), each once.
      const member = namer()
      const members = new Map<string, string>()
      for (const v of values) if (!members.has(v)) members.set(v, member(identifier(v || 'EMPTY_ENUM_VALUE', { leading: 'v' })))
      enums.set(key, { name, values: [...members.keys()], schema: schemaOf(t), source: named ? named.name : name, members })
    }
    return enums.get(key)!.name
  }

  const fieldsOf = new Map<TableInfo, PrismaField[]>()
  for (const t of model.tables) {
    const fieldName = namer([], (s) => s.toLowerCase())
    fieldsOf.set(
      t,
      t.columns.map((column) => {
        const type = classifyType(column.dataType, database)
        const enumName = enumFor(t, column, type)
        const mapped = enumName ? { scalar: enumName } : prismaType({ ...type, array: false }, column.dataType.replace(/\[\]$/, ''), provider)
        // Lists only where the database has arrays (and of types Prisma can list).
        const list = !!type.array && (provider === 'postgresql' || provider === 'cockroachdb') && !mapped.scalar.startsWith('Unsupported')
        const scalar = type.array && !list ? `Unsupported(${prismaString(column.dataType.trim())})` : mapped.scalar
        return { column, name: fieldName(identifier(column.name)), type, scalar, native: scalar === mapped.scalar ? (mapped as { native?: string }).native : undefined, enumName, members: enumName ? [...enums.values()].find((e) => e.name === enumName)?.members : undefined, list }
      }),
    )
  }
  const supported = (f: PrismaField) => !f.scalar.startsWith('Unsupported')
  const field = (t: TableInfo, column: string) => fieldsOf.get(t)!.find((f) => f.column.name === column)
  // A model needs a key Prisma can use: required columns of supported types.
  const criteria = (t: TableInfo) => uniqueSets(t).filter((cols) => cols.every((c) => field(t, c) && supported(field(t, c)!) && !field(t, c)!.column.nullable && !field(t, c)!.list))
  const ignored = new Set(model.tables.filter((t) => !criteria(t).length))

  // Relations, with both sides.
  interface Relation {
    child: TableInfo
    parent: TableInfo
    fk: ForeignKeyInfo
    name?: string
    childField: string
    parentField: string
    oneToOne: boolean
  }
  const relations: Relation[] = []
  const notes = new Map<TableInfo, string[]>()
  const note = (t: TableInfo, text: string) => notes.set(t, [...(notes.get(t) ?? []), text])
  for (const child of model.tables) {
    for (const fk of child.foreignKeys) {
      const parent = model.target(child, fk)
      const why = !parent
        ? `${fk.refTable} is not in the model`
        : ignored.has(child) || ignored.has(parent)
          ? `${ignored.has(child) ? child.name : parent.name} has no key Prisma can use`
          : fk.columns.some((c) => !field(child, c)) || fk.refColumns.some((c) => !field(parent, c))
            ? 'a column it names is not in the table'
            : !criteria(parent).some((cols) => sameSet(cols, fk.refColumns))
              ? `${fk.refColumns.join(', ')} is not a key of ${parent.name}`
              : fk.columns.some((c, i) => field(child, c)!.scalar !== field(parent, fk.refColumns[i]!)!.scalar)
                ? 'the columns have different types'
                : undefined
      if (why || !parent) {
        note(child, `The foreign key ${fk.name || fk.columns.join(', ')} → ${fk.refTable} is not a relation here: ${why}.`)
        continue
      }
      relations.push({ child, parent, fk, childField: '', parentField: '', oneToOne: uniqueSets(child).some((cols) => sameSet(cols, fk.columns)) })
    }
  }
  // Relations between the same two models (or of a model to itself) need names.
  const pair = (r: Relation) => [modelNames.get(r.child)!, modelNames.get(r.parent)!].sort().join('\u0000')
  for (const r of relations) {
    const between = relations.filter((o) => pair(o) === pair(r))
    const child = modelNames.get(r.child)!
    const parent = modelNames.get(r.parent)!
    if (r.child === r.parent && between.length === 1) r.name = `${child}To${parent}`
    else if (between.length > 1) r.name = `${child}_${r.fk.columns.map((c) => field(r.child, c)!.name).join('_')}To${parent}`
  }
  // Relation fields are named after the other model (db pull's names), never taking a column's name.
  const relationName = new Map<TableInfo, (s: string) => string>()
  for (const t of model.tables) relationName.set(t, namer(fieldsOf.get(t)!.map((f) => f.name), (s) => s.toLowerCase()))
  for (const r of relations) {
    const child = modelNames.get(r.child)!
    const parent = modelNames.get(r.parent)!
    const only = relations.filter((o) => o.child === r.child && o.parent === r.parent).length === 1
    const forward = r.name && !(r.child === r.parent && only) ? `${parent}_${r.name}` : parent
    r.childField = relationName.get(r.child)!(forward)
    // The other side of a self-relation is the same model again: db pull calls it other_….
    r.parentField = relationName.get(r.parent)!(r.child === r.parent ? `other_${forward}` : r.name ? `${child}_${r.name}` : child)
  }

  const out: string[] = [
    `// ${HEADER}: the model as \`prisma db pull\` would write it.`,
    '',
    // (As `prisma init` writes it in Prisma 7: the client goes to generated/prisma beside the prisma/ folder.)
    '// The client is generated where `prisma init` puts it: change output to suit your project.',
    'generator client {',
    '  provider = "prisma-client"',
    '  output   = "../generated/prisma"',
    '}',
    '',
    '// Prisma 7 reads the connection URL from prisma.config.ts. For Prisma 6, add here: url = env("DATABASE_URL")',
    'datasource db {',
    `  provider = "${provider}"`,
    ...(multiSchema ? [`  schemas  = [${[...new Set(model.tables.map(schemaOf))].sort().map((s) => prismaString(s)).join(', ')}]`] : []),
    '}',
    ...leftOut.map((t) => `\n// ${commentText(`${t.schema}.${t.name} is left out: Prisma can't hold two tables named ${t.name} without schemas.`, 'prisma')}`),
  ]

  const keyNameDefault = (t: TableInfo, cols: string[], suffix: string) => `${t.name}_${cols.join('_')}_${suffix}`
  // A constraint name the database could not have (longer than it allows) is not kept: Prisma refuses it.
  const nameLimit = provider === 'sqlserver' ? 128 : provider === 'mysql' ? 64 : 63
  const fits = (name: string) => new TextEncoder().encode(name).length <= nameLimit
  for (const t of model.tables) {
    const fields = fieldsOf.get(t)!
    const lines: string[][] = []
    const pk = t.primaryKey.length && t.primaryKey.every((c) => field(t, c)) ? t.primaryKey : []
    const identities = fields.filter((f) => defaultOf(f.column, f.type)?.kind === 'autoincrement' && isIntegerFamily(f.type))
    // Where the database allows one numbering column per table on the key only (SQLite) or on an indexed one (MySQL, SQL Server).
    const numbered = provider === 'postgresql' || provider === 'cockroachdb' ? identities : identities.filter((f) => pk.length === 1 && pk[0] === f.column.name).slice(0, 1)
    const singleUnique = new Map<string, string | undefined>()
    const blockAttrs: string[] = []
    // The primary key's constraint name, where the database names it (not DBML's made-up pk_table, not Prisma's default).
    const pkName = t.indexes.find((i) => i.primary)?.name
    const pkMap = pkName && fits(pkName) && ['postgresql', 'cockroachdb', 'sqlserver'].includes(provider) && pkName !== `${t.name}_pkey` && pkName !== `pk_${t.name}` ? `map: ${prismaString(pkName)}` : ''
    if (pk.length > 1) blockAttrs.push(`@@id([${pk.map((c) => field(t, c)!.name).join(', ')}]${pkMap ? `, ${pkMap}` : ''})`)
    const seen = new Set<string>()
    for (const ix of t.indexes) {
      if (ix.primary || !ix.columns.length || ix.columns.some((c) => !field(t, c))) continue
      if (ix.unique && sameSet(ix.columns, pk)) continue
      const sig = `${ix.unique}:${ix.columns.join('\u0000')}`
      if (seen.has(sig)) continue
      seen.add(sig)
      const map = ix.name && fits(ix.name) && ix.name !== keyNameDefault(t, ix.columns, ix.unique ? 'key' : 'idx') ? ix.name : undefined
      // A unique key on one column is an attribute of its field, unless it can't be (a list, an unsupported type).
      if (ix.unique && ix.columns.length === 1 && supported(field(t, ix.columns[0]!)!) && !singleUnique.has(ix.columns[0]!)) {
        singleUnique.set(ix.columns[0]!, map)
        continue
      }
      blockAttrs.push(`@@${ix.unique ? 'unique' : 'index'}([${ix.columns.map((c) => field(t, c)!.name).join(', ')}]${map ? `, map: ${prismaString(map)}` : ''})`)
    }
    for (const f of fields) {
      const c = f.column
      const attrs: string[] = []
      if (pk.length === 1 && pk[0] === c.name) attrs.push(pkMap ? `@id(${pkMap})` : '@id')
      const d = defaultOf(c, f.type)
      const dflt = prismaDefault(d, f, numbered.includes(f), provider)
      if (dflt) attrs.push(`@default(${dflt})`)
      if (singleUnique.has(c.name)) attrs.push(singleUnique.get(c.name) ? `@unique(map: ${prismaString(singleUnique.get(c.name)!)})` : '@unique')
      if (f.name !== c.name) attrs.push(`@map(${prismaString(c.name)})`)
      if (f.native) attrs.push(`@db.${f.native}`)
      for (const l of commentLines(c.comment, '/// ', 'prisma')) lines.push([l])
      lines.push([f.name, `${f.scalar}${f.list ? '[]' : c.nullable ? '?' : ''}`, attrs.join(' ')])
    }
    for (const r of relations.filter((x) => x.child === t)) {
      const optional = r.fk.columns.some((c) => field(t, c)!.column.nullable)
      const args = [
        ...(r.name ? [prismaString(r.name)] : []),
        `fields: [${r.fk.columns.map((c) => field(t, c)!.name).join(', ')}]`,
        `references: [${r.fk.refColumns.map((c) => field(r.parent, c)!.name).join(', ')}]`,
        `onDelete: ${prismaAction(r.fk.onDelete, provider)}`,
        `onUpdate: ${prismaAction(r.fk.onUpdate, provider)}`,
        ...(r.fk.name && fits(r.fk.name) && r.fk.name !== keyNameDefault(t, r.fk.columns, 'fkey') && provider !== 'sqlite' ? [`map: ${prismaString(r.fk.name)}`] : []),
      ]
      lines.push([r.childField, `${modelNames.get(r.parent)}${optional ? '?' : ''}`, `@relation(${args.join(', ')})`])
    }
    for (const r of relations.filter((x) => x.parent === t)) {
      lines.push([r.parentField, `${modelNames.get(r.child)}${r.oneToOne ? '?' : '[]'}`, r.name ? `@relation(${prismaString(r.name)})` : ''])
    }
    if (modelNames.get(t) !== t.name) blockAttrs.push(`@@map(${prismaString(t.name)})`)
    if (multiSchema) blockAttrs.push(`@@schema(${prismaString(schemaOf(t))})`)
    if (ignored.has(t)) blockAttrs.push('@@ignore')
    out.push('')
    if (ignored.has(t)) out.push('/// The underlying table does not contain a valid unique identifier and can therefore currently not be handled by Prisma Client.')
    for (const n of notes.get(t) ?? []) out.push(`// ${commentText(n, 'prisma')}`)
    out.push(...commentLines(t.comment, '/// ', 'prisma'), `model ${modelNames.get(t)} {`, ...aligned(lines, '  '))
    if (blockAttrs.length) out.push('', ...blockAttrs.map((a) => `  ${a}`))
    out.push('}')
  }
  for (const e of enums.values()) {
    out.push('', `enum ${e.name} {`)
    const values = e.values.map((v) => {
      const name = e.members.get(v)!
      return [name, name === v ? '' : `@map(${prismaString(v)})`]
    })
    out.push(...aligned(values, '  '))
    if (e.source !== e.name) out.push('', `  @@map(${prismaString(e.source)})`)
    if (multiSchema) out.push(`  @@schema(${prismaString(e.schema)})`)
    out.push('}')
  }
  return `${out.join('\n')}\n`
}

const isJson = (text: string) => {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

function prismaAction(action: string | undefined, provider: string): string {
  const a = PRISMA_ACTIONS[(action ?? 'NO ACTION').toUpperCase()] ?? 'NoAction'
  // SQL Server has no RESTRICT: its NO ACTION is the same check.
  return provider === 'sqlserver' && a === 'Restrict' ? 'NoAction' : a
}

function prismaDefault(d: Default | undefined, f: PrismaField, numbered: boolean, provider: string): string | undefined {
  if (!d) return undefined
  const generated = (sql: string) => `dbgenerated(${prismaString(sql)})`
  switch (d.kind) {
    case 'autoincrement':
      // CockroachDB numbers an Int through a sequence (its autoincrement() is unique_rowid(), a BigInt).
      return numbered ? (provider === 'cockroachdb' && f.scalar === 'Int' ? 'sequence()' : 'autoincrement()') : undefined
    case 'now':
      return f.scalar === 'DateTime' ? 'now()' : undefined
    case 'number':
      return ['Int', 'BigInt', 'Float', 'Decimal'].includes(f.scalar) ? d.value : f.scalar === 'String' ? prismaString(d.value) : f.scalar === 'Boolean' ? (d.value !== '0' ? 'true' : 'false') : generated(d.value)
    case 'bool':
      return f.scalar === 'Boolean' ? String(d.value) : generated(d.value ? 'true' : 'false')
    case 'string':
      // A member of the enum, by its name in the schema; a value the enum doesn't have is the database's to give.
      if (f.enumName) return f.members?.get(d.value) ?? generated(`'${d.value.replaceAll("'", "''")}'`)
      if (f.scalar === 'String') return prismaString(d.value)
      // Prisma reads a Json default as JSON: text that isn't is the database's to give.
      if (f.scalar === 'Json') return isJson(d.value) ? prismaString(d.value) : generated(`'${d.value.replaceAll("'", "''")}'`)
      return generated(`'${d.value.replaceAll("'", "''")}'`)
    case 'expr':
      return generated(d.sql)
  }
}

/** Lines of cells padded to columns, as `prisma format` lays a model out. */
function aligned(rows: string[][], indent: string): string[] {
  const widths: number[] = []
  for (const r of rows) if (r.length > 1) r.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)))
  return rows.map((r) => (r.length === 1 ? `${indent}${r[0]}` : `${indent}${r.map((cell, i) => (i < r.length - 1 ? cell.padEnd(widths[i]!) : cell)).join(' ')}`.trimEnd()))
}

// ---------------------------------------------------------------------------------------------------------------
// Drizzle

const JS_RESERVED = new Set(
  'break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await arguments eval undefined NaN Infinity'.split(' '),
)

/** A Drizzle schema: what `drizzle-kit pull` writes, with `.references()` for single-column foreign keys. */
export function toDrizzle(tables: TableInfo[], options: CodeOptions = {}): string {
  const database = options.database ?? 'postgres'
  const dialect = DRIZZLE_DIALECTS[database]
  if (!dialect) throw new Error(`Drizzle has no dialect for ${database}`)
  const model = modelOf(tables, options)
  const core = dialect === 'pg' ? 'pg-core' : dialect === 'mysql' ? 'mysql-core' : 'sqlite-core'
  const tableFn = dialect === 'pg' ? 'pgTable' : dialect === 'mysql' ? 'mysqlTable' : 'sqliteTable'
  const anyColumn = dialect === 'pg' ? 'AnyPgColumn' : dialect === 'mysql' ? 'AnyMySqlColumn' : 'AnySQLiteColumn'
  const imports = new Set<string>([tableFn])
  let usesSql = false
  const customTypes = new Map<string, { name: string; ts: string }>()

  const ordered = referencedFirst(model)
  const constName = namer([...JS_RESERVED, 'sql', 'customType', tableFn, anyColumn, 'index', 'uniqueIndex', 'unique', 'primaryKey', 'foreignKey', 'check'])
  // Builders are imported by name: a table can't take one of those names.
  const BUILDERS = ['smallint', 'integer', 'bigint', 'serial', 'smallserial', 'bigserial', 'numeric', 'real', 'doublePrecision', 'boolean', 'char', 'varchar', 'text', 'uuid', 'date', 'time', 'timestamp', 'interval', 'json', 'jsonb', 'inet', 'cidr', 'macaddr', 'macaddr8', 'int', 'tinyint', 'mediumint', 'decimal', 'float', 'double', 'datetime', 'year', 'binary', 'varbinary', 'tinytext', 'mediumtext', 'longtext', 'mysqlEnum', 'pgEnum', 'pgSchema', 'mysqlSchema', 'blob']
  const tableConst = new Map<TableInfo, string>()
  const takenBuilders = new Set(BUILDERS)
  for (const t of ordered) {
    const wanted = camel(model.schemaOf(t) && model.tables.some((o) => o !== t && o.name === t.name) ? `${model.schemaOf(t)}_${t.name}` : t.name)
    tableConst.set(t, constName(takenBuilders.has(wanted) ? `${wanted}Table` : wanted))
  }
  // PostgreSQL schemas and enums are constants of their own.
  const schemaConst = new Map<string, string>()
  const enumConst = new Map<string, { name: string; values: string[]; schema?: string; sqlName: string }>()
  const columnKeys = new Map<TableInfo, Map<string, string>>()
  for (const t of model.tables) {
    const key = namer(['_'])
    columnKeys.set(t, new Map(t.columns.map((c) => [c.name, key(camel(c.name))])))
  }
  const keyOf = (t: TableInfo, column: string) => columnKeys.get(t)!.get(column) ?? camel(column)
  const prop = (key: string) => (/^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${jsString(key)}]`)
  const objKey = (key: string) => (/^[A-Za-z_$][\w$]*$/.test(key) ? key : jsString(key))

  const custom = (sqlType: string, ts: string) => {
    imports.add('customType')
    const key = `${sqlType}\u0000${ts}`
    if (!customTypes.has(key)) customTypes.set(key, { name: constName(camel(`${sqlType.replace(/\(.*$/, '')}_type`)), ts })
    return customTypes.get(key)!.name
  }

  /** The builder call for a column (without its modifiers). */
  const builder = (t: TableInfo, c: ColumnInfo, type: ColumnType): { call: string; ts: 'number' | 'string' | 'boolean' | 'date' | 'json' | 'other'; numbered?: boolean } => {
    const key = keyOf(t, c.name)
    // The database's name is given only when the key differs from it.
    const nameArg = key === c.name ? '' : jsString(c.name)
    const call = (fn: string, config?: string) => {
      imports.add(fn)
      return `${fn}(${[nameArg, config].filter(Boolean).join(', ')})`
    }
    const named = model.enumOf(c)
    if (named && dialect === 'pg') {
      const k = named.name
      if (!enumConst.has(k)) enumConst.set(k, { name: constName(camel(`${k}`)), values: named.values, schema: model.schemaOf(t), sqlName: named.name })
      return { call: `${enumConst.get(k)!.name}(${nameArg})`, ts: 'string' }
    }
    const n = type.length
    const unsigned = type.unsigned ? 'unsigned: true' : ''
    const cfg = (...parts: string[]) => (parts.filter(Boolean).length ? `{ ${parts.filter(Boolean).join(', ')} }` : undefined)
    if (dialect === 'sqlite') {
      switch (type.family) {
        case 'smallint':
        case 'integer':
        case 'tinyint':
        case 'mediumint':
        case 'bigint':
        case 'year':
          return { call: call('integer'), ts: 'number' }
        case 'boolean':
          return { call: call('integer', "{ mode: 'boolean' }"), ts: 'boolean' }
        case 'decimal':
        case 'money':
          return { call: call('numeric'), ts: 'string' }
        case 'real':
        case 'double':
          return { call: call('real'), ts: 'number' }
        case 'binary':
          return { call: call('blob'), ts: 'other' }
        case 'enum':
          return { call: call('text', `{ enum: [${(type.values ?? []).map(jsString).join(', ')}] }`), ts: 'string' }
        default:
          if (named) return { call: call('text', `{ enum: [${named.values.map(jsString).join(', ')}] }`), ts: 'string' }
          // SQLite keeps dates and everything else it has no class for as text (drizzle-kit pull does the same).
          return { call: call('text'), ts: 'string' }
      }
    }
    if (dialect === 'mysql') {
      switch (type.family) {
        case 'tinyint':
          return { call: call('tinyint', cfg(unsigned)), ts: 'number' }
        case 'smallint':
          return { call: call('smallint', cfg(unsigned)), ts: 'number' }
        case 'mediumint':
          return { call: call('mediumint', cfg(unsigned)), ts: 'number' }
        case 'integer':
          return { call: call('int', cfg(unsigned)), ts: 'number' }
        case 'bigint':
          return { call: call('bigint', cfg("mode: 'number'", unsigned)), ts: 'number' }
        case 'decimal':
          return { call: call('decimal', cfg(n !== undefined ? `precision: ${n}` : '', type.scale !== undefined ? `scale: ${type.scale}` : '', unsigned)), ts: 'string' }
        case 'money':
          return { call: call('decimal', '{ precision: 19, scale: 4 }'), ts: 'string' }
        case 'real':
          return { call: call('float', cfg(unsigned)), ts: 'number' }
        case 'double':
          return { call: call(type.name === 'float' ? 'float' : 'double', cfg(unsigned)), ts: 'number' }
        case 'boolean':
          return { call: call('boolean'), ts: 'boolean' }
        case 'char':
          return { call: call('char', cfg(n !== undefined ? `length: ${n}` : '')), ts: 'string' }
        case 'varchar':
          return { call: call('varchar', `{ length: ${n ?? 255} }`), ts: 'string' }
        case 'uuid':
          return { call: call('char', '{ length: 36 }'), ts: 'string' }
        case 'text':
          return { call: call(['tinytext', 'mediumtext', 'longtext'].includes(type.name) ? type.name : 'text'), ts: 'string' }
        case 'date':
          return { call: call('date', "{ mode: 'string' }"), ts: 'string' }
        case 'time':
        case 'timetz':
          return { call: call('time', cfg(n ? `fsp: ${Math.min(n, 6)}` : '')), ts: 'string' }
        case 'timestamp':
        case 'timestamptz':
          return { call: call(type.name === 'timestamp' || type.family === 'timestamptz' ? 'timestamp' : 'datetime', cfg("mode: 'string'", n ? `fsp: ${Math.min(n, 6)}` : '')), ts: 'date' }
        case 'year':
          return { call: call('year'), ts: 'number' }
        case 'json':
        case 'jsonb':
          return { call: call('json'), ts: 'json' }
        case 'binary':
          if (type.name === 'binary') return { call: call('binary', cfg(n ? `length: ${n}` : '')), ts: 'string' }
          if (type.name === 'varbinary' && n) return { call: call('varbinary', `{ length: ${n} }`), ts: 'string' }
          return { call: `${custom(['tinyblob', 'mediumblob', 'longblob', 'blob'].includes(type.name) ? type.name : 'longblob', 'Buffer')}(${nameArg})`, ts: 'other' }
        case 'enum':
          imports.add('mysqlEnum')
          return { call: `mysqlEnum(${jsString(c.name)}, [${(type.values ?? []).map(jsString).join(', ')}])`, ts: 'string' }
        default:
          if (named) {
            imports.add('mysqlEnum')
            return { call: `mysqlEnum(${jsString(c.name)}, [${named.values.map(jsString).join(', ')}])`, ts: 'string' }
          }
          return { call: `${custom(c.dataType.trim(), 'string')}(${nameArg})`, ts: 'other' }
      }
    }
    // PostgreSQL (and CockroachDB).
    const array = type.array ? '.array()' : ''
    const pg = (fn: string, config?: string) => `${call(fn, config)}${array}`
    switch (type.family) {
      case 'smallint':
      case 'tinyint':
        return { call: type.serial ? pg('smallserial') : pg('smallint'), ts: 'number', numbered: type.serial }
      case 'integer':
      case 'mediumint':
      case 'year':
        return { call: type.serial ? pg('serial') : pg('integer'), ts: 'number', numbered: type.serial }
      case 'bigint':
        return { call: type.serial ? pg('bigserial', "{ mode: 'number' }") : pg('bigint', "{ mode: 'number' }"), ts: 'number', numbered: type.serial }
      case 'decimal':
        return { call: pg('numeric', cfg(n !== undefined ? `precision: ${n}` : '', type.scale !== undefined ? `scale: ${type.scale}` : '')), ts: 'string' }
      case 'real':
        return { call: pg('real'), ts: 'number' }
      case 'double':
        return { call: pg('doublePrecision'), ts: 'number' }
      case 'boolean':
        return { call: pg('boolean'), ts: 'boolean' }
      case 'char':
        return { call: pg('char', cfg(n !== undefined ? `length: ${n}` : '')), ts: 'string' }
      case 'varchar':
        return { call: pg('varchar', cfg(n !== undefined ? `length: ${n}` : '')), ts: 'string' }
      case 'text':
        return { call: type.name === 'citext' ? `${custom('citext', 'string')}(${nameArg})${array}` : pg('text'), ts: 'string' }
      case 'uuid':
        return { call: pg('uuid'), ts: 'string' }
      case 'date':
        return { call: pg('date'), ts: 'string' }
      case 'time':
      case 'timetz':
        return { call: pg('time', cfg(n !== undefined ? `precision: ${Math.min(n, 6)}` : '', type.family === 'timetz' ? 'withTimezone: true' : '')), ts: 'string' }
      case 'timestamp':
      case 'timestamptz':
        return { call: pg('timestamp', cfg(n !== undefined ? `precision: ${Math.min(n, 6)}` : '', type.family === 'timestamptz' ? 'withTimezone: true' : '', "mode: 'string'")), ts: 'date' }
      case 'interval':
        return { call: pg('interval'), ts: 'string' }
      case 'json':
        return { call: pg('json'), ts: 'json' }
      case 'jsonb':
        return { call: pg('jsonb'), ts: 'json' }
      case 'network':
        return { call: pg(type.name), ts: 'string' }
      default:
        return { call: `${custom(c.dataType.trim().replace(/\[\]$/, ''), type.family === 'binary' ? 'Buffer' : 'string')}(${nameArg})${array}`, ts: 'other' }
    }
  }

  const body: string[] = []
  const tableBlocks: string[] = []
  for (const t of ordered) {
    const name = tableConst.get(t)!
    const schema = model.schemaOf(t)
    let fn = tableFn
    if (schema && dialect !== 'sqlite') {
      if (!schemaConst.has(schema)) schemaConst.set(schema, constName(camel(`${schema}_schema`)))
      imports.add(dialect === 'pg' ? 'pgSchema' : 'mysqlSchema')
      fn = `${schemaConst.get(schema)}.table`
    }
    const pk = t.primaryKey.filter((c) => t.columns.some((x) => x.name === c))
    // A foreign key with a name of its own is kept in the table's config with it (`.references()` has no name).
    // SQLite's have none: the names the app shows for them are made up.
    const ownName = (fk: ForeignKeyInfo) => dialect !== 'sqlite' && !!fk.name && fk.name !== defaultFkName(t.name, fk.columns)
    const singleFks = new Map(t.foreignKeys.filter((fk) => fk.columns.length === 1 && model.target(t, fk) && !ownName(fk)).map((fk) => [fk.columns[0]!, fk]))
    const lines: string[] = []
    let numberedOnce = false
    for (const c of t.columns) {
      const type = classifyType(c.dataType, database)
      const b = builder(t, c, type)
      let expr = b.call
      const d = defaultOf(c, type)
      const isPk = pk.length === 1 && pk[0] === c.name
      if (d?.kind === 'autoincrement' && !b.numbered) {
        if (dialect === 'pg') expr += '.generatedByDefaultAsIdentity()'
        else if (dialect === 'mysql' && !numberedOnce) expr += '.autoincrement()'
        numberedOnce = true
      }
      if (isPk) expr += dialect === 'sqlite' && d?.kind === 'autoincrement' ? '.primaryKey({ autoIncrement: true })' : '.primaryKey()'
      if (!c.nullable && !isPk) expr += '.notNull()'
      const dflt = d && d.kind !== 'autoincrement' ? drizzleDefault(d, b.ts, dialect, type) : undefined
      if (dflt) {
        if (dflt.includes('sql`')) usesSql = true
        expr += dflt
      }
      const unique = t.indexes.find((ix) => ix.unique && !ix.primary && ix.columns.length === 1 && ix.columns[0] === c.name && !sameSet(ix.columns, pk))
      if (unique && !unique.name) expr += '.unique()'
      const fk = singleFks.get(c.name)
      if (fk) {
        const target = model.target(t, fk)!
        imports.add(anyColumn)
        const actions = [fk.onDelete && fk.onDelete !== 'NO ACTION' ? `onDelete: '${fk.onDelete.toLowerCase()}'` : '', fk.onUpdate && fk.onUpdate !== 'NO ACTION' ? `onUpdate: '${fk.onUpdate.toLowerCase()}'` : ''].filter(Boolean)
        expr += `.references((): ${anyColumn} => ${tableConst.get(target)}${prop(keyOf(target, fk.refColumns[0]!))}${actions.length ? `, { ${actions.join(', ')} }` : ''})`
      }
      lines.push(...commentLines(c.comment, '  // ', 'js'), `  ${objKey(keyOf(t, c.name))}: ${expr},`)
    }
    const extra: string[] = []
    const ref = (column: string) => `table${prop(keyOf(t, column))}`
    if (pk.length > 1) {
      imports.add('primaryKey')
      extra.push(`primaryKey({ columns: [${pk.map(ref).join(', ')}] })`)
    }
    const seen = new Set<string>()
    for (const ix of t.indexes) {
      if (ix.primary || !ix.columns.length || ix.columns.some((c) => !t.columns.some((x) => x.name === c))) continue
      if (ix.unique && sameSet(ix.columns, pk)) continue
      if (ix.unique && ix.columns.length === 1 && !ix.name) continue
      const sig = `${ix.unique}:${ix.columns.join('\u0000')}`
      if (seen.has(sig)) continue
      seen.add(sig)
      const fn2 = ix.unique ? (ix.constraint ? 'unique' : 'uniqueIndex') : 'index'
      imports.add(fn2)
      extra.push(`${fn2}(${jsString(ix.name)}).on(${ix.columns.map(ref).join(', ')})`)
    }
    for (const fk of t.foreignKeys) {
      const target = model.target(t, fk)
      if (!target || singleFks.get(fk.columns[0]!) === fk) continue
      imports.add('foreignKey')
      const actions = `${fk.onDelete && fk.onDelete !== 'NO ACTION' ? `.onDelete('${fk.onDelete.toLowerCase()}')` : ''}${fk.onUpdate && fk.onUpdate !== 'NO ACTION' ? `.onUpdate('${fk.onUpdate.toLowerCase()}')` : ''}`
      const foreign = fk.refColumns.map((c) => `${target === t ? 'table' : tableConst.get(target)}${prop(keyOf(target, c))}`)
      extra.push(`foreignKey({ columns: [${fk.columns.map(ref).join(', ')}], foreignColumns: [${foreign.join(', ')}]${fk.name ? `, name: ${jsString(fk.name)}` : ''} })${actions}`)
    }
    const missing = t.foreignKeys.filter((fk) => !model.target(t, fk))
    tableBlocks.push(
      [
        ...missing.map((fk) => `// ${commentText(`The foreign key ${fk.name || fk.columns.join(', ')} → ${fk.refTable} is left out: ${fk.refTable} is not in the model.`, 'js')}`),
        ...commentLines(t.comment, '// ', 'js'),
        `export const ${name} = ${fn}(${jsString(t.name)}, {`,
        ...lines,
        extra.length ? `}, (table) => [\n${extra.map((e) => `  ${e},`).join('\n')}\n]);` : '});',
      ].join('\n'),
    )
  }

  for (const [schema, name] of schemaConst) body.push(`export const ${name} = ${dialect === 'pg' ? 'pgSchema' : 'mysqlSchema'}(${jsString(schema)});`)
  if (enumConst.size) imports.add('pgEnum')
  for (const e of enumConst.values()) {
    const schemaName = e.schema ? schemaConst.get(e.schema) : undefined
    body.push(`export const ${e.name} = ${schemaName ? `${schemaName}.enum` : 'pgEnum'}(${jsString(e.sqlName)}, [${e.values.map(jsString).join(', ')}]);`)
  }
  for (const [key, c] of customTypes) {
    const sqlType = key.split('\u0000')[0]!
    body.push(`const ${c.name} = customType<{ data: ${c.ts === 'Buffer' ? 'Uint8Array' : 'string'} }>({\n  dataType() {\n    return ${jsString(sqlType)};\n  },\n});`)
  }
  const named = [...imports].filter((i) => i !== 'customType').sort()
  const typeImports = named.filter((i) => i.startsWith('Any'))
  const valueImports = named.filter((i) => !i.startsWith('Any'))
  const head = [
    `// ${HEADER}: the model as \`drizzle-kit pull\` would write it.`,
    `import { ${[...valueImports, ...(imports.has('customType') ? ['customType'] : []), ...typeImports.map((i) => `type ${i}`)].join(', ')} } from 'drizzle-orm/${core}';`,
    ...(usesSql ? ["import { sql } from 'drizzle-orm';"] : []),
  ]
  return `${[head.join('\n'), ...(body.length ? [body.join('\n\n')] : []), ...tableBlocks].join('\n\n')}\n`
}

function drizzleDefault(d: Default, ts: string, dialect: 'pg' | 'mysql' | 'sqlite', type: ColumnType): string | undefined {
  const raw = (sql: string) => `.default(sql\`${templateText(sql)}\`)`
  switch (d.kind) {
    case 'now':
      // (drizzle-kit pull writes MySQL's and SQLite's as SQL: their string-mode columns have no defaultNow().)
      return dialect === 'pg' ? '.defaultNow()' : raw(type.length ? `CURRENT_TIMESTAMP(${type.length})` : 'CURRENT_TIMESTAMP')
    case 'number':
      if (ts === 'number') return `.default(${d.value})`
      if (ts === 'boolean') return `.default(${d.value !== '0'})`
      if (ts === 'string') return `.default(${jsString(d.value)})`
      return raw(d.value)
    case 'bool':
      return ts === 'boolean' ? `.default(${d.value})` : raw(d.value ? (dialect === 'pg' ? 'true' : '1') : dialect === 'pg' ? 'false' : '0')
    case 'string':
      if (ts === 'string' || (ts === 'date' && type.family !== 'other')) return `.default(${jsString(d.value)})`
      return raw(`'${d.value.replaceAll("'", "''")}'`)
    case 'expr':
      return raw(d.sql)
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------------------------------------------
// SQLAlchemy

const PY_KEYWORDS = new Set(
  'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case type metadata registry'.split(' '),
)
const SA_DIALECTS: Partial<Record<CodeDatabase, string>> = { postgres: 'postgresql', cockroachdb: 'postgresql', mysql: 'mysql', mariadb: 'mysql', mssql: 'mssql', sqlite: 'sqlite', oracle: 'oracle' }

/** SQLAlchemy 2.0 declarative models; types the generic SQLAlchemy has are generic, with the database's own as a variant. */
export function toSqlAlchemy(tables: TableInfo[], options: CodeOptions = {}): string {
  const database = options.database ?? 'postgres'
  const dialectName = SA_DIALECTS[database]
  const model = modelOf(tables, options)
  const sa = new Set<string>()
  const orm = new Set<string>(['DeclarativeBase', 'Mapped', 'mapped_column'])
  const dialectTypes = new Set<string>()
  const py = new Set<string>()
  const typing = new Set<string>()
  let userType = false
  const variant = (generic: string, own: string | undefined) => {
    if (!own || !dialectName) return generic
    dialectTypes.add(own.replace(/\(.*$/, ''))
    return `${generic}.with_variant(${dialectName}.${own}, ${pyString(dialectName)})`
  }
  const g = (name: string, args = '') => {
    sa.add(name)
    return `${name}(${args})`
  }
  const own = (sqlType: string) => {
    userType = true
    return `SqlType(${pyString(sqlType)})`
  }

  /** The SQLAlchemy type and the Python type of a column. */
  const typeOf = (c: ColumnInfo, type: ColumnType): { sql: string; py: string } => {
    const n = type.length
    const named = model.enumOf(c)
    const my = dialectName === 'mysql'
    const unsigned = type.unsigned && my
    if (named || type.family === 'enum') {
      const values = named ? named.values : (type.values ?? [])
      return { sql: g('Enum', [...values.map((v) => pyString(v)), `name=${pyString(named ? named.name : `${c.name}_enum`)}`].join(', ')), py: 'str' }
    }
    switch (type.family) {
      case 'smallint':
        return { sql: variant(g('SmallInteger'), unsigned ? 'SMALLINT(unsigned=True)' : undefined), py: 'int' }
      case 'tinyint':
        return { sql: variant(g('SmallInteger'), my ? `TINYINT(${unsigned ? 'unsigned=True' : ''})` : dialectName === 'mssql' ? 'TINYINT()' : undefined), py: 'int' }
      case 'mediumint':
        return { sql: variant(g('Integer'), my ? `MEDIUMINT(${unsigned ? 'unsigned=True' : ''})` : undefined), py: 'int' }
      case 'integer':
        return { sql: variant(g('Integer'), unsigned ? 'INTEGER(unsigned=True)' : undefined), py: 'int' }
      case 'bigint':
        return { sql: variant(g('BigInteger'), unsigned ? 'BIGINT(unsigned=True)' : undefined), py: 'int' }
      case 'year':
        return { sql: variant(g('SmallInteger'), my ? 'YEAR()' : undefined), py: 'int' }
      case 'decimal':
        py.add('decimal')
        return { sql: g('Numeric', n !== undefined ? `${n}, ${type.scale ?? 0}` : ''), py: 'decimal.Decimal' }
      case 'money':
        py.add('decimal')
        return { sql: variant(g('Numeric', '19, 4'), dialectName === 'postgresql' ? 'MONEY()' : dialectName === 'mssql' ? 'MONEY()' : undefined), py: 'decimal.Decimal' }
      case 'real':
        return { sql: g('REAL'), py: 'float' }
      case 'double':
        return { sql: my && type.name === 'float' ? g('Float') : g('Double'), py: 'float' }
      case 'boolean':
        return { sql: g('Boolean'), py: 'bool' }
      case 'char':
        return { sql: type.national && dialectName === 'mssql' ? variant(g('CHAR', n !== undefined ? String(n) : ''), `NCHAR(${n ?? ''})`) : g('CHAR', n !== undefined ? String(n) : ''), py: 'str' }
      case 'varchar':
        return { sql: type.national && (dialectName === 'mssql' || dialectName === 'oracle') ? g('Unicode', n !== undefined ? String(n) : '') : g('String', n !== undefined ? String(n) : my ? '255' : ''), py: 'str' }
      case 'text': {
        const mysqlText = my && ['tinytext', 'mediumtext', 'longtext'].includes(type.name) ? `${type.name.toUpperCase()}()` : undefined
        return { sql: variant(g(type.national ? 'UnicodeText' : 'Text'), mysqlText ?? (type.name === 'citext' && dialectName === 'postgresql' ? undefined : undefined)), py: 'str' }
      }
      case 'uuid':
        py.add('uuid')
        return { sql: g('Uuid'), py: 'uuid.UUID' }
      case 'date':
        py.add('datetime')
        return { sql: g('Date'), py: 'datetime.date' }
      case 'time':
      case 'timetz':
        py.add('datetime')
        return { sql: g('Time', type.family === 'timetz' ? 'timezone=True' : ''), py: 'datetime.time' }
      case 'timestamp':
        py.add('datetime')
        return { sql: variant(g('DateTime'), my && type.name === 'timestamp' ? `TIMESTAMP(${n ? `fsp=${n}` : ''})` : my && n ? `DATETIME(fsp=${n})` : dialectName === 'mssql' && type.name === 'datetime2' ? `DATETIME2(${n ?? ''})` : undefined), py: 'datetime.datetime' }
      case 'timestamptz':
        py.add('datetime')
        return { sql: variant(g('DateTime', 'timezone=True'), dialectName === 'mssql' ? `DATETIMEOFFSET(${n ?? ''})` : undefined), py: 'datetime.datetime' }
      case 'interval':
        py.add('datetime')
        return { sql: g('Interval'), py: 'datetime.timedelta' }
      case 'json':
        typing.add('Any')
        return { sql: g('JSON'), py: 'Any' }
      case 'jsonb':
        typing.add('Any')
        return { sql: variant(g('JSON'), dialectName === 'postgresql' ? 'JSONB()' : undefined), py: 'Any' }
      case 'binary':
        return { sql: variant(g('LargeBinary', type.name !== 'varbinary' && type.name !== 'binary' ? '' : n !== undefined ? String(n) : ''), my && ['tinyblob', 'mediumblob', 'longblob'].includes(type.name) ? `${type.name.toUpperCase()}()` : dialectName === 'postgresql' ? 'BYTEA()' : undefined), py: 'bytes' }
      case 'network':
        return { sql: variant(g('String', '50'), dialectName === 'postgresql' ? `${type.name.toUpperCase()}()` : undefined), py: 'str' }
      case 'set':
        return { sql: variant(g('String', '255'), my ? `SET(${(type.values ?? []).map((v) => pyString(v)).join(', ')})` : undefined), py: 'str' }
      case 'xml':
        return { sql: own(c.dataType.trim()), py: 'str' }
      default:
        typing.add('Any')
        return { sql: own(c.dataType.trim()), py: 'Any' }
    }
  }

  const className = namer(['Base', 'SqlType', 'Any', 'List', 'Optional', 'datetime', 'decimal', 'uuid', 'text', 'Mapped', 'Table', 'Column', 'Index', 'ForeignKey', 'ForeignKeyConstraint', 'UniqueConstraint', 'PrimaryKeyConstraint', 'Identity', 'MetaData', 'Enum', 'String', 'Integer', 'Text', 'Numeric', 'Boolean', 'Date', 'DateTime', 'Time', 'Uuid', 'JSON', 'Double', 'REAL', 'CHAR', 'SmallInteger', 'BigInteger', 'LargeBinary', 'Interval', 'Unicode', 'UnicodeText', ...PY_KEYWORDS])
  const out: string[] = []
  const ordered = referencedFirst(model)
  const fkTarget = (t: TableInfo, fk: ForeignKeyInfo) => {
    const target = model.target(t, fk)
    const schema = target ? model.schemaOf(target) : model.schemaOf({ schema: fk.refSchema ?? t.schema })
    return (column: string) => `${schema ? `${schema}.` : ''}${target?.name ?? fk.refTable}.${column}`
  }
  // (SQLite's foreign keys have no names: the ones the app shows are made up.)
  const fkName = (fk: ForeignKeyInfo) => !!fk.name && database !== 'sqlite'
  const action = (fk: ForeignKeyInfo) => [fk.onDelete && fk.onDelete !== 'NO ACTION' ? `ondelete=${pyString(fk.onDelete)}` : '', fk.onUpdate && fk.onUpdate !== 'NO ACTION' ? `onupdate=${pyString(fk.onUpdate)}` : ''].filter(Boolean)
  for (const t of ordered) {
    const schema = model.schemaOf(t)
    const pk = t.primaryKey.filter((c) => t.columns.some((x) => x.name === c))
    const attr = namer(['metadata', 'registry'])
    const tableArgs: string[] = []
    const singleFks = new Map(t.foreignKeys.filter((fk) => fk.columns.length === 1).map((fk) => [fk.columns[0]!, fk]))
    for (const fk of t.foreignKeys.filter((x) => x.columns.length > 1)) {
      sa.add('ForeignKeyConstraint')
      const to = fkTarget(t, fk)
      tableArgs.push(`ForeignKeyConstraint([${fk.columns.map((c) => pyString(c)).join(', ')}], [${fk.refColumns.map((c) => pyString(to(c))).join(', ')}]${[...action(fk), ...(fkName(fk) ? [`name=${pyString(fk.name)}`] : [])].map((a) => `, ${a}`).join('')})`)
    }
    const singleUnique = new Set<string>()
    const seen = new Set<string>()
    for (const ix of t.indexes) {
      if (ix.primary || !ix.columns.length || ix.columns.some((c) => !t.columns.some((x) => x.name === c))) continue
      if (ix.unique && sameSet(ix.columns, pk)) continue
      const sig = `${ix.unique}:${ix.columns.join('\u0000')}`
      if (seen.has(sig)) continue
      seen.add(sig)
      if (ix.unique && ix.constraint && ix.columns.length === 1 && !ix.name) {
        singleUnique.add(ix.columns[0]!)
        continue
      }
      if (ix.unique && ix.constraint) {
        sa.add('UniqueConstraint')
        tableArgs.push(`UniqueConstraint(${ix.columns.map((c) => pyString(c)).join(', ')}${ix.name ? `, name=${pyString(ix.name)}` : ''})`)
      } else {
        sa.add('Index')
        tableArgs.push(`Index(${pyString(ix.name || `ix_${t.name}_${ix.columns.join('_')}`)}, ${ix.columns.map((c) => pyString(c)).join(', ')}${ix.unique ? ', unique=True' : ''})`)
      }
    }
    const columnArgs = (c: ColumnInfo, mapped: boolean) => {
      const type = classifyType(c.dataType, database)
      const ty = typeOf(c, type)
      const args: string[] = []
      if (!mapped) args.push(pyString(c.name))
      args.push(ty.sql)
      const fk = singleFks.get(c.name)
      if (fk) {
        sa.add('ForeignKey')
        args.push(`ForeignKey(${[pyString(fkTarget(t, fk)(fk.refColumns[0]!)), ...action(fk), ...(fkName(fk) ? [`name=${pyString(fk.name)}`] : [])].join(', ')})`)
      }
      const d = defaultOf(c, type)
      if (d?.kind === 'autoincrement') {
        if (pk.length === 1 && pk[0] === c.name) args.push('autoincrement=True')
        else {
          sa.add('Identity')
          args.push('Identity()')
        }
      }
      if (pk.includes(c.name)) args.push('primary_key=True')
      else args.push(`nullable=${c.nullable ? 'True' : 'False'}`)
      if (singleUnique.has(c.name)) args.push('unique=True')
      if (d && d.kind !== 'autoincrement') {
        sa.add('text')
        const sql = d.kind === 'now' ? 'CURRENT_TIMESTAMP' : d.kind === 'number' ? d.value : d.kind === 'bool' ? (dialectName === 'postgresql' ? String(d.value) : d.value ? '1' : '0') : d.kind === 'string' ? `'${d.value.replaceAll("'", "''")}'` : d.sql
        args.push(`server_default=text(${pyString(sql)})`)
      }
      if (c.comment) args.push(`comment=${pyString(c.comment)}`)
      return { args, py: ty.py }
    }
    const docs = commentLines(t.comment, '', 'python')
    if (!pk.length) {
      // No primary key: the ORM can't map it, so it is a Table on the metadata (as sqlacodegen writes it).
      sa.add('Table')
      sa.add('Column')
      const name = className(`t_${identifier(t.name, { leading: 't' })}`)
      out.push(
        '',
        '',
        ...docs.map((l) => `# ${l}`),
        `${name} = Table(`,
        `    ${pyString(t.name)},`,
        '    Base.metadata,',
        ...t.columns.map((c) => `    Column(${columnArgs(c, false).args.join(', ')}),`),
        ...tableArgs.map((a) => `    ${a},`),
        ...(schema ? [`    schema=${pyString(schema)},`] : []),
        ...(t.comment ? [`    comment=${pyString(t.comment)},`] : []),
        ')',
      )
      continue
    }
    const name = className(pascal(model.schemaOf(t) && model.tables.some((o) => o !== t && o.name === t.name) ? `${schema}_${t.name}` : t.name))
    const lines = [`class ${name}(Base):`, ...(docs.length ? [`    ${docstring(t.comment)}`, ''] : []), `    __tablename__ = ${pyString(t.name)}`]
    const options = [...(schema ? [`"schema": ${pyString(schema)}`] : []), ...(t.comment ? [`"comment": ${pyString(t.comment)}`] : [])]
    if (tableArgs.length || options.length) {
      lines.push('    __table_args__ = (', ...tableArgs.map((a) => `        ${a},`), ...(options.length ? [`        {${options.join(', ')}},`] : []), '    )')
    }
    lines.push('')
    for (const c of t.columns) {
      const plain = /^[A-Za-z_][A-Za-z0-9_]*$/.test(c.name) && !c.name.startsWith('__')
      // (A Python keyword gets a trailing underscore, as sqlacodegen names it.)
      const key = attr(plain ? (PY_KEYWORDS.has(c.name) ? `${c.name}_` : c.name) : identifier(c.name, { leading: 'c' }))
      const { args, py: pyType } = columnArgs(c, key === c.name)
      const optional = c.nullable && !pk.includes(c.name)
      if (optional) typing.add('Optional')
      lines.push(`    ${key}: Mapped[${optional ? `Optional[${pyType}]` : pyType}] = mapped_column(${args.join(', ')})`)
    }
    out.push('', '', ...lines)
  }
  if (userType) typing.add('Any')
  const head = [`# ${HEADER}: SQLAlchemy 2.0 declarative models.`]
  if (typing.size) head.push(`from typing import ${[...typing].sort().join(', ')}`)
  for (const m of [...py].sort()) head.push(`import ${m}`)
  head.push('')
  if (userType) sa.add('types')
  head.push(`from sqlalchemy import ${[...sa].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })).join(', ')}`)
  if (dialectTypes.size && dialectName) head.push(`from sqlalchemy.dialects import ${dialectName}`)
  head.push(`from sqlalchemy.orm import ${[...orm].sort().join(', ')}`, '', '', 'class Base(DeclarativeBase):', '    pass')
  if (userType) {
    head.push(
      '',
      '',
      'class SqlType(types.UserDefinedType):',
      '    """A column type SQLAlchemy has no class for, written as the database spells it."""',
      '',
      '    cache_ok = True',
      '',
      '    def __init__(self, ddl: str) -> None:',
      '        self.ddl = ddl',
      '',
      '    def get_col_spec(self, **kw: Any) -> str:',
      '        return self.ddl',
    )
  }
  return `${[...head, ...out].join('\n')}\n`
}

// ---------------------------------------------------------------------------------------------------------------
// TypeScript

/** An interface per table: columns as they are named, `| null` where they may be empty, enums as unions of literals. */
export function toTypeScript(tables: TableInfo[], options: CodeOptions = {}): string {
  const model = modelOf(tables, options)
  const typeName = namer(['Date', 'Uint8Array', 'Record', 'Array', 'Json', 'JsonValue', 'string', 'number', 'boolean', 'unknown'])
  const enumTypes = new Map<string, string>()
  const out: string[] = [`// ${HEADER}: a row of each table as the database drivers return it.`, '', 'export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };']
  const literal = (values: string[]) => (values.length ? values.map(jsString).join(' | ') : 'string')
  for (const [name, values] of Object.entries(options.enums ?? {})) {
    const used = model.tables.some((t) => t.columns.some((c) => model.enumOf(c)?.name === name))
    if (!used) continue
    const ts = typeName(pascal(name))
    enumTypes.set(name, ts)
    out.push('', `export type ${ts} = ${literal(values)};`)
  }
  const tsOf = (c: ColumnInfo): string => {
    const type = classifyType(c.dataType, options.database ?? 'postgres')
    const named = model.enumOf(c)
    const base = (() => {
      if (named) return enumTypes.get(named.name) ?? literal(named.values)
      switch (type.family) {
        case 'smallint':
        case 'integer':
        case 'tinyint':
        case 'mediumint':
        case 'real':
        case 'double':
        case 'year':
          return 'number'
        // Larger than a JavaScript number holds exactly: the drivers give them as text.
        case 'bigint':
        case 'decimal':
        case 'money':
          return 'string'
        case 'boolean':
          return 'boolean'
        case 'date':
        case 'timestamp':
        case 'timestamptz':
          return 'Date'
        case 'json':
        case 'jsonb':
          return 'JsonValue'
        case 'binary':
          return 'Uint8Array'
        case 'enum':
        case 'set':
          return type.family === 'enum' ? literal(type.values ?? []) : 'string'
        case 'other':
          return 'unknown'
        default:
          return 'string'
      }
    })()
    const wrapped = type.array ? (/\|/.test(base) ? `(${base})[]` : `${base}[]`) : base
    return c.nullable && wrapped !== 'unknown' ? `${wrapped} | null` : wrapped
  }
  for (const t of model.tables) {
    const schema = model.schemaOf(t)
    const name = typeName(pascal(schema && model.tables.some((o) => o !== t && o.name === t.name) ? `${schema}_${t.name}` : t.name))
    out.push('', ...(t.comment ? ['/**', ...commentLines(t.comment, ' * ', 'js'), ' */'] : []), `export interface ${name} {`)
    for (const c of t.columns) {
      if (c.comment) out.push(`  /** ${commentText(c.comment, 'js')} */`)
      out.push(`  ${/^[A-Za-z_$][\w$]*$/.test(c.name) ? c.name : jsString(c.name)}: ${tsOf(c)};`)
    }
    out.push('}')
  }
  return `${out.join('\n')}\n`
}

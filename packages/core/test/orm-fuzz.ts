import type { CodeDatabase, CodeFormat, TableInfo } from '../src/index.js'

/**
 * Models whose every name, comment, default, enum value and type comes from a hostile alphabet: line terminators of
 * every language, quotes, comment openers and closers, template interpolation, NUL, bidirectional overrides,
 * confusables and very long strings. The generators must turn them into code that declares exactly the tables we
 * meant and nothing else (orm-export-safety.test.ts checks the structure, orm-export.tools.test.ts the real parsers).
 */
const HOSTILE = [
  '\r', '\n', '\r\n', '\u0085', '\u2028', '\u2029', '\\', '"', "'", '`', '${', '}', '{', '*/', '/*', '//', '#', '"""', "'''",
  '\u0000', '\u0007', '\u001b', '\u202e', '\u2066', '\ufeff', '(', ')', ';', '<', '>', '@', '@@', '=', ',', ' ', '\t',
  'é', 'Ａ', 'а', 'ı', 'ß', '𝔸', '0', '9', '_', '-', '.',
  'generator x {', 'provider = "touch PWNED"', '__import__("os").system("echo PWNED")', 'console.log("PWNED")', '`); process.exit(1); (`',
  'class', 'default', 'from', 'import', 'None', 'True', 'model', 'enum', 'String', 'Int', 'constructor', '__proto__', 'select',
]

/** A small deterministic generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TYPES: Partial<Record<CodeDatabase, string[]>> = {
  postgres: ['integer', 'bigint', 'text', 'varchar(20)', 'numeric(10,2)', 'boolean', 'timestamp', 'jsonb', 'uuid', 'bytea', 'integer[]', 'point', 'bit(1)'],
  mysql: ['int', 'bigint unsigned', 'varchar(20)', 'decimal(10,2) unsigned', 'tinyint(1)', 'bit(1)', 'datetime', 'json', 'blob', "enum('a','b')", 'geometry'],
  mssql: ['int', 'bigint', 'nvarchar(50)', 'decimal(18,4)', 'bit', 'datetime2', 'uniqueidentifier', 'varbinary(max)', 'geography'],
  sqlite: ['INTEGER', 'TEXT', 'REAL', 'NUMERIC', 'BLOB'],
}

export function fuzzModel(seed: number, database: CodeDatabase): { tables: TableInfo[]; enums: Record<string, string[]> } {
  const r = rng(seed)
  const pick = <T,>(list: T[]) => list[Math.floor(r() * list.length)]!
  const hostile = (max = 8) => {
    if (r() < 0.03) return pick(HOSTILE).repeat(400 + Math.floor(r() * 800))
    let s = ''
    for (let i = 0, n = 1 + Math.floor(r() * max); i < n; i++) s += r() < 0.5 ? pick(HOSTILE) : String.fromCharCode(97 + Math.floor(r() * 26))
    return s
  }
  const types = TYPES[database] ?? TYPES.postgres!
  const enumName = hostile(4)
  const enums = { [enumName]: Array.from({ length: 1 + Math.floor(r() * 4) }, () => hostile(4)) }
  const n = 2 + Math.floor(r() * 3)
  const tables: TableInfo[] = []
  // Names distinct as written (the generators tell apart names that sanitize alike).
  const used = new Set<string>()
  const unique = (s: string) => {
    let name = s
    for (let i = 2; used.has(name); i++) name = `${s}${i}`
    used.add(name)
    return name
  }
  for (let i = 0; i < n; i++) {
    const columnNames = new Set<string>()
    const columns = Array.from({ length: 2 + Math.floor(r() * 4) }, (_, k) => {
      let name = k === 0 ? 'id' : hostile(6)
      while (columnNames.has(name.toLowerCase()) || !name.trim()) name += 'x'
      columnNames.add(name.toLowerCase())
      const roll = r()
      const dataType = k === 0 ? types[0]! : roll < 0.1 ? enumName : roll < 0.15 ? hostile(3) : pick(types)
      const defaultValue = k === 0 ? null : r() < 0.3 ? `'${hostile(5)}'` : r() < 0.2 ? hostile(5) : r() < 0.1 ? '42' : null
      return { name, ordinal: k + 1, dataType, nullable: k !== 0 && r() < 0.5, defaultValue, isPrimaryKey: k === 0, isIdentity: k === 0 && r() < 0.5, comment: r() < 0.6 ? hostile(10) : null }
    })
    const name = unique(i === 0 && r() < 0.5 ? 'plain' : hostile(6) || `t${i}`)
    const keyless = r() < 0.15
    if (r() < 0.3) Object.assign(columns[0]!, { identityAlways: r() < 0.5 })
    tables.push({
      name,
      type: 'table',
      comment: r() < 0.7 ? hostile(12) : null,
      columns: keyless ? columns.map((c) => ({ ...c, isPrimaryKey: false })) : columns,
      primaryKey: keyless ? [] : ['id'],
      foreignKeys: [],
      indexes: [...(keyless ? [] : [{ name: hostile(5), columns: ['id'], unique: true, primary: true }]), ...(r() < 0.5 ? [{ name: hostile(6), columns: [columns[1]!.name], unique: r() < 0.5, primary: false, ...(r() < 0.5 ? { method: hostile(4) } : {}) }] : [])],
    })
  }
  // References with hostile names, to tables of the model and to one that isn't there.
  for (const t of tables.slice(1)) {
    const target = pick(tables)
    if (!target.primaryKey.length || r() < 0.2) continue
    const column = t.columns.find((c) => c.name !== 'id' && c.dataType === target.columns[0]!.dataType)
    // Every enum-like field gets hostile values too (review N6): actions, index methods, identity kinds.
    const action = () => (r() < 0.3 ? pick(['CASCADE', 'set null', 'Restrict', 'NO ACTION']) : r() < 0.6 ? pick(["CASCADE'),console.log('PWNED'),('", 'CASCADE"); __import__("os").system("echo PWNED"); ("', '`); process.exit(1); (`']) + hostile(3) : undefined)
    if (column) t.foreignKeys.push({ name: hostile(6), columns: [column.name], refTable: target.name, refColumns: ['id'], onDelete: action(), onUpdate: action() })
  }
  if (r() < 0.3) tables[0]!.foreignKeys.push({ name: hostile(4), columns: ['id'], refTable: hostile(6), refColumns: ['id'] })
  return { tables, enums }
}

export const FUZZ_DATABASES: Record<CodeFormat, CodeDatabase[]> = {
  prisma: ['postgres', 'cockroachdb', 'mysql', 'mssql', 'sqlite'],
  drizzle: ['postgres', 'mysql', 'sqlite'],
  sqlalchemy: ['postgres', 'mysql', 'mssql', 'sqlite'],
  typescript: ['postgres', 'mysql'],
}

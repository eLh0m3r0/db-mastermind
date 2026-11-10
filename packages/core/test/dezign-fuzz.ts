import type { TableInfo } from '../src/index.js'

/** Deterministic random numbers: a failing run can be repeated from its seed. */
export function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TYPES = ['int', 'bigint', 'varchar(40)', 'numeric(10,2)', 'date', 'text', 'character varying(120)', 'boolean']
const TEXTS = ['Poznámka: žluťoučký kůň', 'a < b & c > "d"', 'two\nlines', "it's", '']

/**
 * One random edit of the kind a person makes in the designer, keeping the model consistent (a dropped column
 * leaves its indexes and keys, a renamed table is followed by the keys that point at it). Returns its name.
 */
export function mutate(tables: TableInfo[], rnd: () => number, serial: number): string {
  const pick = <T>(list: T[]): T | undefined => list[Math.floor(rnd() * list.length)]
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const table = pick(tables)
  if (!table) return 'nothing'
  const referenced = (t: TableInfo, column: string) => tables.some((o) => o.foreignKeys.some((f) => same(f.refTable, t.name) && f.refColumns.some((c) => same(c, column))))
  const ops: Record<string, () => boolean> = {
    renameColumn() {
      const c = pick(table.columns)
      if (!c) return false
      const next = `fz_col_${serial}`
      const swap = (list: string[]) => list.map((x) => (same(x, c.name) ? next : x))
      table.primaryKey = swap(table.primaryKey)
      for (const ix of table.indexes) ix.columns = swap(ix.columns)
      for (const fk of table.foreignKeys) fk.columns = swap(fk.columns)
      for (const o of tables) for (const fk of o.foreignKeys) if (same(fk.refTable, table.name)) fk.refColumns = swap(fk.refColumns)
      c.name = next
      return true
    },
    addColumn() {
      table.columns.push({ name: `fz_new_${serial}`, ordinal: table.columns.length + 1, dataType: pick(TYPES)!, nullable: rnd() < 0.6, defaultValue: rnd() < 0.3 ? '0' : null, isPrimaryKey: false, isIdentity: false, comment: pick(TEXTS) || null })
      return true
    },
    dropColumn() {
      const c = pick(table.columns.filter((x) => !x.isPrimaryKey && !referenced(table, x.name)))
      if (!c || table.columns.length < 2) return false
      table.columns = table.columns.filter((x) => x !== c)
      table.indexes = table.indexes.map((ix) => ({ ...ix, columns: ix.columns.filter((x) => !same(x, c.name)) })).filter((ix) => ix.columns.length)
      table.foreignKeys = table.foreignKeys.filter((f) => !f.columns.some((x) => same(x, c.name)))
      table.checks = table.checks?.filter((k) => !new RegExp(`\\b${c.name}\\b`, 'i').test(k.expression))
      return true
    },
    retype() {
      const c = pick(table.columns.filter((x) => !x.isPrimaryKey && !referenced(table, x.name) && !table.foreignKeys.some((f) => f.columns.some((y) => same(y, x.name)))))
      if (!c) return false
      c.dataType = pick(TYPES.filter((t) => t !== c.dataType))!
      c.nullable = rnd() < 0.5
      c.defaultValue = rnd() < 0.3 ? "'x'" : null
      c.isIdentity = false
      // A type of its own: the column no longer follows a named type.
      c.domain = undefined
      return true
    },
    comment() {
      const c = pick(table.columns)
      if (rnd() < 0.5 || !c) table.comment = pick(TEXTS) || null
      else c.comment = pick(TEXTS) || null
      return true
    },
    addTable() {
      const parent = pick(tables.filter((t) => t.primaryKey.length === 1))
      const key = parent?.columns.find((c) => same(c.name, parent.primaryKey[0]!))
      const name = `fz_table_${serial}`
      tables.push({
        schema: table.schema,
        name,
        type: 'table',
        comment: pick(TEXTS) || null,
        columns: [
          { name: 'id', ordinal: 1, dataType: 'bigint', nullable: false, isPrimaryKey: true, isIdentity: false },
          { name: 'ref', ordinal: 2, dataType: key?.dataType ?? 'int', nullable: true, isPrimaryKey: false, isIdentity: false },
        ],
        primaryKey: ['id'],
        foreignKeys: parent && key ? [{ name: 'fk', columns: ['ref'], refSchema: parent.schema, refTable: parent.name, refColumns: [key.name], onDelete: pick(['CASCADE', 'SET NULL', undefined]) }] : [],
        indexes: rnd() < 0.5 ? [{ name: `ix_${name}`, columns: ['ref'], unique: false, primary: false }] : [],
      })
      return true
    },
    dropTable() {
      if (tables.length < 3) return false
      tables.splice(tables.indexOf(table), 1)
      for (const o of tables) o.foreignKeys = o.foreignKeys.filter((f) => !same(f.refTable, table.name))
      return true
    },
    renameTable() {
      const next = `fz_renamed_${serial}`
      for (const o of tables) for (const fk of o.foreignKeys) if (same(fk.refTable, table.name)) fk.refTable = next
      table.name = next
      return true
    },
    addIndex() {
      const cols = [...new Set([pick(table.columns), pick(table.columns)].filter((c) => !!c).map((c) => c!.name))]
      const unique = rnd() < 0.3
      if (!cols.length || table.indexes.some((ix) => ix.columns.join() === cols.join())) return false
      table.indexes.push({ name: `fz_ix_${serial}`, columns: cols, unique, primary: false })
      return true
    },
    dropIndex() {
      const ix = pick(table.indexes.filter((x) => !x.primary))
      if (!ix) return false
      table.indexes = table.indexes.filter((x) => x !== ix)
      return true
    },
    changeRule() {
      const fk = pick(table.foreignKeys.filter((f) => !f.virtual))
      if (!fk) return false
      fk.onDelete = pick(['CASCADE', 'RESTRICT', 'SET NULL', undefined].filter((r) => r !== fk.onDelete))
      return true
    },
    dropRelationship() {
      const fk = pick(table.foreignKeys.filter((f) => !f.virtual))
      if (!fk) return false
      table.foreignKeys = table.foreignKeys.filter((f) => f !== fk)
      return true
    },
    addCheck() {
      const c = pick(table.columns)
      if (!c) return false
      ;(table.checks ??= []).push({ expression: `${c.name} is not null or ${serial} > 0`, name: `fz_check_${serial}` })
      return true
    },
    dropCheck() {
      if (!table.checks?.length) return false
      table.checks = table.checks.slice(1)
      return true
    },
    reorder() {
      if (table.columns.length < 2) return false
      const i = Math.floor(rnd() * (table.columns.length - 1))
      ;[table.columns[i], table.columns[i + 1]] = [table.columns[i + 1]!, table.columns[i]!]
      return true
    },
  }
  const names = Object.keys(ops)
  for (let tries = 0; tries < 8; tries++) {
    const name = pick(names)!
    if (ops[name]!()) return name
  }
  return 'nothing'
}

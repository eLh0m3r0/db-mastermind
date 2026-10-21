import type { ForeignKeyInfo, SchemaSnapshot, TableInfo, TableRef } from './types.js'

export function findTable(snapshot: SchemaSnapshot, ref: TableRef): TableInfo | undefined {
  const name = ref.name
  const exact = snapshot.tables.find((t) => t.name === name && (ref.schema === undefined || t.schema === ref.schema))
  if (exact) return exact
  const lower = name.toLowerCase()
  const candidates = snapshot.tables.filter(
    (t) => t.name.toLowerCase() === lower && (ref.schema === undefined || t.schema?.toLowerCase() === ref.schema.toLowerCase()),
  )
  if (candidates.length <= 1) return candidates[0]
  return candidates.find((t) => t.schema === snapshot.defaultSchema) ?? candidates[0]
}

export function tableKey(ref: TableRef): string {
  return ref.schema ? `${ref.schema}.${ref.name}` : ref.name
}

export function sameTable(a: TableRef, b: TableRef): boolean {
  return a.name === b.name && (a.schema ?? '') === (b.schema ?? '')
}

export interface IncomingReference {
  /** Table that holds the foreign key. */
  table: TableInfo
  foreignKey: ForeignKeyInfo
}

/** Foreign keys in other tables that point at `target`. */
export function incomingReferences(snapshot: SchemaSnapshot, target: TableRef): IncomingReference[] {
  const out: IncomingReference[] = []
  for (const t of snapshot.tables) {
    for (const fk of t.foreignKeys) {
      if (fk.refTable === target.name && (fk.refSchema ?? t.schema) === (target.schema ?? t.schema)) {
        out.push({ table: t, foreignKey: fk })
      }
    }
  }
  return out
}

/** The table a foreign key points to. */
export function referencedTable(snapshot: SchemaSnapshot, from: TableInfo, fk: ForeignKeyInfo): TableInfo | undefined {
  return findTable(snapshot, { schema: fk.refSchema ?? from.schema, name: fk.refTable })
}

/** Displays schema-qualified names only when the table isn't in the default schema. */
export function displayName(snapshot: SchemaSnapshot | undefined, ref: TableRef): string {
  if (!ref.schema || ref.schema === snapshot?.defaultSchema) return ref.name
  return `${ref.schema}.${ref.name}`
}

import type { ColumnInfo, TableInfo } from './types.js'

export interface AttributePackage {
  name: string
  /** Its columns as the model's tables have them (in a table's order), keys and places left out. */
  columns: Omit<ColumnInfo, 'ordinal' | 'isPrimaryKey'>[]
  /** How many tables use it. */
  tables: number
}

/**
 * The attribute packages (DeZign) a model's columns come from (`ColumnInfo.package`). A project holds no
 * definition of them, only the columns they put into tables, so a package is read off the table that has most
 * of its columns.
 */
export function attributePackages(tables: TableInfo[]): AttributePackage[] {
  const found = new Map<string, AttributePackage>()
  for (const t of tables) {
    const byPackage = new Map<string, ColumnInfo[]>()
    for (const c of t.columns)
      if (c.package) byPackage.set(c.package, [...(byPackage.get(c.package) ?? []), c])
    for (const [name, columns] of byPackage) {
      const key = name.toLowerCase()
      const known = found.get(key)
      const mine = columns.map(({ ordinal: _o, isPrimaryKey: _k, ...c }) => c)
      if (!known) found.set(key, { name, columns: mine, tables: 1 })
      else {
        known.tables += 1
        if (mine.length > known.columns.length) known.columns = mine
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Columns of a package a table doesn't have yet (by name), to put at its end. */
export function packageColumnsFor(table: { columns: { name: string }[] }, pkg: AttributePackage) {
  const has = new Set(table.columns.map((c) => c.name.toLowerCase()))
  return pkg.columns.filter((c) => !has.has(c.name.toLowerCase()))
}

/**
 * Whether an edit of a column takes it out of its attribute package: the package decides the column's name and
 * definition (DeZign locks them), so changing any of those makes the column the table's own.
 */
export function leavesPackage<C extends { package?: string }>(old: C, patch: Partial<C>) {
  const keys = ['name', 'dataType', 'nullable', 'defaultValue', 'identity', 'domain'] as const
  const was = old as Record<string, unknown>
  const now = patch as Record<string, unknown>
  return !!old.package && !('package' in patch) && keys.some((k) => k in now && now[k] !== was[k])
}

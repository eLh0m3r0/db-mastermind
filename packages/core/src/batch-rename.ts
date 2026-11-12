import type { TableInfo } from './types.js'

export interface BatchRenameOptions {
  /** Text to find, or a regular expression (`regex`). */
  find: string
  replace: string
  regex?: boolean
  caseSensitive?: boolean
  /** What is renamed. */
  scope: 'tables' | 'columns' | 'both'
}

export interface BatchRename {
  kind: 'table' | 'column'
  /** The table (its name before the rename). */
  table: string
  schema?: string
  from: string
  to: string
  /** Left out: the new name is empty, invalid or taken. */
  skipped?: 'empty' | 'taken'
}

/**
 * A condition with its column names replaced (`to` gives the new name, or undefined to keep one). Columns are named
 * bare or in double quotes; text in single quotes, comments and function names stay as they are.
 */
export const renameInCondition = (text: string, to: (name: string) => string | undefined) =>
  text.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\/|"[^"]*"|[A-Za-z_][\w$]*(?!\s*\()/g, (w) => {
    if (w.startsWith("'") || w.startsWith('--') || w.startsWith('/*')) return w
    if (w.startsWith('"')) {
      const name = to(w.slice(1, -1))
      return name ? `"${name}"` : w
    }
    return to(w) ?? w
  })

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Renames tables and columns of a model by a pattern (DeZign's batch renaming tool): every match in a name is
 * replaced. Keys, indexes, relationships (both ends) and checks follow the new names; a new name that is empty or
 * would repeat another one in its table (or schema) is left out and reported as such.
 */
export function batchRename(
  tables: TableInfo[],
  options: BatchRenameOptions,
): { tables: TableInfo[]; renames: BatchRename[] } {
  if (!options.find) return { tables, renames: [] }
  let pattern: RegExp
  try {
    pattern = new RegExp(
      options.regex ? options.find : escape(options.find),
      options.caseSensitive ? 'g' : 'gi',
    )
  } catch {
    return { tables, renames: [] }
  }
  const rename = (name: string) => name.replace(pattern, options.replace)
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const renames: BatchRename[] = []

  // Tables first: a name taken by another table of the same schema (old or new) is left out.
  const tableTo = new Map<TableInfo, string>()
  if (options.scope !== 'columns') {
    const taken = new Set(tables.map((t) => `${(t.schema ?? '').toLowerCase()}.${t.name.toLowerCase()}`))
    for (const t of tables) {
      const to = rename(t.name).trim()
      if (to === t.name) continue
      const key = `${(t.schema ?? '').toLowerCase()}.${to.toLowerCase()}`
      const skipped = !to ? 'empty' : taken.has(key) && !same(to, t.name) ? 'taken' : undefined
      renames.push({
        kind: 'table',
        table: t.name,
        schema: t.schema,
        from: t.name,
        to,
        ...(skipped ? { skipped } : {}),
      })
      if (skipped) continue
      taken.delete(`${(t.schema ?? '').toLowerCase()}.${t.name.toLowerCase()}`)
      taken.add(key)
      tableTo.set(t, to)
    }
  }
  // Columns: unique within their table.
  const columnTo = new Map<TableInfo, Map<string, string>>()
  if (options.scope !== 'tables') {
    for (const t of tables) {
      const map = new Map<string, string>()
      const taken = new Set(t.columns.map((c) => c.name.toLowerCase()))
      for (const c of t.columns) {
        const to = rename(c.name).trim()
        if (to === c.name) continue
        const skipped = !to ? 'empty' : taken.has(to.toLowerCase()) && !same(to, c.name) ? 'taken' : undefined
        renames.push({
          kind: 'column',
          table: t.name,
          schema: t.schema,
          from: c.name,
          to,
          ...(skipped ? { skipped } : {}),
        })
        if (skipped) continue
        taken.delete(c.name.toLowerCase())
        taken.add(to.toLowerCase())
        map.set(c.name, to)
      }
      if (map.size) columnTo.set(t, map)
    }
  }
  if (!tableTo.size && !columnTo.size) return { tables, renames }

  const tableNamed = (name: string, schema: string | undefined, from: TableInfo) =>
    tables.find((t) => same(t.name, name) && (t.schema ?? '') === (schema ?? from.schema ?? '')) ??
    tables.find((t) => same(t.name, name))
  const col = (t: TableInfo | undefined, name: string) => (t && columnTo.get(t)?.get(name)) ?? name
  const words = (text: string, map: Map<string, string> | undefined) =>
    map ? renameInCondition(text, (n) => map.get(n)) : text

  const out = tables.map((t) => {
    const cols = columnTo.get(t)
    return {
      ...t,
      name: tableTo.get(t) ?? t.name,
      columns: t.columns.map((c) => (cols?.has(c.name) ? { ...c, name: cols.get(c.name)! } : c)),
      primaryKey: t.primaryKey.map((c) => col(t, c)),
      indexes: t.indexes.map((i) => ({ ...i, columns: i.columns.map((c) => col(t, c)) })),
      foreignKeys: t.foreignKeys.map((f) => {
        const target = tableNamed(f.refTable, f.refSchema, t)
        return {
          ...f,
          columns: f.columns.map((c) => col(t, c)),
          refTable: target ? (tableTo.get(target) ?? f.refTable) : f.refTable,
          refColumns: f.refColumns.map((c) => col(target, c)),
        }
      }),
      ...(t.checks
        ? {
            checks: t.checks.map((ch) => ({
              ...ch,
              expression: words(ch.expression, cols),
              ...(ch.column ? { column: col(t, ch.column) } : {}),
            })),
          }
        : {}),
    }
  })
  return { tables: out, renames }
}

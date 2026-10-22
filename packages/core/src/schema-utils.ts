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

export interface JoinStep {
  from: TableInfo
  to: TableInfo
  /** Column pairs `[fromColumn, toColumn]`. */
  on: [string, string][]
  /** The foreign key is declared in `to` (we walk it backwards). */
  reverse: boolean
  virtual?: boolean
}

/**
 * Shortest chain of foreign keys connecting two tables (in either direction), or null when they aren't connected
 * within `maxHops`. Ties prefer declared foreign keys over ones documented in the knowledge base.
 */
export function findJoinPath(snapshot: SchemaSnapshot, from: TableRef, to: TableRef, maxHops = 6): JoinStep[] | null {
  const start = findTable(snapshot, from)
  const goal = findTable(snapshot, to)
  if (!start || !goal) return null
  if (start === goal) return []
  const neighbours = (t: TableInfo): JoinStep[] => {
    const out: JoinStep[] = []
    for (const fk of t.foreignKeys) {
      const target = referencedTable(snapshot, t, fk)
      if (target) out.push({ from: t, to: target, on: fk.columns.map((c, i) => [c, fk.refColumns[i] ?? c]), reverse: false, virtual: fk.virtual })
    }
    for (const ref of incomingReferences(snapshot, t)) {
      const fk = ref.foreignKey
      out.push({ from: t, to: ref.table, on: fk.refColumns.map((c, i) => [c, fk.columns[i] ?? c]), reverse: true, virtual: fk.virtual })
    }
    return out.sort((a, b) => Number(!!a.virtual) - Number(!!b.virtual))
  }
  const via = new Map<TableInfo, JoinStep>()
  const seen = new Set<TableInfo>([start])
  let frontier = [start]
  for (let hop = 0; hop < maxHops && frontier.length; hop++) {
    const next: TableInfo[] = []
    for (const t of frontier) {
      for (const step of neighbours(t)) {
        if (seen.has(step.to)) continue
        seen.add(step.to)
        via.set(step.to, step)
        if (step.to === goal) {
          const path: JoinStep[] = []
          for (let cur: TableInfo = goal; cur !== start; cur = via.get(cur)!.from) path.unshift(via.get(cur)!)
          return path
        }
        next.push(step.to)
      }
    }
    frontier = next
  }
  return null
}

/** Short, unique aliases from table names: order_items → oi, orders → o, then o2… */
export function tableAliases(tables: TableInfo[]): Map<TableInfo, string> {
  const out = new Map<TableInfo, string>()
  const taken = new Set<string>()
  for (const t of tables) {
    if (out.has(t)) continue
    const base =
      t.name
        .split(/[_\s]+|(?<=[a-z])(?=[A-Z])/)
        .filter(Boolean)
        .map((w) => w[0]!.toLowerCase())
        .join('')
        .replace(/[^a-z]/g, '') || 't'
    let alias = base
    for (let i = 2; taken.has(alias); i++) alias = `${base}${i}`
    taken.add(alias)
    out.set(t, alias)
  }
  return out
}

const RESERVED = new Set(
  'all and as asc between by case check column default desc else end false from group in index is join key left like limit not null offset on or order primary references right select table then to true user when where'.split(' '),
)

/** `SELECT … FROM a JOIN b ON … JOIN c ON …` for a join path. */
export function joinPathSql(path: JoinStep[], quote: (s: string) => string, defaultSchema?: string): string {
  if (!path.length) return ''
  // Plain lower-case names read better unquoted; anything else keeps the dialect's quoting.
  const quoteIdent = (s: string) => (/^[a-z_][a-z0-9_]*$/.test(s) && !RESERVED.has(s) ? s : quote(s))
  const tables = [path[0]!.from, ...path.map((s) => s.to)]
  const aliases = tableAliases(tables)
  const name = (t: TableInfo) => (t.schema && t.schema !== defaultSchema ? `${quoteIdent(t.schema)}.${quoteIdent(t.name)}` : quoteIdent(t.name))
  const lines = [`SELECT *`, `FROM ${name(tables[0]!)} ${aliases.get(tables[0]!)}`]
  for (const step of path) {
    const a = aliases.get(step.from)!
    const b = aliases.get(step.to)!
    const on = step.on.map(([x, y]) => `${b}.${quoteIdent(y)} = ${a}.${quoteIdent(x)}`).join(' AND ')
    lines.push(`JOIN ${name(step.to)} ${b} ON ${on}`)
  }
  return lines.join('\n')
}

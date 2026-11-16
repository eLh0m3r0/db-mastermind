import { withDezignSql, type DezignSqlObject } from '@dbmastermind/core/browser'

export interface TableMove {
  from: { schema?: string; name: string }
  to: { schema?: string; name: string }
}

const key = (t: { schema?: string; name: string }) => `${t.schema ?? ''}.${t.name}`

/** Layout keys (`schema.table`) of renamed tables: old key → new key. */
export function movedKeys(moves: TableMove[]): Map<string, string> {
  return new Map(moves.filter((m) => key(m.from) !== key(m.to)).map((m) => [key(m.from), key(m.to)]))
}

interface Layout {
  positions?: Record<string, unknown>
  colors?: Record<string, unknown>
  display?: { hidden?: Record<string, unknown> }
  diagrams?: { tables: string[]; positions: Record<string, unknown>; colors?: Record<string, unknown>; display?: { hidden?: Record<string, unknown> } }[]
}

/**
 * A renamed table keeps its place, colour and what it shows on every diagram, and stays on the diagrams it was on.
 * Made together with the rename (the canvas lays out with the tab it is given: a later effect came one render late
 * and the table landed among the new ones).
 */
export function layoutAfterRenames<T extends Layout>(tab: T, moved: Map<string, string>): Pick<T, 'positions' | 'colors' | 'display' | 'diagrams'> {
  return rekeyLayout(tab, (k) => moved.get(k) ?? k)
}

/** Every table key of a layout (positions, colours, hidden columns, diagrams) passed through `to`. */
export function rekeyLayout<T extends Layout>(tab: T, to: (key: string) => string): Pick<T, 'positions' | 'colors' | 'display' | 'diagrams'> {
  const rekey = <V,>(map: Record<string, V> | undefined) => (map ? Object.fromEntries(Object.entries(map).map(([k, v]) => [to(k), v])) : map)
  const display = <D extends { hidden?: Record<string, unknown> } | undefined>(d: D): D => (d ? { ...d, hidden: rekey(d.hidden) } : d)
  return {
    positions: rekey(tab.positions),
    colors: rekey(tab.colors),
    display: display(tab.display),
    diagrams: tab.diagrams?.map((d) => ({ ...d, tables: [...new Set(d.tables.map(to))], positions: rekey(d.positions) ?? {}, colors: rekey(d.colors), display: display(d.display) })),
  } as Pick<T, 'positions' | 'colors' | 'display' | 'diagrams'>
}

/**
 * The layout as a .dbml file keeps it: a table written without a schema is keyed `.name`, not by the default schema
 * of whatever database was linked when it was saved (another connection, or none, would find nothing).
 * `implicit`: names of the tables the DBML text gives no schema.
 */
export function portableLayout<T extends Layout>(tab: T, implicit: Set<string>, defaultSchema: string | undefined): Pick<T, 'positions' | 'colors' | 'display' | 'diagrams'> {
  return rekeyLayout(tab, (k) => {
    const dot = k.indexOf('.')
    const name = k.slice(dot + 1)
    return dot > 0 && k.slice(0, dot) === (defaultSchema ?? '') && implicit.has(name) ? `.${name}` : k
  })
}

/** A .dbml file's layout keyed as the model is read now: `.name` lands in the linked database's default schema. */
export function localLayout<T extends Layout>(tab: T, defaultSchema: string | undefined): Pick<T, 'positions' | 'colors' | 'display' | 'diagrams'> {
  return rekeyLayout(tab, (k) => (k.startsWith('.') && defaultSchema ? `${defaultSchema}${k}` : k))
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Triggers follow their renamed table: `table` names the new one and the SQL is made again from the trigger's code
 * (DeZign's `%table%` placeholders); a trigger without code gets the table's name after its ON replaced.
 */
export function sqlObjectsAfterRenames(objects: DezignSqlObject[] | undefined, moves: TableMove[]): DezignSqlObject[] | undefined {
  if (!objects?.length || !moves.length) return objects
  let touched = false
  const out = objects.map((o) => {
    if (o.kind !== 'trigger' || !o.table) return o
    const move = moves.find((m) => m.from.name === o.table && (!o.schema || !m.from.schema || o.schema === m.from.schema))
    if (!move || (move.to.name === move.from.name && (move.to.schema ?? '') === (move.from.schema ?? ''))) return o
    touched = true
    const schema = o.schema && move.to.schema ? move.to.schema : o.schema
    if (o.code !== undefined) return withDezignSql({ ...o, table: move.to.name, schema })
    const from = `(?:${o.schema ? `"?${escape(o.schema)}"?\\.` : ''})?"?${escape(move.from.name)}"?`
    const to = `${schema ? `${schema}.` : ''}${move.to.name}`
    return { ...o, table: move.to.name, schema, sql: o.sql.replace(new RegExp(`(\\bON\\s+)${from}(?![\\w"])`, 'i'), `$1${to}`) }
  })
  return touched ? out : objects
}

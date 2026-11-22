import { layoutKey, type ImportedModel } from './imported-model.js'
import type { ImportedConnection } from './connection-imports.js'
import type { TableInfo } from './types.js'

/**
 * Files from strangers: a model somebody mailed, a repository cloned from the internet. Every reader of another
 * tool's model and of a project's connection files goes through these limits, and what it hands on (names, notes,
 * connection settings) is cleaned the way agents' connection proposals are (connection-proposal.ts).
 */
export const FILE_LIMITS = {
  /** A drawDB diagram, a Mermaid or a Prisma file. */
  model: 32 * 1024 * 1024,
  /** A MySQL Workbench model (a zip) as it is on disk. */
  mwb: 64 * 1024 * 1024,
  /** Its document.mwb.xml once inflated (checked while inflating: a header may lie). */
  mwbDocument: 128 * 1024 * 1024,
  /** A DeZign for Databases file (one file of a project, or a whole .dez): only to refuse what never ends. */
  dezign: 512 * 1024 * 1024,
  /** A project's .env, compose or Prisma file. */
  project: 1024 * 1024,
  /** Nesting of XML and JSON a model may have (Workbench's own documents nest about 15 deep). */
  depth: 256,
}

export const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`

/** Refuses what is larger than `limit`, saying the limit. */
export function checkSize(name: string, size: number, limit: number, what: string): void {
  if (size > limit) throw new Error(`${name} is larger than ${megabytes(limit)}: not ${what} this app opens`)
}

// C0 and C1 controls, DEL, and the bidirectional overrides that make a name read differently from what it is.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g
const CONTROL_KEEP_LINES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g

/** A name for the UI, a connection or a table: one line, no control characters, at most `max` characters. */
export function cleanName(value: string, max = 128): string {
  return value.replace(CONTROL, '').trim().slice(0, max)
}

/** A note or a comment: lines kept, other control characters gone, at most `max` characters. */
export function cleanText(value: string, max = 10_000): string {
  return value.replace(/\r\n?/g, '\n').replace(CONTROL_KEEP_LINES, '').slice(0, max)
}

const at = (n: number) => (Number.isFinite(n) ? Math.max(-1e7, Math.min(1e7, Math.round(n))) : 0)
const names = (list: string[]) => list.map((n) => cleanName(n))

function cleanTable(t: TableInfo): TableInfo {
  return {
    ...t,
    ...(t.schema !== undefined ? { schema: cleanName(t.schema) } : {}),
    name: cleanName(t.name),
    comment: t.comment ? cleanText(t.comment) : t.comment,
    columns: t.columns.map((c) => ({ ...c, name: cleanName(c.name), dataType: cleanName(c.dataType, 200), comment: c.comment ? cleanText(c.comment) : c.comment, defaultValue: c.defaultValue ? cleanText(c.defaultValue, 1000).replace(/\n/g, ' ') : c.defaultValue })),
    primaryKey: names(t.primaryKey),
    indexes: t.indexes.map((i) => ({ ...i, name: cleanName(i.name), columns: names(i.columns), ...(i.definition ? { definition: cleanText(i.definition, 2000).replace(/\n/g, ' ') } : {}) })),
    foreignKeys: t.foreignKeys.map((f) => ({ ...f, name: cleanName(f.name), columns: names(f.columns), refTable: cleanName(f.refTable), ...(f.refSchema !== undefined ? { refSchema: cleanName(f.refSchema) } : {}), refColumns: names(f.refColumns) })),
    ...(t.checks ? { checks: t.checks.map((c) => ({ ...c, expression: cleanText(c.expression, 2000).replace(/\n/g, ' '), ...(c.name ? { name: cleanName(c.name) } : {}) })) } : {}),
  }
}

/**
 * A name not yet taken, as written (email and Email are two names, as in DBML and case-sensitive databases):
 * itself, or itself with `_2`, `_3` … (cut to stay within `max`).
 */
function untaken(name: string, taken: Set<string>, max = 128): string {
  let out = name
  for (let n = 2; taken.has(out); n++) out = `${name.slice(0, max - String(n).length - 1)}_${n}`
  taken.add(out)
  return out
}

/**
 * Another tool's model with its names and texts cleaned and its coordinates bounded. Cleaning (control characters
 * out, 128 characters at most) can make two names one: those get a number (`_2`), references follow them, and
 * the import's notice counts them (`leftOut.renamed`).
 */
export function cleanImportedModel(m: ImportedModel): ImportedModel {
  const point = (p: { x: number; y: number }) => ({ x: at(p.x), y: at(p.y) })
  let renamed = 0
  const tables = m.tables.map(cleanTable)
  // Tables, per schema.
  const takenTables = new Map<string, Set<string>>()
  const tableOf = (raw: TableInfo) => raw
  const finalName = new Map<TableInfo, string>()
  tables.forEach((t, i) => {
    const taken = takenTables.get((t.schema ?? '').toLowerCase()) ?? new Set<string>()
    takenTables.set((t.schema ?? '').toLowerCase(), taken)
    const name = untaken(t.name, taken)
    if (name !== t.name) renamed++
    t.name = name
    finalName.set(tableOf(m.tables[i]!), name)
  })
  // Columns, per table; what names them follows.
  const columnMaps = tables.map((t, i) => {
    const taken = new Set<string>()
    const map = new Map<string, string>()
    t.columns = t.columns.map((c, k) => {
      const name = untaken(c.name, taken)
      if (name !== c.name) renamed++
      map.set(m.tables[i]!.columns[k]!.name, name)
      return { ...c, name }
    })
    return map
  })
  const targetOf = (i: number, refTable: string, refSchema: string | undefined) => {
    const raw = m.tables[i]!
    const candidates = m.tables.map((x, k) => [x, k] as const).filter(([x]) => x.name === refTable)
    return (candidates.find(([x]) => (x.schema ?? '') === (refSchema ?? raw.schema ?? '')) ?? (candidates.length === 1 ? candidates[0] : undefined))?.[1]
  }
  tables.forEach((t, i) => {
    const raw = m.tables[i]!
    const col = (map: Map<string, string>) => (name: string) => map.get(name) ?? cleanName(name)
    const own = col(columnMaps[i]!)
    t.primaryKey = raw.primaryKey.map(own)
    t.indexes = t.indexes.map((ix, k) => ({ ...ix, columns: raw.indexes[k]!.columns.map(own) }))
    t.foreignKeys = t.foreignKeys.map((fk, k) => {
      const rawFk = raw.foreignKeys[k]!
      const target = targetOf(i, rawFk.refTable, rawFk.refSchema)
      return { ...fk, columns: rawFk.columns.map(own), ...(target !== undefined ? { refTable: tables[target]!.name, refColumns: rawFk.refColumns.map(col(columnMaps[target]!)) } : {}) }
    })
    if (t.checks) t.checks = t.checks.map((c, k) => (raw.checks![k]!.column ? { ...c, column: own(raw.checks![k]!.column!) } : c))
  })
  // Layout keys follow the tables they name.
  const keys = new Map(m.tables.map((raw, i) => [layoutKey(raw), layoutKey(tables[i]!)]))
  const key = (k: string) => keys.get(k) ?? cleanName(k, 300)
  const keyed = <T,>(map: Record<string, T>, f: (v: T) => T) => Object.fromEntries(Object.entries(map).map(([k, v]) => [key(k), f(v)]))
  return {
    ...m,
    tables,
    enums: Object.fromEntries(Object.entries(m.enums).map(([name, values]) => [cleanName(name), values.map((v) => cleanName(v))])),
    positions: keyed(m.positions, point),
    colors: keyed(m.colors, (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#ffffff')),
    notes: m.notes.map((n) => ({ id: cleanName(n.id), text: cleanText(n.text), ...point(n) })),
    boxes: m.boxes.map((b) => ({ id: cleanName(b.id), title: cleanName(b.title, 200), ...point(b), w: Math.max(0, at(b.w)), h: Math.max(0, at(b.h)) })),
    diagrams: m.diagrams.map((d) => ({ ...d, id: cleanName(d.id), name: cleanName(d.name, 200), tables: d.tables.map(key), positions: keyed(d.positions, point), colors: keyed(d.colors, (c) => c) })),
    leftOut: renamed ? { ...m.leftOut, renamed: (m.leftOut.renamed ?? 0) + renamed } : m.leftOut,
  }
}

/** A connection a project's file describes, as an agent's proposal is checked: names and settings on one line, bounded. */
export function cleanConnection(c: ImportedConnection): ImportedConnection {
  const field = (v: string | undefined, max: number) => (v === undefined ? undefined : cleanName(v, max) || undefined)
  return {
    ...c,
    name: cleanName(c.name, 100),
    ...(c.host !== undefined ? { host: field(c.host, 255) } : {}),
    ...(c.database !== undefined ? { database: field(c.database, 255) } : {}),
    ...(c.user !== undefined ? { user: field(c.user, 255) } : {}),
    ...(c.filePath !== undefined ? { filePath: field(c.filePath, 1000) } : {}),
    // A password is taken as written (it may hold any character), only bounded.
    ...(c.password !== undefined ? { password: c.password.slice(0, 4096) } : {}),
    ...(c.port !== undefined ? { port: Number.isInteger(c.port) && c.port > 0 && c.port < 65536 ? c.port : undefined } : {}),
  }
}

import type { ImportedModel } from './imported-model.js'
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
const CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g
const CONTROL_KEEP_LINES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/g

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

/** Another tool's model with its names and texts cleaned and its coordinates bounded. */
export function cleanImportedModel(m: ImportedModel): ImportedModel {
  const point = (p: { x: number; y: number }) => ({ x: at(p.x), y: at(p.y) })
  const keyed = <T,>(map: Record<string, T>, f: (v: T) => T) => Object.fromEntries(Object.entries(map).map(([k, v]) => [cleanName(k, 300), f(v)]))
  return {
    ...m,
    tables: m.tables.map(cleanTable),
    enums: Object.fromEntries(Object.entries(m.enums).map(([name, values]) => [cleanName(name), values.map((v) => cleanName(v))])),
    positions: keyed(m.positions, point),
    colors: keyed(m.colors, (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#ffffff')),
    notes: m.notes.map((n) => ({ id: cleanName(n.id), text: cleanText(n.text), ...point(n) })),
    boxes: m.boxes.map((b) => ({ id: cleanName(b.id), title: cleanName(b.title, 200), ...point(b), w: Math.max(0, at(b.w)), h: Math.max(0, at(b.h)) })),
    diagrams: m.diagrams.map((d) => ({ ...d, id: cleanName(d.id), name: cleanName(d.name, 200), tables: d.tables.map((k) => cleanName(k, 300)), positions: keyed(d.positions, point), colors: keyed(d.colors, (c) => c) })),
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

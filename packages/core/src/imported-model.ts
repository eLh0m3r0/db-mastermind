import type { DriverId, TableInfo } from './types.js'

/**
 * Models made with other tools, read into the app's own model: MySQL Workbench (.mwb), drawDB (JSON export, .ddb),
 * Mermaid ER diagrams (.mmd, .mermaid, or a Markdown fence) and Prisma schemas. Each reader returns the tables with
 * what the diagram showed (positions, colors, notes, frames) and counts of what the model can't hold.
 */
export type ModelFormat = 'mwb' | 'drawdb' | 'mermaid' | 'prisma'

export interface ImportedModel {
  format: ModelFormat
  tables: TableInfo[]
  /** Named enum types, for the model's `Enum` blocks. */
  enums: Record<string, string[]>
  /** The database the model was drawn for, where the file says. */
  database?: DriverId
  /** Table positions on the diagram, keyed `schema.table` (`.table` without a schema). */
  positions: Record<string, { x: number; y: number }>
  /** Table fill colors (`#rrggbb`) by the same keys. */
  colors: Record<string, string>
  notes: { id: string; text: string; x: number; y: number }[]
  /** Frames drawn around tables (drawDB's subject areas, Workbench's layers). */
  boxes: { id: string; title: string; x: number; y: number; w: number; h: number }[]
  /** The file's other diagrams: which tables each shows and where. */
  diagrams: { id: string; name: string; tables: string[]; positions: Record<string, { x: number; y: number }>; colors: Record<string, string> }[]
  /** What could not be taken, by kind, with how many of each. */
  leftOut: Partial<Record<LeftOutKind, number>>
}

export type LeftOutKind =
  /** Views, routines (procedures, functions) and triggers: the model holds tables. */
  | 'views'
  | 'routines'
  | 'triggers'
  /** Mermaid many-to-many relationships: no foreign key says them. */
  | 'manyToMany'
  /** Relationships whose tables or columns are not in the file. */
  | 'brokenRelationships'
  /** Mermaid relationships to an entity without a primary key: no columns to point at. */
  | 'relationshipsWithoutKey'
  /** Prisma scalar lists (kept as text). */
  | 'scalarLists'
  /** drawDB's composite types (columns typed with one keep the type's name). */
  | 'customTypes'
  /** Defaults, checks and types that aren't plain SQL (kept as a note on the column, never run). */
  | 'defaults'
  | 'checks'
  | 'types'
  /** Indexes with a part that is neither a column nor a plain expression. */
  | 'indexes'
  /** Referential actions that aren't one (CASCADE, RESTRICT, SET NULL, SET DEFAULT, NO ACTION). */
  | 'actions'
  /** Names that cleaning (control characters out, 128 characters at most) made alike: given a number. */
  | 'renamed'

/**
 * What a file said that isn't taken as SQL (foreign-sql.ts): a line of the column's comment says it, and it is
 * counted as left out.
 */
export function leaveOut(model: ImportedModel, column: { comment?: string | null }, kind: 'defaults' | 'checks' | 'types' | 'indexes' | 'actions', tool: string, text: string): void {
  const what = { defaults: 'default', checks: 'check', types: 'type', indexes: 'index', actions: 'referential action' }[kind]
  const line = `${tool} ${what} (not taken): ${text.replace(/\s+/g, ' ').trim().slice(0, 500)}`
  column.comment = column.comment ? `${column.comment}\n${line}` : line
  model.leftOut[kind] = (model.leftOut[kind] ?? 0) + 1
}

export const emptyImport = (format: ModelFormat): ImportedModel => ({ format, tables: [], enums: {}, positions: {}, colors: {}, notes: [], boxes: [], diagrams: [], leftOut: {} })

/** The key a model tab keeps a table's layout under. */
export const layoutKey = (t: { schema?: string; name: string }) => `${t.schema ?? ''}.${t.name}`

/** Size of a table on the app's diagram (DiagramView): another tool's layout is spread so its tables don't overlap. */
const NODE = { width: 240, header: 32, row: 22 }

/**
 * Positions from another tool's figures, moved to start at 0,0 and spread by how much larger the app draws a table
 * than the tool did (at most three times), as DeZign layouts are (dezign.ts).
 */
export function spreadLayout(figures: { key: string; x: number; y: number; w?: number; h?: number; columns: number }[]): { positions: Record<string, { x: number; y: number }>; place: (x: number, y: number) => { x: number; y: number }; scale: { x: number; y: number } } {
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 1
  const widths = figures.filter((f) => f.w && f.w > 0).map((f) => NODE.width / f.w!)
  const heights = figures.filter((f) => f.h && f.h > 0).map((f) => (NODE.header + NODE.row * f.columns) / f.h!)
  const sx = widths.length ? Math.min(3, Math.max(1, median(widths))) : 1
  const sy = heights.length ? Math.min(3, Math.max(1, median(heights))) : 1
  const minX = figures.length ? Math.min(...figures.map((f) => f.x)) : 0
  const minY = figures.length ? Math.min(...figures.map((f) => f.y)) : 0
  const place = (x: number, y: number) => ({ x: Math.round((x - minX) * sx), y: Math.round((y - minY) * sy) })
  return { positions: Object.fromEntries(figures.map((f) => [f.key, place(f.x, f.y)])), place, scale: { x: sx, y: sy } }
}

import type { CheckInfo, ColumnInfo, DriverId, ForeignKeyInfo, IndexInfo, TableInfo } from './types.js'
import { classifyType } from './type-map.js'
import { emptyImport, layoutKey, leaveOut, type ImportedModel } from './imported-model.js'
import { isPlainCheck, isPlainType, plainDefault } from './foreign-sql.js'

/**
 * drawDB diagrams (drawdb.app): its JSON export and its `.ddb` save files, the same JSON with a title and an author.
 * Tables with fields, indices and unique constraints, relationships between fields (one pair, or several in newer
 * versions) with their actions, enums, notes and subject areas. Ids are numbers in older files and strings in newer
 * ones. The relationship's start table holds the foreign key (drawDB's own SQL export says so).
 */

type Id = string | number
interface DrawDbField {
  id: Id
  name: string
  type: string
  default?: string | number | boolean
  check?: string
  primary?: boolean
  unique?: boolean
  notNull?: boolean
  increment?: boolean
  comment?: string
  size?: string | number
  values?: string[]
  isArray?: boolean
}
interface DrawDbTable {
  id: Id
  name: string
  x: number
  y: number
  fields: DrawDbField[]
  comment?: string
  indices?: { name: string; unique?: boolean; fields: Id[] }[]
  uniqueConstraints?: { name: string; fields: string[] }[]
  color?: string
}
interface DrawDbRelationship {
  id?: Id
  name?: string
  startTableId: Id
  startFieldId: Id
  endTableId: Id
  endFieldId: Id
  fields?: { startFieldId: Id; endFieldId: Id }[]
  cardinality?: string
  updateConstraint?: string
  deleteConstraint?: string
}
interface DrawDbDiagram {
  tables: DrawDbTable[]
  relationships: DrawDbRelationship[]
  /** Older files call them references. */
  references?: DrawDbRelationship[]
  notes?: { id: Id; x: number; y: number; title?: string; content?: string }[]
  subjectAreas?: { id: Id; name: string; x: number; y: number; width: number; height: number }[]
  areas?: DrawDbDiagram['subjectAreas']
  types?: { name: string }[]
  enums?: { name: string; values: string[] }[]
  views?: unknown[]
  database?: string
}

const DATABASES: Record<string, DriverId> = { postgresql: 'postgres', mysql: 'mysql', mariadb: 'mariadb', transactsql: 'mssql', sqlite: 'sqlite', oraclesql: 'oracle' }

function parse(text: string): DrawDbDiagram | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const d = value as Partial<DrawDbDiagram>
  const relationships = d.relationships ?? d.references
  if (!Array.isArray(d.tables) || !Array.isArray(relationships)) return undefined
  if (!d.tables.every((t) => t && typeof t === 'object' && Array.isArray((t as DrawDbTable).fields) && typeof (t as DrawDbTable).name === 'string')) return undefined
  // Fields as drawDB writes them: a name and a type that are text (anything else in a stranger's file is left out).
  const tables = (d.tables as DrawDbTable[]).map((t) => ({ ...t, fields: t.fields.filter((f) => f && typeof f === 'object' && typeof f.name === 'string' && typeof f.type === 'string' && (typeof f.id === 'string' || typeof f.id === 'number')), indices: Array.isArray(t.indices) ? t.indices.filter((i) => i && Array.isArray(i.fields)) : [] }))
  const list = <T,>(v: unknown) => (Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as T[]) : [])
  return {
    ...(d as DrawDbDiagram),
    tables,
    relationships: list<DrawDbRelationship>(relationships),
    notes: list(d.notes),
    subjectAreas: list(d.subjectAreas ?? d.areas),
    enums: list<{ name: string; values: string[] }>(d.enums).filter((e) => typeof e.name === 'string' && Array.isArray(e.values)).map((e) => ({ ...e, values: e.values.map(String) })),
    types: list<{ name: string }>(d.types).filter((t) => typeof t.name === 'string'),
    views: list(d.views),
  }
}

/** A JSON text that is a drawDB diagram (any other JSON is data to query). */
export function isDrawDb(text: string): boolean {
  return !!parse(text)
}

/** A field's default as SQL: drawDB keeps the text as typed and quotes it on export unless it is a number, a keyword or a call. */
function defaultSql(f: DrawDbField, dataType: string): string | null | undefined {
  const d = f.default
  if (d === undefined || d === null || (typeof d === 'string' && !d.trim())) return null
  if (typeof d === 'number') return Number.isFinite(d) ? String(d) : undefined
  if (typeof d === 'boolean') return d ? 'true' : 'false'
  if (typeof d !== 'string') return undefined
  const v = d.trim()
  if (/^null$/i.test(v)) return null
  // Quoted or a call: SQL as typed, taken only when it is a plain value or a known function (foreign-sql.ts).
  if (/^'.*'$/s.test(v) || /^\w+\s*\(.*\)$/s.test(v) || /^\(.*\)$/s.test(v) || /^(current_timestamp|current_date|current_time|localtimestamp|localtime|true|false)$/i.test(v)) return plainDefault(v)
  const family = classifyType(dataType).family
  if (['smallint', 'integer', 'bigint', 'tinyint', 'mediumint', 'decimal', 'money', 'real', 'double', 'boolean', 'year', 'bit'].includes(family) && /^[-+]?\d+(\.\d+)?$|^(true|false)$/i.test(v)) return v
  // (A backslash would end MySQL's string early: such text is no default here.)
  return v.includes('\\') ? undefined : `'${v.replaceAll("'", "''")}'`
}

export function tablesFromDrawDb(text: string): ImportedModel {
  const d = parse(text)
  if (!d) throw new Error('Not a drawDB diagram: a drawDB export has tables and relationships')
  const out: ImportedModel = { ...emptyImport('drawdb'), database: DATABASES[d.database ?? ''] }
  const enums = new Map((d.enums ?? []).map((e) => [e.name.toLowerCase(), e]))
  for (const e of d.enums ?? []) out.enums[e.name] = [...e.values]
  const types = new Set((d.types ?? []).map((t) => t.name.toLowerCase()))
  if (types.size) out.leftOut.customTypes = types.size
  if (d.views?.length) out.leftOut.views = d.views.length

  const byId = new Map<string, { source: DrawDbTable; table: TableInfo }>()
  const key = (id: Id) => String(id)
  for (const t of d.tables) {
    const columns: ColumnInfo[] = []
    const checks: CheckInfo[] = []
    const indexes: IndexInfo[] = []
    for (const [i, f] of t.fields.entries()) {
      const named = enums.get(f.type.toLowerCase())
      const base = named ? named.name : /^(enum|set)$/i.test(f.type) && f.values?.length ? `${f.type.toLowerCase()}(${f.values.map((v) => `'${v.replaceAll("'", "''")}'`).join(',')})` : f.type.toLowerCase()
      const sized = f.size !== undefined && f.size !== '' && !named && !/\(/.test(base) ? `${base}(${String(f.size).replace(/\s+/g, '')})` : base
      const typed = `${sized}${f.isArray ? '[]' : ''}`
      const dataType = isPlainType(typed) ? typed : 'text'
      const defaultValue = defaultSql(f, dataType)
      const column: ColumnInfo = { name: f.name, ordinal: i + 1, dataType, nullable: !(f.notNull || f.primary), defaultValue: defaultValue ?? null, isPrimaryKey: !!f.primary, isIdentity: !!f.increment, comment: typeof f.comment === 'string' ? f.comment.trim() || null : null }
      columns.push(column)
      if (dataType !== typed) leaveOut(out, column, 'types', 'drawDB', typed)
      if (defaultValue === undefined) leaveOut(out, column, 'defaults', 'drawDB', String(f.default))
      const check = typeof f.check === 'string' ? f.check.trim() : ''
      if (check && isPlainCheck(check)) checks.push({ expression: check, column: f.name })
      else if (check) leaveOut(out, column, 'checks', 'drawDB', check)
      if (f.unique && !f.primary) indexes.push({ name: `${t.name}_${f.name}_key`, columns: [f.name], unique: true, primary: false, constraint: true })
    }
    const fieldName = (id: Id) => t.fields.find((f) => key(f.id) === key(id))?.name ?? (typeof id === 'string' ? id : undefined)
    for (const ix of t.indices ?? []) {
      // Older files name the fields; newer ones may give their ids.
      const cols = ix.fields.map((f) => (t.fields.some((x) => x.name === f) ? String(f) : fieldName(f))).filter((c): c is string => !!c)
      if (cols.length) indexes.push({ name: ix.name || `${t.name}_${cols.join('_')}_idx`, columns: cols, unique: !!ix.unique, primary: false })
    }
    for (const u of t.uniqueConstraints ?? []) if (u.fields.length) indexes.push({ name: u.name, columns: [...u.fields], unique: true, primary: false, constraint: true })
    const primaryKey = t.fields.filter((f) => f.primary).map((f) => f.name)
    const table: TableInfo = { name: t.name, type: 'table', comment: t.comment?.trim() || null, columns, primaryKey, foreignKeys: [], indexes: primaryKey.length ? [{ name: `${t.name}_pkey`, columns: primaryKey, unique: true, primary: true }, ...indexes] : indexes, ...(checks.length ? { checks } : {}) }
    byId.set(key(t.id), { source: t, table })
  }

  const ACTIONS: Record<string, string> = { cascade: 'CASCADE', restrict: 'RESTRICT', 'set null': 'SET NULL', 'set default': 'SET DEFAULT', 'no action': 'NO ACTION' }
  for (const r of d.relationships) {
    const from = byId.get(key(r.startTableId))
    const to = byId.get(key(r.endTableId))
    const pairs = r.fields?.length ? r.fields : [{ startFieldId: r.startFieldId, endFieldId: r.endFieldId }]
    const columns = pairs.map((p) => from?.source.fields.find((f) => key(f.id) === key(p.startFieldId))?.name)
    const refColumns = pairs.map((p) => to?.source.fields.find((f) => key(f.id) === key(p.endFieldId))?.name)
    if (!from || !to || columns.some((c) => !c) || refColumns.some((c) => !c)) {
      out.leftOut.brokenRelationships = (out.leftOut.brokenRelationships ?? 0) + 1
      continue
    }
    const action = (a: string | undefined) => {
      const v = ACTIONS[(a ?? '').trim().toLowerCase()]
      return v === 'NO ACTION' ? undefined : v
    }
    const fk: ForeignKeyInfo = { name: r.name?.trim() || `${from.table.name}_${columns.join('_')}_fkey`, columns: columns as string[], refTable: to.table.name, refColumns: refColumns as string[], onDelete: action(r.deleteConstraint), onUpdate: action(r.updateConstraint) }
    // (Older files keep the translated label: "One to one".)
    if (/^one[\s_-]*to[\s_-]*one$/i.test((r.cardinality ?? '').trim())) fk.cardinality = 'zero-or-one'
    from.table.foreignKeys.push(fk)
  }
  out.tables = [...byId.values()].map((x) => x.table)

  // The diagram as drawn: drawDB draws tables 220 wide, the app 240; its rows are taller, so the layout keeps its scale.
  for (const { source, table } of byId.values()) {
    if (Number.isFinite(source.x) && Number.isFinite(source.y)) out.positions[layoutKey(table)] = { x: Math.round(source.x), y: Math.round(source.y) }
    if (source.color && /^#[0-9a-f]{6}$/i.test(source.color)) out.colors[layoutKey(table)] = source.color
  }
  for (const n of d.notes ?? []) {
    const text = [n.title?.trim(), n.content?.trim()].filter(Boolean).join('\n')
    if (Number.isFinite(n.x) && Number.isFinite(n.y)) out.notes.push({ id: `drawdb-note-${n.id}`, text, x: Math.round(n.x), y: Math.round(n.y) })
  }
  for (const a of d.subjectAreas ?? d.areas ?? []) {
    if ([a.x, a.y, a.width, a.height].every(Number.isFinite)) out.boxes.push({ id: `drawdb-area-${a.id}`, title: a.name ?? '', x: Math.round(a.x), y: Math.round(a.y), w: Math.round(a.width), h: Math.round(a.height) })
  }
  return out
}

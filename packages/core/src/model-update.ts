import { typeFamily } from './model-checks.js'
import type { ColumnInfo, TableInfo } from './types.js'

/**
 * Brings a model up to date with a database: what the database has and the model lacks is added, what differs
 * follows the database, and what only a model knows stays (comments the database does not have, the named types
 * columns follow, check constraints, virtual relationships). The opposite of the migration: here the database
 * is right.
 */

export interface ModelUpdate {
  tables: TableInfo[]
  /** What changed, for a summary: counts by kind. */
  summary: { tablesAdded: number; tablesRemoved: number; columnsAdded: number; columnsRemoved: number; columnsChanged: number; relationshipsChanged: number; indexesChanged: number }
}

const lower = (s: string) => s.toLowerCase()
const size = (type: string) => (/\(([^)]*)\)/.exec(type)?.[1] ?? '').replace(/\s+/g, '')
const isSerial = (type: string) => /serial/i.test(type)
/** A sequence default is how the database spells what a model writes as serial or identity. */
const fromSequence = (c: ColumnInfo) => c.isIdentity || /nextval\s*\(/i.test(c.defaultValue ?? '')

/** The same type under the names a model and a database give it (`bigserial` and a `bigint` fed by a sequence, `int4` and `integer`). */
function sameType(model: ColumnInfo, db: ColumnInfo): boolean {
  // A column that follows a domain the database has as a type of its own (PostgreSQL's CREATE DOMAIN): the
  // database reports the domain's name as the type.
  const bare = (name: string) => lower(name).replace(/^.*\./, '').replaceAll('"', '')
  if (model.domain && bare(db.dataType) === bare(model.domain)) return true
  if (typeFamily(model.dataType) !== typeFamily(db.dataType)) return false
  return size(model.dataType) === size(db.dataType) || !size(model.dataType) || !size(db.dataType)
}
const sameDefault = (model: ColumnInfo, db: ColumnInfo) => {
  if ((isSerial(model.dataType) || model.isIdentity) && fromSequence(db)) return true
  const norm = (v: string | null | undefined) => lower(v ?? '').replace(/::[\w\s"[\]]+/g, '').replace(/^\((.*)\)$/, '$1').replace(/\s+/g, '').replace(/^'(.*)'$/, '$1')
  return norm(model.defaultValue) === norm(db.defaultValue)
}
const columnsKey = (cols: string[]) => cols.map(lower).join(',')

export function updateModelFromDatabase(model: TableInfo[], database: TableInfo[], options: { /** Tables the database does not have leave the model. */ removeMissing?: boolean } = {}): ModelUpdate {
  const summary = { tablesAdded: 0, tablesRemoved: 0, columnsAdded: 0, columnsRemoved: 0, columnsChanged: 0, relationshipsChanged: 0, indexesChanged: 0 }
  const real = database.filter((t) => t.type === 'table')
  const find = (name: string, schema?: string) => {
    const same = model.filter((t) => lower(t.name) === lower(name))
    return same.find((t) => lower(t.schema ?? '') === lower(schema ?? '')) ?? (same.length === 1 ? same[0] : undefined)
  }
  /** The model's spelling of a table the database also has (names are matched without case). */
  const modelName = (name: string, schema?: string) => find(name, schema)?.name ?? name
  const out: TableInfo[] = []
  const seen = new Set<TableInfo>()

  for (const db of real) {
    const mine = find(db.name, db.schema)
    if (!mine) {
      out.push({ ...db, foreignKeys: db.foreignKeys.map((f) => ({ ...f, refTable: modelName(f.refTable, f.refSchema) })) })
      summary.tablesAdded++
      continue
    }
    seen.add(mine)
    const columnName = (name: string) => mine.columns.find((c) => lower(c.name) === lower(name))?.name ?? name
    const columns = db.columns.map((c, i): ColumnInfo => {
      const old = mine.columns.find((x) => lower(x.name) === lower(c.name))
      if (!old) {
        summary.columnsAdded++
        return { ...c, ordinal: i + 1 }
      }
      const typeKept = sameType(old, c)
      const defaultKept = sameDefault(old, c)
      if (!typeKept || !defaultKept || old.nullable !== c.nullable) summary.columnsChanged++
      const { domain, ...rest } = old
      return {
        ...rest,
        ordinal: i + 1,
        dataType: typeKept ? old.dataType : c.dataType,
        nullable: c.nullable,
        defaultValue: defaultKept ? (old.defaultValue ?? null) : (c.defaultValue ?? null),
        isPrimaryKey: c.isPrimaryKey,
        isIdentity: typeKept && isSerial(old.dataType) ? old.isIdentity : c.isIdentity,
        // The database's comment wins where it has one: that is where a hotfix would have changed it.
        comment: c.comment || old.comment || null,
        // A column whose type changed no longer follows the named type it had.
        ...(domain && typeKept ? { domain } : {}),
      }
    })
    summary.columnsRemoved += mine.columns.filter((c) => !db.columns.some((x) => lower(x.name) === lower(c.name))).length

    const foreignKeys = [
      ...db.foreignKeys.filter((f) => !f.virtual).map((f) => {
        const old = mine.foreignKeys.find((x) => columnsKey(x.columns) === columnsKey(f.columns) && lower(x.refTable) === lower(f.refTable))
        return { ...f, name: old?.name ?? f.name, columns: f.columns.map(columnName), refTable: modelName(f.refTable, f.refSchema), refSchema: find(f.refTable, f.refSchema)?.schema ?? f.refSchema }
      }),
      ...mine.foreignKeys.filter((f) => f.virtual),
    ]
    const relKey = (f: { columns: string[]; refTable: string; virtual?: boolean }) => `${columnsKey(f.columns)}>${lower(f.refTable)}`
    const before = new Set(mine.foreignKeys.filter((f) => !f.virtual).map(relKey))
    const after = new Set(foreignKeys.filter((f) => !f.virtual).map(relKey))
    summary.relationshipsChanged += [...before].filter((k) => !after.has(k)).length + [...after].filter((k) => !before.has(k)).length

    const indexKey = (ix: { unique: boolean; columns: string[] }) => `${ix.unique ? 'u' : 'i'}:${columnsKey(ix.columns)}`
    const indexes = db.indexes.map((ix) => {
      const old = mine.indexes.find((x) => x.primary === ix.primary && indexKey(x) === indexKey(ix))
      return { ...ix, name: old?.name ?? ix.name, columns: ix.columns.map(columnName) }
    })
    const ixBefore = new Set(mine.indexes.filter((x) => !x.primary).map(indexKey))
    const ixAfter = new Set(indexes.filter((x) => !x.primary).map(indexKey))
    summary.indexesChanged += [...ixBefore].filter((k) => !ixAfter.has(k)).length + [...ixAfter].filter((k) => !ixBefore.has(k)).length

    out.push({ ...mine, comment: db.comment || mine.comment || null, columns, primaryKey: db.primaryKey.map(columnName), foreignKeys, indexes })
  }

  // Tables only the model has: kept where they were unless asked otherwise (they may simply not be deployed yet).
  const kept = model.filter((t) => !seen.has(t))
  if (options.removeMissing) summary.tablesRemoved = kept.filter((t) => t.type === 'table').length
  const rest = options.removeMissing ? kept.filter((t) => t.type !== 'table') : kept
  const gone = new Set(options.removeMissing ? kept.filter((t) => t.type === 'table').map((t) => lower(t.name)) : [])
  // The model's own order first, then what is new.
  const order = new Map(model.map((t, i) => [t, i]))
  const merged = [...out.filter((t) => find(t.name, t.schema) && seen.has(find(t.name, t.schema)!)), ...rest].sort((a, b) => (order.get(find(a.name, a.schema) ?? a) ?? 0) - (order.get(find(b.name, b.schema) ?? b) ?? 0))
  const added = out.filter((t) => !find(t.name, t.schema))
  const tables = [...merged, ...added].map((t) => (gone.size ? { ...t, foreignKeys: t.foreignKeys.filter((f) => !gone.has(lower(f.refTable))) } : t))
  return { tables, summary }
}

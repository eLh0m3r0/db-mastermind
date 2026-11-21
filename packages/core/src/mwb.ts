import { Unzip, UnzipInflate } from 'fflate'
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo } from './types.js'
import { parseDezignXml, unescapeDezignText, type DezignElement } from './dezign.js'
import { emptyImport, layoutKey, leaveOut, spreadLayout, type ImportedModel } from './imported-model.js'
import { isPlainType, plainDefault } from './foreign-sql.js'
import { checkSize, FILE_LIMITS, megabytes } from './untrusted.js'

/**
 * MySQL Workbench models (.mwb): a zip holding `document.mwb.xml`, Workbench's object tree (GRT) written as nested
 * `<value type="object|list|dict|string|int|real" key="…">` elements, with `<link>`s to objects by id. The model is
 * read from the first physical model: its schemas, tables, columns, indexes and foreign keys, and the table figures
 * of its diagrams. Types stay MySQL's.
 */

type Grt = string | number | GrtObject | Grt[] | { $link: string }
interface GrtObject {
  $struct?: string
  $id?: string
  [key: string]: Grt | undefined
}

const attr = (open: string, name: string) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(open)
  return m ? unescapeDezignText(m[1]!) : undefined
}
const textOf = (el: DezignElement) => unescapeDezignText(el.children.filter((c): c is string => typeof c === 'string').join(''))
const elements = (el: DezignElement) => el.children.filter((c): c is DezignElement => typeof c !== 'string')

/** The GRT tree of a Workbench document, with every object by id (links point at them). */
function readGrt(xml: string): { root: GrtObject; byId: Map<string, GrtObject> } {
  let doc: DezignElement
  try {
    doc = parseDezignXml(xml)
  } catch {
    throw new Error('Not a readable MySQL Workbench model: its document is not well-formed XML')
  }
  const byId = new Map<string, GrtObject>()
  const convert = (el: DezignElement, depth = 0): Grt => {
    // (A document nested deeper than any Workbench writes is no model, and would run out of stack.)
    if (depth > FILE_LIMITS.depth) throw new Error('Not a readable MySQL Workbench model: its document is nested too deeply')
    if (el.tag === 'link') return { $link: textOf(el).trim() }
    const type = attr(el.open, 'type')
    if (type === 'object' || type === 'dict') {
      const o: GrtObject = {}
      const struct = attr(el.open, 'struct-name')
      const id = attr(el.open, 'id')
      if (struct) o.$struct = struct
      if (id) {
        o.$id = id
        byId.set(id, o)
      }
      for (const k of elements(el)) {
        const key = attr(k.open, 'key')
        if (key) o[key] = convert(k, depth + 1)
      }
      return o
    }
    if (type === 'list') return elements(el).map((k) => convert(k, depth + 1))
    if (type === 'int' || type === 'real') return Number(textOf(el))
    return textOf(el)
  }
  const data = elements(doc).find((e) => e.tag === 'data')
  const top = data && elements(data).find((e) => e.tag === 'value')
  if (!top) throw new Error('Not a MySQL Workbench model: document.mwb.xml has no document')
  const root = convert(top)
  if (typeof root !== 'object' || Array.isArray(root) || '$link' in root) throw new Error('Not a MySQL Workbench model')
  return { root: root as GrtObject, byId }
}

const obj = (v: Grt | undefined): GrtObject | undefined => (v && typeof v === 'object' && !Array.isArray(v) && !('$link' in v) ? (v as GrtObject) : undefined)
const list = (v: Grt | undefined): Grt[] => (Array.isArray(v) ? v : [])
const str = (v: Grt | undefined): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
const num = (v: Grt | undefined): number => (typeof v === 'number' ? v : Number(v ?? NaN))
const linkId = (v: Grt | undefined): string | undefined => (v && typeof v === 'object' && !Array.isArray(v) && '$link' in v ? (v as { $link: string }).$link : undefined)

/** A column's type as MySQL writes it: `varchar(45)`, `decimal(4,2)`, `smallint unsigned`, `enum('G','PG')`. */
function columnType(c: GrtObject, byId: Map<string, GrtObject>): string {
  const simple = linkId(c.simpleType)
  const user = linkId(c.userType)
  if (user) {
    // A user type (Workbench's BOOL, BOOLEAN …) is defined by its SQL: TINYINT(1).
    const defined = byId.get(user)
    const sql = defined ? str(defined.sqlDefinition) : ''
    if (sql) return sql.toLowerCase()
    return (user.split('.').pop() ?? 'text').toLowerCase()
  }
  const base = (simple?.split('.').pop() ?? str(c.formattedType) ?? 'text').replace(/_f$/, '').toLowerCase()
  const explicit = str(c.datatypeExplicitParams).trim()
  const length = num(c.length)
  const precision = num(c.precision)
  const scale = num(c.scale)
  let args = ''
  if (explicit) args = explicit.startsWith('(') ? explicit.replace(/'\s*,\s*'/g, "','") : `(${explicit})`
  else if (length > 0) args = `(${length})`
  else if (precision > 0) args = scale >= 0 && !/^(datetime|timestamp|time)$/.test(base) ? `(${precision},${scale})` : `(${precision})`
  const flags = list(c.flags).map(str).map((f) => f.toLowerCase())
  return `${base}${args}${flags.includes('unsigned') ? ' unsigned' : ''}${flags.includes('zerofill') ? ' zerofill' : ''}`
}

/**
 * A default as SQL: Workbench keeps it as typed, `ON UPDATE …` included (that part is no default), and a number's
 * as MySQL reports it, quoted ('4.99'): written as the number, as the SQL reader writes it (ddl-import.ts).
 */
function columnDefault(c: GrtObject, type: string): string | null | undefined {
  if (num(c.defaultValueIsNull) === 1) return null
  const d = str(c.defaultValue)
    .replace(/\s+ON\s+UPDATE\s+.*$/is, '')
    .trim()
  if (!d || /^null$/i.test(d)) return null
  const quoted = /^'(-?\d+(?:\.\d+)?)'$/.exec(d)
  if (quoted && /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real)\b/.test(type)) {
    const text = quoted[1]!
    return text.replace(/[-.]/g, '').replace(/^0+/, '').length <= 15 ? String(Number(text)) : text
  }
  return plainDefault(d)
}

/**
 * The model's document.mwb.xml, and nothing else of the archive, inflated a slice at a time: the size its header
 * declares may lie, so the inflated bytes are counted as they come and inflating stops at the limit (a zip bomb
 * never gets to allocate more than one slice beyond it).
 */
export function mwbDocument(bytes: Uint8Array, limit = FILE_LIMITS.mwbDocument, /** Filled with how many bytes were inflated (tests). */ stats?: { inflated: number }): string {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('Not a MySQL Workbench model: the file is not a zip archive')
  const chunks: Uint8Array[] = []
  let total = 0
  let found = false
  let done = false
  let failure: Error | undefined
  const unzip = new Unzip()
  unzip.register(UnzipInflate)
  unzip.onfile = (file) => {
    if (file.name !== 'document.mwb.xml' || found) return
    found = true
    if (file.originalSize !== undefined && file.originalSize > limit) {
      failure = new Error(`The model's document is larger than ${megabytes(limit)}: not a model this app opens`)
      return
    }
    file.ondata = (err, chunk, final) => {
      if (err) {
        failure = new Error('Not a MySQL Workbench model: its document can\'t be inflated')
        return
      }
      total += chunk.length
      if (stats) stats.inflated = total
      if (total > limit) {
        failure = new Error(`The model's document is larger than ${megabytes(limit)}: not a model this app opens`)
        file.terminate()
        return
      }
      chunks.push(chunk)
      if (final) done = true
    }
    file.start()
  }
  // 16 KB of deflated data inflates to at most about 16 MB.
  const step = 16 * 1024
  try {
    for (let i = 0; i < bytes.length && !failure && !done; i += step) unzip.push(bytes.subarray(i, i + step), i + step >= bytes.length)
  } catch {
    throw new Error('Not a MySQL Workbench model: the file is not a readable zip archive')
  }
  if (failure) throw failure
  if (!found) throw new Error('Not a MySQL Workbench model: there is no document.mwb.xml in it')
  const document = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    document.set(c, offset)
    offset += c.length
  }
  return new TextDecoder('utf-8').decode(document)
}

export function tablesFromMwb(bytes: Uint8Array): ImportedModel {
  checkSize('The MySQL Workbench model', bytes.length, FILE_LIMITS.mwb, 'a model')
  const { root, byId } = readGrt(mwbDocument(bytes))
  const model = obj(list(root.physicalModels)[0])
  const catalog = obj(model?.catalog)
  if (!catalog) throw new Error('The MySQL Workbench model has no physical model')
  const out: ImportedModel = { ...emptyImport('mwb'), database: 'mysql' }
  const count = (kind: keyof ImportedModel['leftOut'], n: number) => {
    if (n > 0) out.leftOut[kind] = (out.leftOut[kind] ?? 0) + n
  }

  const schemas = list(catalog.schemata).map(obj).filter((s): s is GrtObject => !!s)
  const withTables = schemas.filter((s) => list(s.tables).some((t) => num(obj(t)?.isStub) !== 1))
  // One schema is the model's database: its tables need no schema. Several keep theirs.
  const qualified = withTables.length > 1
  const tableOf = new Map<string, TableInfo>()
  const columnName = new Map<string, string>()
  for (const s of schemas) {
    count('views', list(s.views).length)
    count('routines', list(s.routines).length)
    for (const t of list(s.tables).map(obj)) {
      if (!t || num(t.isStub) === 1) continue
      count('triggers', list(t.triggers).length)
      const columns: ColumnInfo[] = list(t.columns)
        .map(obj)
        .filter((c): c is GrtObject => !!c)
        .map((c, i) => {
          if (c.$id) columnName.set(c.$id, str(c.name))
          const generated = num(c.generated) === 1
          // Types, defaults and collations are SQL the file gives as text: taken only when plain (foreign-sql.ts).
          const typed = columnType(c, byId)
          const dataType = isPlainType(typed) ? typed : 'text'
          const defaultValue = columnDefault(c, dataType)
          const collation = str(c.collationName)
          const column: ColumnInfo = {
            name: str(c.name),
            ordinal: i + 1,
            dataType,
            nullable: num(c.isNotNull) !== 1,
            defaultValue: defaultValue ?? null,
            isPrimaryKey: false,
            isIdentity: num(c.autoIncrement) === 1,
            comment: str(c.comment) || null,
            ...(generated ? { isGenerated: true } : {}),
            ...(/^[A-Za-z0-9_]+$/.test(collation) ? { collation } : {}),
          }
          if (dataType !== typed) leaveOut(out, column, 'types', 'MySQL Workbench', typed)
          if (defaultValue === undefined) leaveOut(out, column, 'defaults', 'MySQL Workbench', str(c.defaultValue))
          return column
        })
      const table: TableInfo = { ...(qualified ? { schema: str(s.name) } : {}), name: str(t.name), type: 'table', comment: str(t.comment) || null, columns, primaryKey: [], foreignKeys: [], indexes: [] }
      if (t.$id) tableOf.set(t.$id, table)
      tableOf.set(`grt:${str(s.name)}.${str(t.name)}`, table)
    }
  }
  // Indexes and foreign keys refer to columns of any table: read once every column is known.
  for (const s of schemas) {
    for (const t of list(s.tables).map(obj)) {
      const table = t?.$id ? tableOf.get(t.$id) : undefined
      if (!t || !table) continue
      for (const ix of list(t.indices).map(obj)) {
        if (!ix) continue
        const parts = list(ix.columns)
          .map(obj)
          .filter((p): p is GrtObject => !!p)
          .map((p) => ({ column: columnName.get(linkId(p.referencedColumn) ?? '') ?? '', length: num(p.columnLength), desc: num(p.descend) === 1, expression: str(p.expression) }))
        const columns = parts.map((p) => p.column || (p.expression ? `(${p.expression})` : '')).filter(Boolean)
        const kind = str(ix.indexType).toUpperCase()
        const primary = num(ix.isPrimary) === 1 || kind === 'PRIMARY'
        if (primary) {
          table.primaryKey = columns
          table.indexes.unshift({ name: 'PRIMARY', columns, unique: true, primary: true })
          continue
        }
        const index: IndexInfo = { name: str(ix.name), columns, unique: kind === 'UNIQUE' || num(ix.unique) === 1, primary: false }
        // What a column list can't say (a prefix, descending order, FULLTEXT, SPATIAL) goes into the index's own SQL.
        if (kind === 'FULLTEXT' || kind === 'SPATIAL') index.method = kind
        if (kind === 'FULLTEXT' || kind === 'SPATIAL' || parts.some((p) => p.length > 0 || p.desc || p.expression)) {
          const q = (n: string) => `\`${n.replaceAll('`', '``')}\``
          const list = parts.map((p) => (p.expression ? `(${p.expression})` : `${q(p.column)}${p.length > 0 ? `(${p.length})` : ''}${p.desc ? ' DESC' : ''}`))
          index.definition = `CREATE ${kind === 'FULLTEXT' || kind === 'SPATIAL' ? `${kind} ` : index.unique ? 'UNIQUE ' : ''}INDEX ${q(index.name)} ON ${table.schema ? `${q(table.schema)}.` : ''}${q(table.name)} (${list.join(', ')})`
          index.definitionDriver = 'mysql'
        }
        table.indexes.push(index)
      }
      for (const fk of list(t.foreignKeys).map(obj)) {
        if (!fk) continue
        const target = tableOf.get(linkId(fk.referencedTable) ?? '')
        const columns = list(fk.columns).map((c) => columnName.get(linkId(c) ?? '') ?? '')
        const refColumns = list(fk.referencedColumns).map((c) => columnName.get(linkId(c) ?? '') ?? '')
        if (!target || !columns.length || columns.some((c) => !c) || refColumns.some((c) => !c)) {
          count('brokenRelationships', 1)
          continue
        }
        const rule = (r: string) => (r.trim() ? r.trim().toUpperCase() : undefined)
        const info: ForeignKeyInfo = { name: str(fk.name), columns, ...(target.schema ? { refSchema: target.schema } : {}), refTable: target.name, refColumns, onDelete: rule(str(fk.deleteRule)), onUpdate: rule(str(fk.updateRule)) }
        // Workbench's one-to-one (many = 0) is a relationship at most one row of this table has.
        if (num(fk.many) === 0) info.cardinality = 'zero-or-one'
        table.foreignKeys.push(info)
      }
      for (const c of table.columns) c.isPrimaryKey = table.primaryKey.includes(c.name)
    }
  }
  out.tables = [...new Set(tableOf.values())]

  // Diagrams: the one that shows the most tables gives the model's positions (Sakila's first diagram shows two
  // tables of another schema), the others are diagrams of their own.
  const diagrams = list(model?.diagrams).map(obj).filter((d): d is GrtObject => !!d)
  const shown = (d: GrtObject) => list(d.figures).filter((f) => /TableFigure$/.test(obj(f)?.$struct ?? '')).length
  diagrams.sort((a, b) => shown(b) - shown(a))
  let main = true
  for (const d of diagrams) {
    const layers = new Map<string, { x: number; y: number; root: boolean }>()
    const rootLayer = obj(d.rootLayer)
    if (rootLayer?.$id) layers.set(rootLayer.$id, { x: 0, y: 0, root: true })
    for (const l of list(d.layers).map(obj)) if (l?.$id) layers.set(l.$id, { x: num(l.left) || 0, y: num(l.top) || 0, root: false })
    // A figure's place is relative to its layer.
    const at = (f: GrtObject) => {
      const layer = layers.get(linkId(f.layer) ?? '')
      return { x: num(f.left) + (layer && !layer.root ? layer.x : 0), y: num(f.top) + (layer && !layer.root ? layer.y : 0) }
    }
    const figures = list(d.figures)
      .map(obj)
      .filter((f): f is GrtObject => !!f && /TableFigure$/.test(f.$struct ?? ''))
      .flatMap((f) => {
        const table = tableOf.get(linkId(f.table) ?? '')
        const p = at(f)
        return table && Number.isFinite(p.x) && Number.isFinite(p.y) ? [{ key: layoutKey(table), x: p.x, y: p.y, w: num(f.width), h: num(f.height), columns: table.columns.length, color: str(f.color) }] : []
      })
    if (!figures.length) continue
    const { positions, place, scale } = spreadLayout(figures)
    const colors = Object.fromEntries(figures.filter((f) => /^#[0-9a-f]{6}$/i.test(f.color)).map((f) => [f.key, f.color]))
    if (main) {
      out.positions = positions
      out.colors = colors
      for (const l of list(d.layers).map(obj)) {
        if (!l?.$id) continue
        const p = place(num(l.left), num(l.top))
        if ([p.x, p.y, num(l.width), num(l.height)].every(Number.isFinite)) out.boxes.push({ id: l.$id, title: str(l.name), x: p.x, y: p.y, w: Math.round(num(l.width) * scale.x), h: Math.round(num(l.height) * scale.y) })
      }
      for (const n of list(d.figures).map(obj)) {
        if (!n?.$id || !/NoteFigure$/.test(n.$struct ?? '')) continue
        const p = at(n)
        const placed = place(p.x, p.y)
        if (Number.isFinite(placed.x) && Number.isFinite(placed.y)) out.notes.push({ id: n.$id, text: str(n.text), x: placed.x, y: placed.y })
      }
      main = false
    } else out.diagrams.push({ id: d.$id ?? str(d.name), name: str(d.name), tables: figures.map((f) => f.key), positions, colors })
  }
  return out
}

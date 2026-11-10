import {
  assembleDezignProject,
  DEZIGN_RULES,
  dezignIntegrity,
  dezignChild as kid,
  dezignChildren as kids,
  parseDezignXml,
  readDezign,
  serializeDezignXml,
  unescapeDezignText,
  type DezignElement,
  type DezignEncoding,
  type DezignModel,
} from './dezign.js'
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo } from './types.js'

/**
 * Writes a changed model back into a DeZign for Databases project, in place: the original document is kept as a
 * tree and only the elements a change touches are edited, so everything this model does not carry (domains,
 * checks, views, triggers, notes, diagram styling, settings) and the file format version stay as they were.
 * New objects are cloned from a neighbour of the same kind, which keeps the element layout of whatever DeZign
 * version wrote the file.
 *
 * `baseline` is the model as it was opened and `target` the edited one, both in the same representation (for a
 * DBML document: both parsed from DBML), so a detail that representation loses is never taken for a change.
 *
 * DRAFT: the output is checked by reading it back, but not yet by opening it in DeZign itself.
 */

export interface DezignFile {
  /** Path relative to the project folder (single-file projects: the file's name). */
  path: string
  /** Content as a binary string (one char per byte). */
  text: string
}

export type DezignChangeKind =
  | 'add_table'
  | 'drop_table'
  | 'rename_table'
  | 'alter_table'
  | 'add_column'
  | 'drop_column'
  | 'rename_column'
  | 'alter_column'
  | 'set_primary_key'
  | 'add_index'
  | 'drop_index'
  | 'add_check'
  | 'drop_check'
  | 'add_relationship'
  | 'drop_relationship'
  | 'alter_relationship'
  | 'move_table'
  | 'alter_note'

export interface DezignChange {
  kind: DezignChangeKind
  table: string
  /** Column, index columns or referenced table. */
  name?: string
}

export interface DezignSaveResult {
  /** Files whose content changed or that are new. */
  files: DezignFile[]
  /** Files to delete (folder projects: dropped or renamed objects). */
  deleted: string[]
  changes: DezignChange[]
}

export interface SaveDezignOptions {
  encoding?: DezignEncoding
  fallbackEncoding?: Exclude<DezignEncoding, 'utf-8'>
  /** Same value the model was read with, so positions map back to DeZign's coordinates. */
  node?: { width: number; header: number; row: number }
  /** Diagram positions keyed `schema.table`: new tables are placed there, moved tables follow. */
  positions?: Record<string, { x: number; y: number }>
  /**
   * Diagrams by id: the tables each should show (missing ones are added to it) and where they are, for the
   * diagrams other than the main one; and the text areas of any diagram (text and place of existing ones: text
   * areas are not created or removed here). Tables are never taken off a diagram.
   */
  diagrams?: Record<string, { tables?: string[]; positions?: Record<string, { x: number; y: number }>; notes?: { id: string; text: string; x: number; y: number }[] }>
  /** Ids for new objects (default: random GUIDs, or the next number in files that number their objects). */
  newId?: () => string
  /**
   * Brings a model read from DeZign into the representation of `baseline` and `target` (for DBML documents: a
   * round trip through DBML). The written project is read back through it and compared with `target`.
   */
  normalize?: (tables: TableInfo[]) => TableInfo[]
}

type El = DezignElement
type Kind = 'ENT' | 'REL' | 'ENTC' | 'RELC' | 'DIAGRAM' | 'SUBCAT' | 'SUBCONN' | 'SUBCATC' | 'SUBCONNC' | 'TEXTAR' | 'TEXTC'

interface Slot {
  el: El
  /** Folder projects: the object's file. */
  path?: string
}

const SINGLE: Record<Kind, string[]> = {
  ENT: ['DATADICT', 'ENTITIES'],
  REL: ['DATADICT', 'RELATIONSHIPS'],
  SUBCAT: ['DATADICT', 'SUBCATEGORIES'],
  SUBCONN: ['DATADICT', 'SUBCATEGORYCONNECTIONS'],
  SUBCATC: ['DIAGRAMS', 'CONTROLS', 'SUBCATEGORYCONTROLS'],
  SUBCONNC: ['DIAGRAMS', 'CONTROLS', 'SUBCATEGORYCONNECTORS'],
  DIAGRAM: ['DIAGRAMS'],
  ENTC: ['DIAGRAMS', 'CONTROLS', 'ENTITYCONTROLS'],
  RELC: ['DIAGRAMS', 'CONTROLS', 'RELATIONSHIPCONNECTORS'],
  TEXTAR: ['DATADICT', 'TEXTAREAS'],
  TEXTC: ['DIAGRAMS', 'CONTROLS', 'TEXTAREACONTROLS'],
}
const FOLDER: Record<Kind, string> = {
  ENT: 'data dictionary/entities',
  REL: 'data dictionary/relationships',
  SUBCAT: 'data dictionary/subcategories',
  SUBCONN: 'data dictionary/subcategoryconnections',
  SUBCATC: 'diagrams/diagramobjects/subcategorycontrols',
  SUBCONNC: 'diagrams/diagramobjects/subcategoryconnectors',
  DIAGRAM: 'diagrams',
  ENTC: 'diagrams/diagramobjects/entitycontrols',
  RELC: 'diagrams/diagramobjects/relationshipconnectors',
  TEXTAR: 'data dictionary/textareas',
  TEXTC: 'diagrams/diagramobjects/textareacontrols',
}

const lower = (s: string) => s.toLowerCase()
const tableKey = (t: { schema?: string; name: string }) => lower(`${t.schema ?? ''}.${t.name}`)
const normType = (s: string) => lower(s).replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').replace(/\s*\(\s*/g, '(').replace(/\s*\)/g, ')').trim()
const normText = (s: string | null | undefined) => (s ?? '').replace(/\r\n?/g, '\n').trim()
const indexKey = (ix: { unique: boolean; columns: string[] }) => `${ix.unique ? 'u' : 'i'}:${ix.columns.map(lower).join(',')}`

function codec(encoding: DezignEncoding, nl: string) {
  const decoder = new TextDecoder(encoding)
  const toByte = new Map<string, string>()
  if (encoding !== 'utf-8') {
    for (let b = 0x80; b <= 0xff; b++) {
      const ch = decoder.decode(Uint8Array.of(b))
      if (ch !== '�' && !toByte.has(ch)) toByte.set(ch, String.fromCharCode(b))
    }
  }
  return {
    decode: (s: string) => (/[\x80-\xff]/.test(s) ? decoder.decode(Uint8Array.from(s, (c) => c.charCodeAt(0))) : s),
    /** Text as it goes into the file: DeZign's escapes, its line ends, the document's code page. */
    encode(value: string): string {
      const escaped = value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replace(/\r\n?|\n/g, nl)
      if (encoding === 'utf-8') return Array.from(new TextEncoder().encode(escaped), (b) => String.fromCharCode(b)).join('')
      let out = ''
      for (const ch of escaped) out += ch.codePointAt(0)! < 0x80 ? ch : (toByte.get(ch) ?? `&#${ch.codePointAt(0)};`)
      return out
    },
  }
}

/** The project's objects, whether they sit in one document or in a file each. */
class Project {
  readonly folder: boolean
  readonly nl: string
  private doc?: El
  private version?: El
  private docs = new Map<string, { root: El; original: string }>()
  private dirs = new Map<Kind, string>()
  private header = '<?xml version="1.0" encoding="iso-8859-1"?>'
  readonly deleted = new Set<string>()
  private singlePath = ''
  private singleOriginal = ''

  constructor(files: DezignFile[]) {
    const project = files.find((f) => /\.dezproj$/i.test(f.path) && !/[\\/]/.test(f.path))
    this.folder = !!project
    this.nl = (project ?? files[0])?.text.includes('\r\n') ? '\r\n' : '\n'
    if (!this.folder) {
      const file = files[0]
      if (!file) throw new Error('No DeZign file to save to')
      this.singlePath = file.path
      this.singleOriginal = file.text
      this.doc = parseDezignXml(file.text)
      const versions = kids(kid(this.doc, 'dezign'), 'VERSION')
      this.version = versions.find((v) => !kid(v, 'VERSIONINFO')) ?? versions[0]
      if (!this.version) throw new Error('This is not a DeZign for Databases model')
      return
    }
    for (const f of files) {
      const path = f.path.replaceAll('\\', '/')
      const dir = lower(path.slice(0, Math.max(0, path.lastIndexOf('/'))))
      const kind = (Object.keys(FOLDER) as Kind[]).find((k) => FOLDER[k] === dir)
      if (!kind || !/\.xml$/i.test(path)) continue
      this.docs.set(path, { root: parseDezignXml(f.text), original: f.text })
      if (!this.dirs.has(kind)) this.dirs.set(kind, path.slice(0, path.lastIndexOf('/')))
      const decl = /^﻿?\s*<\?xml[^>]*\?>/.exec(f.text)
      if (decl) this.header = decl[0]
    }
  }

  private container(kind: Kind, create = false): El | undefined {
    let el = this.version
    for (const tag of SINGLE[kind]) {
      let next = kid(el, tag)
      if (!next && create && el) {
        next = { tag, open: `<${tag}>`, close: `</${tag}>`, children: [this.nl] }
        if (!el.children.length) el.children.push(this.nl)
        el.children.push(next, this.nl)
      }
      el = next
    }
    return el
  }

  list(kind: Kind): Slot[] {
    if (!this.folder) return kids(this.container(kind), kind === 'DIAGRAM' ? 'DIAGRAM' : undefined).map((el) => ({ el }))
    const dir = lower(this.dirs.get(kind) ?? FOLDER[kind])
    const out: Slot[] = []
    for (const [path, doc] of this.docs) {
      if (this.deleted.has(path) || lower(path.slice(0, path.lastIndexOf('/'))) !== dir) continue
      const el = kids(doc.root)[0]
      if (el) out.push({ el, path })
    }
    return out
  }

  /** `name` is the file name without extension in a folder project. */
  add(kind: Kind, el: El, name: string): Slot {
    if (!this.folder) {
      const parent = this.container(kind, true)!
      if (!parent.children.length) parent.children.push(this.nl)
      parent.children.push(el, this.nl)
      return { el }
    }
    const path = this.freePath(kind, name)
    this.docs.set(path, { root: { tag: '#document', open: '', close: '', children: [this.header, this.nl, el, this.nl] }, original: '' })
    this.deleted.delete(path)
    return { el, path }
  }

  private freePath(kind: Kind, name: string): string {
    const dir = this.dirs.get(kind) ?? FOLDER[kind]
    const safe = name.replace(/[\\/:*?"<>|]/g, '_') || 'object'
    let path = `${dir}/${safe}.xml`
    for (let n = 2; this.docs.has(path) && !this.deleted.has(path); n++) path = `${dir}/${safe}_${n}.xml`
    return path
  }

  remove(kind: Kind, slot: Slot): void {
    if (slot.path) {
      // A file added in this run and removed again simply never existed.
      if (this.docs.get(slot.path)?.original) this.deleted.add(slot.path)
      else this.docs.delete(slot.path)
      return
    }
    const parent = this.container(kind)
    if (!parent) return
    const i = parent.children.indexOf(slot.el)
    if (i === -1) return
    const next = parent.children[i + 1]
    parent.children.splice(i, typeof next === 'string' && !next.trim() ? 2 : 1)
  }

  /** Folder projects name some files after the object: keep that true after a rename. */
  rename(kind: Kind, slot: Slot, name: string): void {
    if (!slot.path) return
    const doc = this.docs.get(slot.path)
    if (!doc) return
    const current = slot.path.slice(slot.path.lastIndexOf('/') + 1, -4)
    if (current === name) return
    if (doc.original) this.deleted.add(slot.path)
    else this.docs.delete(slot.path)
    const path = this.freePath(kind, name)
    this.docs.set(path, { root: doc.root, original: '' })
    slot.path = path
  }

  fileStem(slot: Slot): string {
    return slot.path ? slot.path.slice(slot.path.lastIndexOf('/') + 1, -4) : ''
  }

  result(): { files: DezignFile[]; deleted: string[] } {
    if (!this.folder) {
      const text = serializeDezignXml(this.doc!)
      return { files: text === this.singleOriginal ? [] : [{ path: this.singlePath, text }], deleted: [] }
    }
    const files: DezignFile[] = []
    for (const [path, doc] of this.docs) {
      if (this.deleted.has(path)) continue
      const text = serializeDezignXml(doc.root)
      if (text !== doc.original) files.push({ path, text })
    }
    return { files, deleted: [...this.deleted] }
  }
}

interface Entity {
  slot: Slot
  el: El
  id: string
  /** Lower-case column name → ATTR. */
  attrs: Map<string, El>
}

/** Makes the DeZign project in `files` match `target`, changing only what differs from `baseline`. */
export function saveToDezign(files: DezignFile[], baseline: TableInfo[], target: TableInfo[], options: SaveDezignOptions = {}): DezignSaveResult {
  const project = new Project(files)
  const assembled = project.folder ? assembleDezignProject(files) : files[0]!.text
  const source = readDezign(assembled, { encoding: options.encoding, fallbackEncoding: options.fallbackEncoding, node: options.node })
  const { nl } = project
  const { decode, encode } = codec(source.encoding, nl)
  const changes: DezignChange[] = []

  // --- element helpers -------------------------------------------------------------------------------------
  const text = (el: El | undefined, tag: string): string => {
    const k = kid(el, tag)
    return k ? unescapeDezignText(decode(k.children.filter((c) => typeof c === 'string').join(''))).trim() : ''
  }
  const leaf = (tag: string, value = ''): El => ({ tag, open: `<${tag}>`, close: `</${tag}>`, children: value ? [encode(value)] : [] })
  const insert = (parent: El, el: El, before: string[] = []) => {
    const at = parent.children.findIndex((k) => typeof k !== 'string' && before.includes(k.tag))
    if (at !== -1) parent.children.splice(at, 0, el, nl)
    else {
      if (!parent.children.length) parent.children.push(nl)
      parent.children.push(el, nl)
    }
  }
  const remove = (parent: El | undefined, el: El | undefined) => {
    if (!parent || !el) return
    const i = parent.children.indexOf(el)
    if (i === -1) return
    const next = parent.children[i + 1]
    parent.children.splice(i, typeof next === 'string' && !next.trim() ? 2 : 1)
  }
  const set = (parent: El, tag: string, value: string, before: string[] = []) => {
    const existing = kid(parent, tag)
    if (!existing) return insert(parent, leaf(tag, value), before)
    existing.children = value ? [encode(value)] : []
    if (!existing.close) Object.assign(existing, { open: `<${tag}>`, close: `</${tag}>` })
  }
  /** Sets or removes an optional value element (DeZign leaves it out when there is no value). */
  const setOptional = (parent: El, tag: string, value: string, before: string[]) => (value ? set(parent, tag, value, before) : remove(parent, kid(parent, tag)))
  const fill = (parent: El, children: El[]) => {
    parent.children = [nl, ...children.flatMap((c) => [c, nl])]
  }
  const container = (tag: string, children: El[]): El => {
    const el: El = { tag, open: `<${tag}>`, close: `</${tag}>`, children: [] }
    fill(el, children)
    return el
  }
  /**
   * A copy of an element with its own id changed. Only the fields that hold that id are touched (the element's
   * `ID`, the ids derived from it such as `…-PK`, and its self-references in `ATTRIBUTEID`): files that number
   * their objects have ids like `1`, which a textual replace would also find inside lengths and type codes.
   */
  const clone = (el: El, replace: [string, string][] = []): El => {
    const copy = kids(parseDezignXml(serializeDezignXml(el)))[0]!
    const walk = (node: El) => {
      for (const child of kids(node)) walk(child)
      if (node.tag !== 'ID' && node.tag !== 'ATTRIBUTEID') return
      const value = node.children.filter((c) => typeof c === 'string').join('').trim()
      for (const [from, to] of replace) {
        if (!from) continue
        if (value === from) node.children = [to]
        else if (value.startsWith(`${from}-`)) node.children = [to + value.slice(from.length)]
        else continue
        break
      }
    }
    walk(copy)
    return copy
  }
  const idsOf = (constraint: El | undefined) => kids(kid(constraint, 'ATTRIBUTEIDS'), 'ATTRIBUTEID').map((a) => a.children.filter((c) => typeof c === 'string').join('').trim())
  const setIds = (constraint: El, ids: string[]) => {
    let list = kid(constraint, 'ATTRIBUTEIDS')
    if (!list) insert(constraint, (list = container('ATTRIBUTEIDS', [])))
    fill(list, ids.map((id) => leaf('ATTRIBUTEID', id)))
  }
  const fromTemplate = (template: string, values: Record<string, string>) => template.replace(/%(\w+)%/g, (whole, key: string) => values[lower(key)] ?? whole)

  // --- ids --------------------------------------------------------------------------------------------------
  const allIds = [...project.list('ENT'), ...project.list('REL'), ...project.list('SUBCAT'), ...project.list('DIAGRAM')].map((s) => text(s.el, 'ID'))
  const numbered = allIds.length > 0 && allIds.every((id) => /^\d+$/.test(id))
  let lastNumber = numbered ? Math.max(...allIds.map(Number)) : 0
  const randomId = options.newId ?? (() => globalThis.crypto.randomUUID().toUpperCase())
  const newObjectId = () => (numbered ? String(++lastNumber) : randomId())
  const newChildId = (siblings: string[]) => (siblings.length ? siblings.every((id) => /^\d+$/.test(id)) : numbered) ? String(Math.max(0, ...siblings.map(Number)) + 1) : randomId()

  // --- the project's entities -----------------------------------------------------------------------------
  const entityOf = (slot: Slot): Entity => {
    const attrs = new Map<string, El>()
    for (const a of kids(kid(slot.el, 'ATTRIBUTES'), 'ATTR')) attrs.set(lower(text(a, 'NAME')), a)
    return { slot, el: slot.el, id: text(slot.el, 'ID'), attrs }
  }
  const schemaOf = (el: El) => text(el, 'SCHEMA') || text(el, 'SCHEMANAME') || undefined
  const entities = new Map<string, Entity>()
  for (const slot of project.list('ENT')) entities.set(tableKey({ schema: schemaOf(slot.el), name: text(slot.el, 'NAME') }), entityOf(slot))
  // Folder projects name entity files `schema.name`, `name` or by id, depending on the DeZign version.
  const sample = project.list('ENT')[0]
  const entityFileName = (el: El) => {
    const stem = sample ? project.fileStem(sample) : ''
    if (sample && stem === text(sample.el, 'ID')) return text(el, 'ID')
    if (sample && stem === text(sample.el, 'NAME')) return text(el, 'NAME')
    return `${schemaOf(el) ?? ''}.${text(el, 'NAME')}`.replace(/^\./, '')
  }
  const relSample = project.list('REL')[0]
  const relFileName = (el: El) => (relSample && project.fileStem(relSample) === text(relSample.el, 'ID') ? text(el, 'ID') : text(el, 'NAME'))
  const controlFileName = (prefix: string, diagramId: string, id: string) => `${prefix}-${diagramId}-${id}`

  const domainTypes = new Map<string, string>()
  for (const t of source.tables) for (const c of t.columns) domainTypes.set(`${tableKey(t)}/${lower(c.name)}`, normType(c.dataType))

  // --- columns ----------------------------------------------------------------------------------------------
  const setType = (attr: El, dataType: string, identity: boolean) => {
    let dt = kid(attr, 'DT')
    if (!dt) insert(attr, (dt = container('DT', [])), ['NNCON', 'CCON', 'DEFCON'])
    const m = /^(.+?)\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)$/.exec(dataType.trim())
    set(dt, 'DTLISTNAME', (m ? m[1]! : dataType).trim().toUpperCase(), ['LE', 'PR', 'SD', 'INC', 'AN'])
    setOptional(dt, 'LE', m?.[2] ?? '', ['PR', 'SD', 'INC', 'AN'])
    setOptional(dt, 'PR', m?.[3] ?? '', ['SD', 'INC', 'AN'])
    setOptional(dt, 'AN', identity ? '1' : '', [])
    // A column with its own type no longer follows a domain.
    if (kid(attr, 'DOMAINID')) set(attr, 'DOMAINID', '')
  }
  // Old formats write a column's constraint elements only when they hold something.
  const CONSTRAINTS = { NNCON: ['NN', '5'], CCON: ['CC', '1'], DEFCON: ['DEF', '6'] } as const
  const columnConstraint = (attr: El, tag: keyof typeof CONSTRAINTS, create: boolean): El | undefined => {
    let con = kid(attr, tag)
    if (!con && create) {
      const id = text(attr, 'ID')
      con = container(tag, [leaf('NAME'), leaf('ID', /^\d+$/.test(id) ? '0' : `${id}-${CONSTRAINTS[tag][0]}`), leaf('CONLEVEL', '1'), leaf('CONTYPE', CONSTRAINTS[tag][1]), container('ATTRIBUTEIDS', [leaf('ATTRIBUTEID', id)])])
      insert(attr, con, tag === 'NNCON' ? ['CCON', 'DEFCON'] : tag === 'CCON' ? ['DEFCON'] : [])
    }
    return con
  }
  const setNullable = (attr: El, nullable: boolean) => {
    const con = columnConstraint(attr, 'NNCON', !nullable)
    if (con) setOptional(con, 'VALUE', nullable ? '' : '1', ['CONLEVEL', 'CONTYPE', 'ATTRIBUTEIDS'])
  }
  const setDefault = (attr: El, value: string | null | undefined) => {
    const con = columnConstraint(attr, 'DEFCON', !!value)
    if (con) setOptional(con, 'VALUE', value ?? '', ['CONLEVEL', 'CONTYPE', 'ATTRIBUTEIDS'])
  }
  const constraintNames = (attr: El, table: string, column: string) => {
    for (const tag of ['NNCON', 'CCON', 'DEFCON']) {
      const con = kid(attr, tag)
      // Only names that follow their template are regenerated; a name somebody typed stays.
      if (con && text(con, 'NAME') && text(con, 'NAMETEMPLATE')) set(con, 'NAME', fromTemplate(text(con, 'NAMETEMPLATE'), { table, column }))
    }
  }
  const anyAttr = () => {
    for (const e of entities.values()) for (const a of e.attrs.values()) return a
    return undefined
  }
  const newAttr = (entity: Entity, table: string, column: ColumnInfo): El => {
    const id = newChildId([...entity.attrs.values()].map((a) => text(a, 'ID')))
    const template = [...entity.attrs.values()][0] ?? anyAttr()
    let attr: El
    if (template) {
      attr = clone(template, [[text(template, 'ID'), id]])
      // What belonged to the column it was copied from.
      for (const tag of ['PKGNAME', 'PKGITEM', 'COLLATE', 'AUTONUMBERDEFAULT', 'POSNR']) remove(attr, kid(attr, tag))
      for (const tag of ['DESC', 'NOTE', 'DESCRIPTION', 'DOMAINID']) if (kid(attr, tag)) set(attr, tag, '')
      for (const tag of ['NNCON', 'CCON', 'DEFCON']) {
        const con = kid(attr, tag)
        if (!con) continue
        remove(con, kid(con, 'VALUE'))
        if (kid(con, 'NAME')) set(con, 'NAME', '')
      }
    } else {
      const con = (tag: string, suffix: string, type: string) => container(tag, [leaf('NAME'), leaf('ID', `${id}-${suffix}`), leaf('CONLEVEL', '1'), leaf('CONTYPE', type), container('ATTRIBUTEIDS', [leaf('ATTRIBUTEID', id)])])
      attr = container('ATTR', [leaf('NAME'), leaf('ID', id), leaf('DESC'), leaf('DOMAINID'), container('DT', [leaf('DTLISTNAME'), leaf('SD', '1'), leaf('INC', '1')]), con('NNCON', 'NN', '5'), con('CCON', 'CC', '1'), con('DEFCON', 'DEF', '6')])
    }
    set(attr, 'NAME', column.name)
    setType(attr, column.dataType, column.isIdentity)
    setNullable(attr, column.nullable)
    setDefault(attr, column.defaultValue)
    if (column.comment) set(attr, 'DESC', column.comment, ['NOTE', 'DOMAINID', 'DT'])
    void table
    return attr
  }

  // --- tables -----------------------------------------------------------------------------------------------
  const baseByKey = new Map(baseline.map((t) => [tableKey(t), t]))
  const targetByKey = new Map(target.filter((t) => t.type === 'table').map((t) => [tableKey(t), t]))
  const pairs: { base: TableInfo; next: TableInfo; entity: Entity }[] = []
  const lostBase: TableInfo[] = []
  for (const [key, base] of baseByKey) {
    const entity = entities.get(key)
    if (!entity) continue
    const next = targetByKey.get(key)
    if (next) pairs.push({ base, next, entity })
    else lostBase.push(base)
  }
  let created = [...targetByKey.entries()].filter(([key]) => !baseByKey.has(key)).map(([, t]) => t)
  // A table that disappeared and one that appeared with mostly the same columns: a rename, not drop + create.
  const similarity = (a: TableInfo, b: TableInfo) => {
    const x = new Set(a.columns.map((c) => lower(c.name)))
    const shared = b.columns.filter((c) => x.has(lower(c.name))).length
    return shared / Math.max(1, x.size + b.columns.length - shared)
  }
  const dropped: TableInfo[] = []
  for (const base of lostBase) {
    const best = created.map((t) => ({ t, score: similarity(base, t) })).sort((a, b) => b.score - a.score)[0]
    const mutual = best && best.score >= 0.6 && !lostBase.some((other) => other !== base && similarity(other, best.t) > best.score)
    if (best && mutual) {
      pairs.push({ base, next: best.t, entity: entities.get(tableKey(base))! })
      created = created.filter((t) => t !== best.t)
    } else dropped.push(base)
  }

  /** Column names of the edited model → attribute ids, per table key of the edited model. */
  const attrIds = new Map<string, Map<string, string>>()
  /** The same for the model as it was opened. */
  const baseAttrIds = new Map<string, Map<string, string>>()
  const entityIds = new Map<string, string>()
  const baseEntityIds = new Map<string, string>()

  const syncColumns = (entity: Entity, base: TableInfo | undefined, next: TableInfo) => {
    const label = next.name
    const baseCols = base?.columns ?? []
    const baseIds = new Map([...entity.attrs].map(([name, a]) => [name, text(a, 'ID')]))
    const droppedIds: string[] = []
    const keep = new Map<ColumnInfo, El>()
    const matched = new Set<ColumnInfo>()
    for (const c of next.columns) {
      const b = baseCols.find((x) => lower(x.name) === lower(c.name))
      const attr = b && entity.attrs.get(lower(b.name))
      if (b && attr) {
        keep.set(c, attr)
        matched.add(b)
      }
    }
    const leftBase = baseCols.filter((b) => !matched.has(b) && entity.attrs.has(lower(b.name)))
    const leftNext = next.columns.filter((c) => !keep.has(c))
    // One column gone and one of the same type new in its place (or the only one gone and the only one new): a rename.
    // A different type means a different column: its checks, notes and domain must not move over.
    for (const c of leftNext) {
      const free = leftBase.filter((x) => !matched.has(x) && normType(x.dataType) === normType(c.dataType))
      const b = free.find((x) => x.ordinal === c.ordinal) ?? (free.length === 1 && leftNext.filter((x) => !keep.has(x) && normType(x.dataType) === normType(c.dataType)).length === 1 ? free[0] : undefined)
      if (!b) continue
      const attr = entity.attrs.get(lower(b.name))!
      set(attr, 'NAME', c.name)
      constraintNames(attr, label, c.name)
      keep.set(c, attr)
      matched.add(b)
      changes.push({ kind: 'rename_column', table: label, name: `${b.name} → ${c.name}` })
    }
    for (const b of baseCols.filter((x) => !matched.has(x))) {
      const attr = entity.attrs.get(lower(b.name))
      if (!attr) continue
      droppedIds.push(text(attr, 'ID'))
      remove(kid(entity.el, 'ATTRIBUTES'), attr)
      changes.push({ kind: 'drop_column', table: label, name: b.name })
    }
    let attributes = kid(entity.el, 'ATTRIBUTES')
    if (!attributes) insert(entity.el, (attributes = container('ATTRIBUTES', [])))
    for (const c of next.columns) {
      const existing = keep.get(c)
      if (!existing) {
        const attr = newAttr(entity, label, c)
        insert(attributes, attr)
        keep.set(c, attr)
        entity.attrs.set(lower(c.name), attr)
        if (base) changes.push({ kind: 'add_column', table: label, name: c.name })
        continue
      }
      const b = baseCols.find((x) => entity.attrs.get(lower(x.name)) === existing || lower(x.name) === lower(c.name))
      if (!b) continue
      let altered = false
      if (normType(b.dataType) !== normType(c.dataType) || b.isIdentity !== c.isIdentity) {
        setType(existing, c.dataType, c.isIdentity)
        altered = true
      }
      if (b.nullable !== c.nullable) {
        setNullable(existing, c.nullable)
        altered = true
      }
      if (normText(b.defaultValue) !== normText(c.defaultValue)) {
        setDefault(existing, c.defaultValue)
        altered = true
      }
      if (normText(b.comment) !== normText(c.comment)) {
        set(existing, 'DESC', c.comment ?? '', ['NOTE', 'DOMAINID', 'DT'])
        altered = true
      }
      if (b.name !== c.name && lower(b.name) === lower(c.name)) {
        set(existing, 'NAME', c.name)
        altered = true
      }
      if (altered) changes.push({ kind: 'alter_column', table: label, name: c.name })
    }
    const order = next.columns.map((c) => keep.get(c)!).filter(Boolean)
    const current = kids(attributes, 'ATTR')
    if (order.length === current.length && order.some((a, i) => a !== current[i])) fill(attributes, order)
    entity.attrs = new Map(next.columns.map((c) => [lower(c.name), keep.get(c)!]))

    const idOf = (name: string) => text(entity.attrs.get(lower(name)), 'ID')
    if (!base || base.primaryKey.map(lower).join(',') !== next.primaryKey.map(lower).join(',')) {
      let pk = kid(entity.el, 'PKCON')
      if (!pk) insert(entity.el, (pk = container('PKCON', [leaf('NAME'), leaf('ID', `${entity.id}-PK`), leaf('CONLEVEL', '2'), leaf('CONTYPE', '3'), container('ATTRIBUTEIDS', [])])), ['ATTRIBUTES'])
      setIds(pk, next.primaryKey.map(idOf).filter(Boolean))
      if (base) changes.push({ kind: 'set_primary_key', table: label, name: next.primaryKey.join(', ') })
    }

    // Unique constraints and indexes, compared by the ids of their columns (so a renamed column changes nothing).
    const nextIndexes = next.indexes.filter((ix) => !ix.primary)
    const baseIndexes = (base?.indexes ?? []).filter((ix) => !ix.primary)
    const keyOf = (unique: boolean, ids: (string | undefined)[]) => `${unique ? 'u' : 'i'}:${ids.join(',')}`
    const baseKeys = new Map(baseIndexes.map((ix) => [keyOf(ix.unique, ix.columns.map((c) => baseIds.get(lower(c)))), ix]))
    const nextKeys = new Map(nextIndexes.map((ix) => [keyOf(ix.unique, ix.columns.map(idOf)), ix]))
    const indexIds = (ix: El) => kids(kid(ix, 'IDXCOLS'), 'IDXCOL').map((c) => text(c, 'IDXCOLATTRID'))
    for (const [key, ix] of baseKeys) {
      if (nextKeys.has(key)) continue
      const constraints = kid(entity.el, 'CONSTRAINTS')
      const con = kids(constraints, 'CONSTRAINT').find((c) => text(c, 'CONTYPE') === '2' && keyOf(true, idsOf(c)) === key)
      const indexes = kid(entity.el, 'INDEXES')
      const index = kids(indexes, 'INDEX').find((i) => keyOf(/unique/i.test(text(i, 'INDEXTYPE')), indexIds(i)) === key)
      if (con) remove(constraints, con)
      else if (index) remove(indexes, index)
      else continue
      changes.push({ kind: 'drop_index', table: label, name: ix.columns.join(', ') })
    }
    for (const [key, ix] of nextKeys) {
      if (baseKeys.has(key)) continue
      addIndex(entity, label, ix)
      if (base) changes.push({ kind: 'add_index', table: label, name: ix.columns.join(', ') })
    }
    // Check constraints, compared by their condition. A column's own check that changed becomes a table check
    // (the same thing to the database); new ones list the columns their condition names.
    const exprKey = (e: string) => e.replace(/\s+/g, ' ').trim().toLowerCase()
    const baseChecks = new Set((base?.checks ?? []).map((c) => exprKey(c.expression)))
    const nextChecks = new Map((next.checks ?? []).map((c) => [exprKey(c.expression), c]))
    for (const key of baseChecks) {
      if (nextChecks.has(key)) continue
      const constraints = kid(entity.el, 'CONSTRAINTS')
      const tableCheck = kids(constraints, 'CONSTRAINT').find((c) => text(c, 'CONTYPE') === '1' && exprKey(text(c, 'VALUE')) === key)
      const columnCheck = kids(kid(entity.el, 'ATTRIBUTES'), 'ATTR').map((a) => kid(a, 'CCON')).find((c) => c && exprKey(text(c, 'VALUE')) === key)
      if (tableCheck) remove(constraints, tableCheck)
      else if (columnCheck) remove(columnCheck, kid(columnCheck, 'VALUE'))
      else continue
      changes.push({ kind: 'drop_check', table: label, name: key })
    }
    for (const [key, check] of nextChecks) {
      if (baseChecks.has(key)) continue
      let list = kid(entity.el, 'CONSTRAINTS')
      if (!list) insert(entity.el, (list = container('CONSTRAINTS', [])))
      const id = newChildId(kids(list, 'CONSTRAINT').map((c) => text(c, 'ID')))
      const template = anyOf((e) => kids(kid(e, 'CONSTRAINTS'), 'CONSTRAINT').find((c) => text(c, 'CONTYPE') === '1'))
      const con = template ? clone(template, [[text(template, 'ID'), id]]) : container('CONSTRAINT', [leaf('NAME'), leaf('ID', id), leaf('VALUE'), leaf('CONLEVEL', '2'), leaf('CONTYPE', '1'), container('ATTRIBUTEIDS', [])])
      for (const tag of ['DESC', 'NOTE']) if (kid(con, tag)) set(con, tag, '')
      set(con, 'NAME', check.name || `TCC_${label}_${kids(list, 'CONSTRAINT').length + 1}`)
      set(con, 'VALUE', check.expression, ['CONLEVEL', 'CONTYPE', 'ATTRIBUTEIDS'])
      const mentioned = new Set((check.expression.toLowerCase().match(/[a-z_][\w$]*/g) ?? []))
      setIds(con, next.columns.filter((c) => mentioned.has(lower(c.name))).map((c) => idOf(c.name)).filter(Boolean))
      insert(list, con)
      if (base) changes.push({ kind: 'add_check', table: label, name: check.expression })
    }
    // A dropped column also leaves whatever else listed it (automatic indexes, keys the model does not show).
    for (const id of droppedIds) {
      for (const con of [kid(entity.el, 'PKCON'), ...kids(kid(entity.el, 'CONSTRAINTS'), 'CONSTRAINT')]) if (con && idsOf(con).includes(id)) setIds(con, idsOf(con).filter((x) => x !== id))
      for (const con of kids(kid(entity.el, 'CONSTRAINTS'), 'CONSTRAINT')) if (text(con, 'CONTYPE') === '2' && !idsOf(con).length) remove(kid(entity.el, 'CONSTRAINTS'), con)
      for (const ix of kids(kid(entity.el, 'INDEXES'), 'INDEX')) {
        for (const col of kids(kid(ix, 'IDXCOLS'), 'IDXCOL')) if (text(col, 'IDXCOLATTRID') === id) remove(kid(ix, 'IDXCOLS'), col)
        if (!indexIds(ix).length) remove(kid(entity.el, 'INDEXES'), ix)
      }
    }
  }

  const anyOf = (pick: (entity: El) => El | undefined) => {
    for (const e of entities.values()) {
      const found = pick(e.el)
      if (found) return found
    }
    return undefined
  }
  const addIndex = (entity: Entity, table: string, ix: IndexInfo) => {
    const ids = ix.columns.map((c) => text(entity.attrs.get(lower(c)), 'ID')).filter(Boolean)
    if (ix.unique) {
      let list = kid(entity.el, 'CONSTRAINTS')
      if (!list) insert(entity.el, (list = container('CONSTRAINTS', [])))
      const id = newChildId(kids(list, 'CONSTRAINT').map((c) => text(c, 'ID')))
      const template = anyOf((e) => kids(kid(e, 'CONSTRAINTS'), 'CONSTRAINT').find((c) => text(c, 'CONTYPE') === '2'))
      const con = template ? clone(template, [[text(template, 'ID'), id]]) : container('CONSTRAINT', [leaf('NAME'), leaf('ID', id), leaf('CONLEVEL', '2'), leaf('CONTYPE', '2'), container('ATTRIBUTEIDS', [])])
      for (const tag of ['DESC', 'NOTE']) if (kid(con, tag)) set(con, tag, '')
      set(con, 'NAME', ix.name || `TUC_${table}_${kids(list, 'CONSTRAINT').length + 1}`)
      setIds(con, ids)
      insert(list, con)
      return
    }
    let list = kid(entity.el, 'INDEXES')
    if (!list) insert(entity.el, (list = container('INDEXES', [])))
    const id = newChildId(kids(list, 'INDEX').map((c) => text(c, 'ID')))
    const template = anyOf((e) => kids(kid(e, 'INDEXES'), 'INDEX').find((i) => text(i, 'AUTOIDXTYPE') === '0' || !kid(i, 'AUTOIDXTYPE')))
    const index = template ? clone(template, [[text(template, 'ID'), id]]) : container('INDEX', [leaf('NAME'), leaf('ID', id), leaf('RELID', '0'), leaf('AUTOIDXTYPE', '0'), container('IDXCOLS', [])])
    for (const tag of ['DESC', 'NOTE']) if (kid(index, tag)) set(index, tag, '')
    remove(index, kid(index, 'INDEXTYPE'))
    set(index, 'NAME', ix.name || `IDX_${table}_${kids(list, 'INDEX').length + 1}`)
    let cols = kid(index, 'IDXCOLS')
    if (!cols) insert(index, (cols = container('IDXCOLS', [])))
    const colTemplate = kids(cols, 'IDXCOL')[0]
    fill(
      cols,
      ix.columns.map((name, i) => {
        const col = colTemplate ? clone(colTemplate) : container('IDXCOL', [leaf('NAME'), leaf('ID', '0'), leaf('IDXCOLATTRID')])
        set(col, 'NAME', name)
        set(col, 'IDXCOLATTRID', ids[i] ?? '')
        return col
      }),
    )
    insert(list, index)
  }

  // --- diagram ----------------------------------------------------------------------------------------------
  const { layout } = source
  const toDezign = (p: { x: number; y: number }) => ({ l: Math.round(p.x / layout.scaleX + layout.originX), t: Math.round(p.y / layout.scaleY + layout.originY) })
  const mainControls = () => project.list('ENTC').filter((s) => !kid(s.el, 'DIAGRAMID') || !layout.diagramId || text(s.el, 'DIAGRAMID') === layout.diagramId)
  const controlsOf = (diagramId: string) => (diagramId === layout.diagramId ? mainControls() : project.list('ENTC').filter((c) => text(c.el, 'DIAGRAMID') === diagramId))
  const toDiagram = (diagramId: string, p: { x: number; y: number }) => {
    const l = diagramId === layout.diagramId ? layout : (source.diagrams.find((d) => d.id === diagramId)?.layout ?? { originX: 0, originY: 0, scaleX: 1, scaleY: 1 })
    return { l: Math.round(p.x / l.scaleX + l.originX), t: Math.round(p.y / l.scaleY + l.originY) }
  }
  const addControl = (entity: Entity, table: TableInfo, diagramId = layout.diagramId, wanted = options.positions?.[`${table.schema ?? ''}.${table.name}`]) => {
    const controls = controlsOf(diagramId)
    const template = controls[0]?.el ?? project.list('ENTC')[0]?.el
    const right = Math.max(0, ...controls.map((c) => Number(text(c.el, 'L')) + Number(text(c.el, 'W')) || 0))
    const top = controls.length ? Math.min(...controls.map((c) => Number(text(c.el, 'T')) || 0)) : 40
    const at = wanted ? toDiagram(diagramId, wanted) : { l: right + 60, t: top }
    const el = template
      ? clone(template)
      : container('ENTC', [leaf('ID'), leaf('DIAGRAMID', diagramId), leaf('W', '200'), leaf('H', '120'), leaf('L'), leaf('T'), leaf('AS', '1')])
    for (const tag of ['HIDDENATTR', 'ATTRCLIST', 'HEADERCOLOR']) if (kid(el, tag)) set(el, tag, '')
    set(el, 'ID', entity.id)
    if (kid(el, 'DIAGRAMID') || diagramId) set(el, 'DIAGRAMID', diagramId, ['W'])
    set(el, 'L', String(at.l))
    set(el, 'T', String(at.t))
    project.add('ENTC', el, controlFileName('entc', diagramId, entity.id))
  }

  // --- apply: tables ------------------------------------------------------------------------------------
  for (const base of dropped) {
    const entity = entities.get(tableKey(base))
    if (!entity) continue
    project.remove('ENT', entity.slot)
    for (const c of project.list('ENTC')) if (text(c.el, 'ID') === entity.id) project.remove('ENTC', c)
    // A supertype takes its subtype cluster along: the cluster, its link to the entity and their diagram objects.
    const clusters = project.list('SUBCAT').filter((x) => text(x.el, 'AOID') === entity.id)
    const clusterIds = new Set(clusters.map((x) => text(x.el, 'ID')))
    for (const cluster of clusters) project.remove('SUBCAT', cluster)
    for (const c of project.list('SUBCATC')) if (clusterIds.has(text(c.el, 'ID'))) project.remove('SUBCATC', c)
    for (const link of project.list('SUBCONN')) {
      if (text(link.el, 'PARENTOBJECTID') !== entity.id && !clusterIds.has(text(link.el, 'CHILDOBJECTID'))) continue
      const linkId = text(link.el, 'ID')
      project.remove('SUBCONN', link)
      for (const c of project.list('SUBCONNC')) if (text(c.el, 'ID') === linkId) project.remove('SUBCONNC', c)
    }
    for (const r of project.list('REL')) {
      if (text(r.el, 'PARENTOBJECTID') !== entity.id && text(r.el, 'CHILDOBJECTID') !== entity.id && !clusterIds.has(text(r.el, 'PARENTOBJECTID'))) continue
      const relId = text(r.el, 'ID')
      project.remove('REL', r)
      for (const c of project.list('RELC')) if (text(c.el, 'ID') === relId) project.remove('RELC', c)
    }
    entities.delete(tableKey(base))
    changes.push({ kind: 'drop_table', table: base.name })
  }

  for (const { base, next, entity } of pairs) {
    baseEntityIds.set(tableKey(base), entity.id)
    baseAttrIds.set(tableKey(base), new Map([...entity.attrs].map(([name, a]) => [name, text(a, 'ID')])))
    if (base.name !== next.name || (base.schema ?? '') !== (next.schema ?? '')) {
      set(entity.el, 'NAME', next.name)
      if ((base.schema ?? '') !== (next.schema ?? '')) set(entity.el, kid(entity.el, 'SCHEMANAME') ? 'SCHEMANAME' : 'SCHEMA', next.schema ?? '', ['DESC', 'NOTE', 'PKCON'])
      const pk = kid(entity.el, 'PKCON')
      if (pk && text(pk, 'NAME') && text(pk, 'NAMETEMPLATE')) set(pk, 'NAME', fromTemplate(text(pk, 'NAMETEMPLATE'), { table: next.name }))
      entities.delete(tableKey(base))
      entities.set(tableKey(next), entity)
      project.rename('ENT', entity.slot, entityFileName(entity.el))
      changes.push({ kind: 'rename_table', table: next.name, name: `${base.name} → ${next.name}` })
    }
    if (normText(base.comment) !== normText(next.comment)) {
      set(entity.el, 'DESC', next.comment ?? '', ['NOTE', 'PKCON', 'ATTRIBUTES'])
      changes.push({ kind: 'alter_table', table: next.name })
    }
    syncColumns(entity, base, next)
  }

  for (const table of created) {
    const id = newObjectId()
    const template = [...entities.values()][0]?.el
    let el: El
    if (template) {
      el = clone(template, [[text(template, 'ID'), id]])
      for (const tag of ['INDEXES', 'CONSTRAINTS', 'TRIGGERS', 'ABBR', 'DESCRIPTION', 'POSNR']) remove(el, kid(el, tag))
      for (const tag of ['DESC', 'NOTE', 'BEGINTABLESCR', 'ENDTABLESCR']) if (kid(el, tag)) set(el, tag, '')
      const attributes = kid(el, 'ATTRIBUTES')
      if (attributes) fill(attributes, [])
      const pk = kid(el, 'PKCON')
      if (pk) {
        setIds(pk, [])
        if (kid(pk, 'NAME')) set(pk, 'NAME', text(pk, 'NAMETEMPLATE') ? fromTemplate(text(pk, 'NAMETEMPLATE'), { table: table.name }) : '')
      }
    } else {
      el = container('ENT', [leaf('NAME'), leaf('ID', id), leaf('SCHEMA'), leaf('DESC'), container('PKCON', [leaf('NAME'), leaf('ID', `${id}-PK`), leaf('CONLEVEL', '2'), leaf('CONTYPE', '3'), container('ATTRIBUTEIDS', [])]), container('ATTRIBUTES', [])])
    }
    set(el, 'NAME', table.name)
    set(el, kid(el, 'SCHEMANAME') ? 'SCHEMANAME' : 'SCHEMA', table.schema ?? '', ['DESC', 'NOTE', 'PKCON'])
    if (table.comment) set(el, 'DESC', table.comment, ['NOTE', 'PKCON', 'ATTRIBUTES'])
    const entity: Entity = { slot: { el }, el, id, attrs: new Map() }
    syncColumns(entity, undefined, table)
    entity.slot = project.add('ENT', el, entityFileName(el))
    entities.set(tableKey(table), entity)
    addControl(entity, table)
    changes.push({ kind: 'add_table', table: table.name })
  }

  // Tables put on other diagrams (a new table drawn in a subject area belongs to it as well as to the main diagram).
  for (const [diagramId, wanted] of Object.entries(options.diagrams ?? {})) {
    if (diagramId === layout.diagramId) continue
    const shown = new Set(controlsOf(diagramId).map((c) => text(c.el, 'ID')))
    const positions = new Map(Object.entries(wanted.positions ?? {}).map(([key, p]) => [lower(key), p]))
    for (const key of (wanted.tables ?? []).map(lower)) {
      const entity = entities.get(key)
      const table = targetByKey.get(key)
      if (!entity || !table || shown.has(entity.id)) continue
      addControl(entity, table, diagramId, positions.get(key))
      shown.add(entity.id)
      if (!changes.some((x) => x.kind === 'add_table' && x.table === table.name)) changes.push({ kind: 'move_table', table: table.name })
    }
  }

  for (const [key, entity] of entities) {
    entityIds.set(key, entity.id)
    attrIds.set(key, new Map([...entity.attrs].map(([name, a]) => [name, text(a, 'ID')])))
  }

  // --- apply: relationships ---------------------------------------------------------------------------
  const subcategories = new Map(project.list('SUBCAT').map((s) => [text(s.el, 'ID'), text(s.el, 'AOID')]))
  const signatureOfRel = (el: El) => {
    const parent = text(el, 'PARENTOBJECTID')
    const pairsOf = kids(kid(el, 'PAIRS'), 'PAIR').map((p) => `${text(p, 'FOREIGNKEYID')}>${text(p, 'KEYID')}`)
    return `${text(el, 'CHILDOBJECTID')}|${subcategories.get(parent) ?? parent}|${pairsOf.join(',')}`
  }
  const signature = (table: TableInfo, fk: ForeignKeyInfo, ents: Map<string, string>, attrs: Map<string, Map<string, string>>) => {
    const child = tableKey(table)
    const parent = tableKey({ schema: fk.refSchema ?? table.schema, name: fk.refTable })
    const parentKey = ents.has(parent) ? parent : ([...ents.keys()].find((k) => k.endsWith(`.${lower(fk.refTable)}`)) ?? parent)
    const pairsOf = fk.columns.map((c, i) => `${attrs.get(child)?.get(lower(c)) ?? '?'}>${attrs.get(parentKey)?.get(lower(fk.refColumns[i] ?? '')) ?? '?'}`)
    return { sig: `${ents.get(child) ?? '?'}|${ents.get(parentKey) ?? '?'}|${pairsOf.join(',')}`, parentKey }
  }
  const before = new Map<string, { table: TableInfo; fk: ForeignKeyInfo }>()
  for (const { base } of pairs) for (const fk of base.foreignKeys.filter((f) => !f.virtual)) before.set(signature(base, fk, baseEntityIds, baseAttrIds).sig, { table: base, fk })
  const after = new Map<string, { table: TableInfo; fk: ForeignKeyInfo; parentKey: string }>()
  for (const table of target.filter((t) => t.type === 'table')) {
    for (const fk of table.foreignKeys.filter((f) => !f.virtual)) {
      const { sig, parentKey } = signature(table, fk, entityIds, attrIds)
      if (!sig.includes('?')) after.set(sig, { table, fk, parentKey })
    }
  }
  const ruleCode = (rule: string | undefined) => String(Math.max(0, DEZIGN_RULES.indexOf(rule?.toUpperCase() === 'NO ACTION' ? undefined : rule?.toUpperCase())))
  const sameRule = (a: string | undefined, b: string | undefined) => ruleCode(a) === ruleCode(b)

  for (const slot of project.list('REL')) {
    const sig = signatureOfRel(slot.el)
    const was = before.get(sig)
    const now = after.get(sig)
    if (was && !now) {
      const relId = text(slot.el, 'ID')
      project.remove('REL', slot)
      for (const c of project.list('RELC')) if (text(c.el, 'ID') === relId) project.remove('RELC', c)
      changes.push({ kind: 'drop_relationship', table: was.table.name, name: was.fk.refTable })
    } else if (was && now && (!sameRule(was.fk.onDelete, now.fk.onDelete) || !sameRule(was.fk.onUpdate, now.fk.onUpdate))) {
      set(slot.el, 'UPDATERULE', ruleCode(now.fk.onUpdate), ['DELETERULE', 'CONSTRAINT', 'PAIRS'])
      set(slot.el, 'DELETERULE', ruleCode(now.fk.onDelete), ['CONSTRAINT', 'PAIRS'])
      changes.push({ kind: 'alter_relationship', table: now.table.name, name: now.fk.refTable })
    }
  }
  const existing = new Set(project.list('REL').map((s) => signatureOfRel(s.el)))
  for (const [sig, { table, fk, parentKey }] of after) {
    if (before.has(sig) || existing.has(sig)) continue
    const child = entities.get(tableKey(table))!
    const parent = entities.get(parentKey)!
    const id = newObjectId()
    const template = project.list('REL').find((s) => kids(kid(s.el, 'PAIRS'), 'PAIR').length > 0)?.el
    const fkIds = fk.columns.map((c) => text(child.attrs.get(lower(c)), 'ID'))
    const keyIds = fk.refColumns.map((c) => text(parent.attrs.get(lower(c)), 'ID'))
    const el = template
      ? clone(template, [[text(template, 'ID'), id]])
      : container('REL', [
          leaf('NAME'),
          leaf('ID', id),
          leaf('PARENTOBJECTID'),
          leaf('CHILDOBJECTID'),
          leaf('VIRTUALREL', '0'),
          leaf('CARDINALITY', '0'),
          leaf('RELTYPE', '1'),
          leaf('MANDATORYPARENT', '0'),
          leaf('UPDATERULE', '0'),
          leaf('DELETERULE', '0'),
          container('CONSTRAINT', [leaf('NAME'), leaf('ID', `${id}-FK`), leaf('CONLEVEL', '2'), leaf('CONTYPE', '4'), container('ATTRIBUTEIDS', [])]),
          container('PAIRS', []),
        ])
    for (const tag of ['DESC', 'NOTE']) if (kid(el, tag)) set(el, tag, '')
    const parentName = text(parent.el, 'NAME')
    const name = text(el, 'NAMETEMPLATE') ? fromTemplate(text(el, 'NAMETEMPLATE'), { parent: parentName, child: table.name }) : `${parentName}_${table.name}`
    set(el, 'NAME', name)
    set(el, 'PARENTOBJECTID', parent.id)
    set(el, 'CHILDOBJECTID', child.id)
    if (kid(el, 'VIRTUALREL')) set(el, 'VIRTUALREL', '0')
    // 0 identifying (the key is part of the child's key), 1 non-identifying.
    set(el, 'RELTYPE', fk.columns.every((c) => table.primaryKey.map(lower).includes(lower(c))) ? '0' : '1', ['MANDATORYPARENT', 'UPDATERULE', 'DELETERULE', 'CONSTRAINT', 'PAIRS'])
    set(el, 'MANDATORYPARENT', fk.columns.every((c) => table.columns.find((x) => lower(x.name) === lower(c))?.nullable === false) ? '1' : '0', ['UPDATERULE', 'DELETERULE', 'CONSTRAINT', 'PAIRS'])
    set(el, 'UPDATERULE', ruleCode(fk.onUpdate), ['DELETERULE', 'CONSTRAINT', 'PAIRS'])
    set(el, 'DELETERULE', ruleCode(fk.onDelete), ['CONSTRAINT', 'PAIRS'])
    let constraint = kid(el, 'CONSTRAINT')
    if (!constraint) insert(el, (constraint = container('CONSTRAINT', [leaf('NAME'), leaf('ID', `${id}-FK`), leaf('CONLEVEL', '2'), leaf('CONTYPE', '4'), container('ATTRIBUTEIDS', [])])), ['PAIRS'])
    set(constraint, 'NAME', text(constraint, 'NAMETEMPLATE') ? fromTemplate(text(constraint, 'NAMETEMPLATE'), { relname: name, parent: parentName, child: table.name }) : name)
    setIds(constraint, fkIds)
    let pairList = kid(el, 'PAIRS')
    if (!pairList) insert(el, (pairList = container('PAIRS', [])))
    const pairTemplate = kids(pairList, 'PAIR')[0]
    fill(
      pairList,
      fkIds.map((fkId, i) => {
        const pair = pairTemplate ? clone(pairTemplate) : container('PAIR', [leaf('KEYID'), leaf('FOREIGNKEYID')])
        set(pair, 'KEYID', keyIds[i] ?? '')
        set(pair, 'FOREIGNKEYID', fkId)
        return pair
      }),
    )
    project.add('REL', el, relFileName(el))
    // A connector in every diagram that shows both tables, as a straight line between their middles.
    const connectorTemplate = project.list('RELC')[0]?.el
    const controls = project.list('ENTC')
    for (const diagramId of new Set(controls.map((c) => text(c.el, 'DIAGRAMID')))) {
      const of = (entityId: string) => controls.find((c) => text(c.el, 'ID') === entityId && text(c.el, 'DIAGRAMID') === diagramId)?.el
      const from = of(child.id)
      const to = of(parent.id)
      if (!from || !to) continue
      const middle = (c: El) => ({ x: Math.round(Number(text(c, 'L')) + Number(text(c, 'W')) / 2) || 0, y: Math.round(Number(text(c, 'T')) + Number(text(c, 'H')) / 2) || 0 })
      const connector = connectorTemplate ? clone(connectorTemplate) : container('RELC', [leaf('ID'), leaf('DIAGRAMID'), leaf('HIDDEN', '0'), container('POINTS', [])])
      remove(connector, kid(connector, 'ROUTING'))
      set(connector, 'ID', id)
      if (kid(connector, 'DIAGRAMID') || diagramId) set(connector, 'DIAGRAMID', diagramId, ['FONT', 'PEN', 'HIDDEN', 'POINTS'])
      if (kid(connector, 'HIDDEN')) set(connector, 'HIDDEN', '0')
      let points = kid(connector, 'POINTS')
      if (!points) insert(connector, (points = container('POINTS', [])))
      fill(points, [middle(from), middle(to)].map((p) => container('POINT', [leaf('X', String(p.x)), leaf('Y', String(p.y))])))
      project.add('RELC', connector, controlFileName('relc', diagramId, id))
    }
    changes.push({ kind: 'add_relationship', table: table.name, name: fk.refTable })
  }

  // --- apply: positions of tables moved in the diagram ----------------------------------------------------
  if (options.positions) {
    const idToKey = new Map([...entities].map(([key, e]) => [e.id, key]))
    const wanted = new Map(Object.entries(options.positions).map(([key, p]) => [lower(key), p]))
    for (const c of mainControls()) {
      const key = idToKey.get(text(c.el, 'ID'))
      const p = key ? wanted.get(key) : undefined
      if (!p) continue
      const at = toDezign(p)
      // Rounding through the scale moves nothing by itself.
      if (Math.abs(at.l - Number(text(c.el, 'L'))) <= 2 && Math.abs(at.t - Number(text(c.el, 'T'))) <= 2) continue
      set(c.el, 'L', String(at.l))
      set(c.el, 'T', String(at.t))
      const name = text(entities.get(key!)!.el, 'NAME')
      if (!changes.some((x) => x.kind === 'add_table' && x.table === name)) changes.push({ kind: 'move_table', table: name })
    }
  }

  for (const [diagramId, wanted] of Object.entries(options.diagrams ?? {})) {
    if (diagramId === layout.diagramId || !wanted.positions) continue
    const idToKey = new Map([...entities].map(([key, e]) => [e.id, key]))
    const positions = new Map(Object.entries(wanted.positions).map(([key, p]) => [lower(key), p]))
    for (const c of controlsOf(diagramId)) {
      const key = idToKey.get(text(c.el, 'ID'))
      const p = key ? positions.get(key) : undefined
      if (!p) continue
      const at = toDiagram(diagramId, p)
      if (Math.abs(at.l - Number(text(c.el, 'L'))) <= 2 && Math.abs(at.t - Number(text(c.el, 'T'))) <= 2) continue
      set(c.el, 'L', String(at.l))
      set(c.el, 'T', String(at.t))
      const name = text(entities.get(key!)!.el, 'NAME')
      if (!changes.some((x) => (x.kind === 'add_table' || x.kind === 'move_table') && x.table === name)) changes.push({ kind: 'move_table', table: name })
    }
  }

  // Text areas: new text and a new place for the ones the project already has.
  for (const [diagramId, wanted] of Object.entries(options.diagrams ?? {})) {
    for (const note of wanted.notes ?? []) {
      const area = project.list('TEXTAR').find((x) => text(x.el, 'ID') === note.id)
      const control = project.list('TEXTC').find((c) => text(c.el, 'ID') === note.id && (!kid(c.el, 'DIAGRAMID') || text(c.el, 'DIAGRAMID') === diagramId))
      if (!area || !control) continue
      let changed = false
      if (normText(text(area.el, 'TEXT')) !== normText(note.text)) {
        set(area.el, 'TEXT', note.text)
        changed = true
      }
      const at = toDiagram(diagramId, note)
      if (Math.abs(at.l - Number(text(control.el, 'L'))) > 2 || Math.abs(at.t - Number(text(control.el, 'T'))) > 2) {
        set(control.el, 'L', String(at.l))
        set(control.el, 'T', String(at.t))
        changed = true
      }
      if (changed) changes.push({ kind: 'alter_note', table: note.text.split(/\r?\n/)[0]!.slice(0, 40) })
    }
  }

  const out = project.result()
  verify(files, out, target, { encoding: source.encoding, normalize: options.normalize })
  return { ...out, changes }
}

/** The files a project would consist of after `result` is written. */
export function applyDezignSave(files: DezignFile[], result: { files: DezignFile[]; deleted: string[] }): DezignFile[] {
  const norm = (p: string) => p.replaceAll('\\', '/')
  const map = new Map(files.map((f) => [norm(f.path), f]))
  for (const d of result.deleted) map.delete(norm(d))
  for (const f of result.files) map.set(norm(f.path), f)
  return [...map.values()]
}

/** Reads the result back and compares it with what was asked for: a wrong file is never handed to the caller. */
function verify(files: DezignFile[], result: { files: DezignFile[]; deleted: string[] }, target: TableInfo[], options: { encoding: DezignEncoding; normalize?: (tables: TableInfo[]) => TableInfo[] }): void {
  const after = applyDezignSave(files, result)
  const folder = after.some((f) => /\.dezproj$/i.test(f.path) && !/[\\/]/.test(f.path))
  let model: DezignModel
  const binary = (set: DezignFile[]) => (folder ? assembleDezignProject(set) : set[0]!.text)
  try {
    model = readDezign(binary(after), { encoding: options.encoding })
    // Nothing may point nowhere that did not before (a relationship of a dropped column, a control of a dropped table…).
    const before = new Set(dezignIntegrity(binary(files)))
    const broken = dezignIntegrity(binary(after)).filter((p) => !before.has(p))
    if (broken.length) throw new Error(broken[0])
  } catch (err) {
    throw new Error(`The DeZign file could not be written safely (${err instanceof Error ? err.message : String(err)}). Nothing was changed.`)
  }
  const describe = (tables: TableInfo[]) =>
    tables
      .filter((t) => t.type === 'table')
      .map((t) => {
        const cols = t.columns.map((c) => `${lower(c.name)} ${normType(c.dataType)}${c.nullable ? '' : ' nn'}${c.isIdentity ? ' id' : ''}${normText(c.defaultValue) ? ` =${normText(c.defaultValue)}` : ''}${normText(c.comment) ? ` #${normText(c.comment)}` : ''}`)
        const fks = t.foreignKeys.filter((f) => !f.virtual).map((f) => `${f.columns.map(lower).join(',')}>${lower(f.refTable)}(${f.refColumns.map(lower).join(',')})`)
        const indexes = t.indexes.filter((ix) => !ix.primary).map(indexKey)
        const checks = (t.checks ?? []).map((c) => `check ${c.expression.replace(/\s+/g, ' ').trim().toLowerCase()}`)
        return [tableKey(t), `pk(${t.primaryKey.map(lower).join(',')})`, normText(t.comment), ...cols, ...fks.sort(), ...indexes.sort(), ...checks.sort()].join('\n  ')
      })
      .sort()
  const want = describe(target)
  const got = describe(options.normalize ? options.normalize(model.tables) : model.tables)
  const wrong = want.find((w, i) => w !== got[i]) ?? (got.length !== want.length ? got[want.length] : undefined)
  // Local debugging of the writer against public sample models.
  if (wrong !== undefined && typeof process !== 'undefined' && process.env.DBM_DEZ_DEBUG) console.log(`WANT\n${wrong}\nGOT\n${got[want.indexOf(wrong)] ?? '(nothing)'}`)
  if (wrong !== undefined) throw new Error(`The DeZign file could not be written safely: table "${wrong.split('\n')[0]}" would not read back as edited. Nothing was changed.`)
}

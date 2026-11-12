import {
  assembleDezignProject,
  DEZIGN_RULES,
  dezignIntegrity,
  dezignChild as kid,
  dezignChildren as kids,
  dezignDecoder,
  parseDezignXml,
  readDezign,
  serializeDezignXml,
  unescapeDezignText,
  DEZIGN_COLUMNS_SHOWN,
  type DezignDisplay,
  type DezignElement,
  type DezignEncoding,
  type DezignModel,
} from './dezign.js'
import { defaultFkName } from './dbml.js'
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
 * The output is checked by reading it back. Every kind of edit was also opened in DeZign 14.9.3 and saved there
 * again as the same model (`dezign-kit.test.ts` with DBM_DEZ_KIT_BACK, `scripts/dezign-check`).
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
  | 'rename_index'
  | 'add_check'
  | 'drop_check'
  | 'rename_check'
  | 'add_relationship'
  | 'drop_relationship'
  | 'alter_relationship'
  | 'rename_relationship'
  | 'move_table'
  | 'alter_note'
  | 'add_diagram'
  | 'add_to_diagram'
  | 'remove_from_diagram'
  | 'add_note'
  | 'drop_note'
  | 'color_table'
  | 'diagram_display'
  | 'add_domain'
  | 'alter_domain'
  | 'add_box'
  | 'drop_box'
  | 'alter_box'
  | 'rename_diagram'
  | 'drop_diagram'

export interface DezignChange {
  kind: DezignChangeKind
  table: string
  /** Column, index columns or referenced table. */
  name?: string
  /**
   * The attribute package the changed column was taken out of. DeZign keeps a column inherited from a package
   * the same as the package says (it cannot be edited there): one that was changed here is its table's own now.
   */
  detached?: string
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
   * diagrams other than the main one; and the text areas and table colors of any diagram. Tables are never
   * taken off a diagram.
   */
  diagrams?: Record<
    string,
    {
      /** Given for a diagram that is not in the project yet: it is created with this name. */
      name?: string
      tables?: string[]
      /** `tables` is the whole list: tables not on it are taken off the diagram (never out of the model). */
      exact?: boolean
      positions?: Record<string, { x: number; y: number }>
      /** All the text areas the diagram should have: others are removed from it, unknown ids are new ones. */
      notes?: { id: string; text: string; x: number; y: number }[]
      /** Fill colors to change, by table key: `#rrggbb`, or null for the project's usual color. */
      colors?: Record<string, string | null>
      /** What the tables show (see `DezignDisplay`); `hidden` lists every table whose hidden columns change. */
      display?: Partial<DezignDisplay>
      /** Takes the diagram out of the project, with everything drawn on it (never the main diagram). */
      remove?: boolean
      /** All the group boxes the diagram should have, as `DezignDiagram.boxes` (unknown ids are new ones). */
      boxes?: { id: string; title: string; x: number; y: number; w: number; h: number }[]
    }
  >
  /** Ids for new objects (default: random GUIDs, or the next number in files that number their objects). */
  newId?: () => string
  /**
   * Domains (named types) to change or make, by name. A changed type is written into the domain and, through the
   * model, into every column that follows it; a name the project does not have makes a new domain.
   */
  domains?: { name: string; dataType: string; comment?: string | null }[]
  /**
   * Brings a model read from DeZign into the representation of `baseline` and `target` (for DBML documents: a
   * round trip through DBML). The written project is read back through it and compared with `target`.
   */
  normalize?: (tables: TableInfo[]) => TableInfo[]
}

type El = DezignElement
type Kind = 'DOMAIN' | 'ENT' | 'REL' | 'ENTC' | 'RELC' | 'DIAGRAM' | 'SUBCAT' | 'SUBCONN' | 'SUBCATC' | 'SUBCONNC' | 'TEXTAR' | 'TEXTC' | 'VIEWCONN' | 'VIEWCONNC' | 'GROUPBOX' | 'GROUPBOXC'

interface Slot {
  el: El
  /** Folder projects: the object's file. */
  path?: string
}

const SINGLE: Record<Kind, string[]> = {
  DOMAIN: ['DATADICT', 'DOMAINS'],
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
  VIEWCONN: ['DATADICT', 'VIEWCONNECTIONS'],
  VIEWCONNC: ['DIAGRAMS', 'CONTROLS', 'VIEWCONNECTORS'],
  GROUPBOX: ['DATADICT', 'GROUPBOXES'],
  GROUPBOXC: ['DIAGRAMS', 'CONTROLS', 'GROUPBOXESCONTROLS'],
}
const FOLDER: Record<Kind, string> = {
  DOMAIN: 'data dictionary/domains',
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
  VIEWCONN: 'data dictionary/viewconnections',
  VIEWCONNC: 'diagrams/diagramobjects/viewconnectors',
  GROUPBOX: 'data dictionary/groupboxes',
  GROUPBOXC: 'diagrams/diagramobjects/groupboxcontrols',
}

const DIAGRAM_OBJECT_DIRS = ['diagrams/diagramobjects/stampcontrols', 'diagrams/diagramobjects/viewcontrols']

const lower = (s: string) => s.toLowerCase()
const tableKey = (t: { schema?: string; name: string }) => lower(`${t.schema ?? ''}.${t.name}`)
const normType = (s: string) => lower(s).replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').replace(/\s*\(\s*/g, '(').replace(/\s*\)/g, ')').trim()
const normText = (s: string | null | undefined) => (s ?? '').replace(/\r\n?/g, '\n').trim()
const indexKey = (ix: { unique: boolean; columns: string[] }) => `${ix.unique ? 'u' : 'i'}:${ix.columns.map(lower).join(',')}`

export function codec(encoding: DezignEncoding, nl: string) {
  const decoder = dezignDecoder(encoding)
  const toByte = new Map<string, string>()
  if (encoding !== 'utf-8') {
    for (let b = 0x80; b <= 0xff; b++) {
      const ch = decoder.decode(Uint8Array.of(b))
      if (ch !== '�' && !toByte.has(ch)) toByte.set(ch, String.fromCharCode(b))
    }
  }
  /**
   * Text as the document's code page can hold it. A character it does not have becomes what DeZign, which works
   * in that code page, would hold itself: the letter without its diacritic, or `?`. A character reference is not
   * a way out: DeZign 14.9.3 shows `&#345;` as typed and saves it as `&amp;#345;`.
   */
  const fit = (value: string): string => {
    if (encoding === 'utf-8' || !/[^\x00-\x7f]/.test(value)) return value
    let out = ''
    for (const ch of value) {
      if (ch.codePointAt(0)! < 0x80 || toByte.has(ch)) out += ch
      else {
        const plain = ch.normalize('NFD').replace(/\p{M}/gu, '')
        out += plain && [...plain].every((c) => c.codePointAt(0)! < 0x80 || toByte.has(c)) ? plain : '?'
      }
    }
    return out
  }
  return {
    decode: (s: string) => (/[\x80-\xff]/.test(s) ? decoder.decode(Uint8Array.from(s, (c) => c.charCodeAt(0))) : s),
    fit,
    /** Text as it goes into the file: DeZign's escapes, its line ends, the document's code page. */
    encode(value: string): string {
      const escaped = value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replace(/\r\n?|\n/g, nl)
      if (encoding === 'utf-8') return Array.from(new TextEncoder().encode(escaped), (b) => String.fromCharCode(b)).join('')
      let out = ''
      for (const ch of fit(escaped)) out += ch.codePointAt(0)! < 0x80 ? ch : toByte.get(ch)!
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
      // (Group boxes, stamps and views on diagrams are only ever removed with their diagram.)
      if ((!kind && !DIAGRAM_OBJECT_DIRS.includes(dir)) || !/\.xml$/i.test(path)) continue
      this.docs.set(path, { root: parseDezignXml(f.text), original: f.text })
      if (kind && !this.dirs.has(kind)) this.dirs.set(kind, path.slice(0, path.lastIndexOf('/')))
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
      // DeZign keeps the elements of one kind together and in its own order (every DIAGRAM before the CONTROLS):
      // a new one goes after the last of its kind, or before what must follow.
      const last = parent.children.findLastIndex((c) => typeof c !== 'string' && c.tag === el.tag)
      const follower = last === -1 && el.tag === 'DIAGRAM' ? parent.children.findIndex((c) => typeof c !== 'string' && c.tag === 'CONTROLS') : -1
      if (last !== -1) parent.children.splice(last + 1, 0, this.nl, el)
      else if (follower !== -1) parent.children.splice(follower, 0, el, this.nl)
      else parent.children.push(el, this.nl)
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

  /** The group boxes, stamps and views drawn on a diagram (kinds the writer does not otherwise touch). */
  removeDiagramObjects(diagramId: string): void {
    const onIt = (el: El) => (el.children.some((c) => typeof c !== 'string' && c.tag === 'DIAGRAMID' && c.children.join('').trim() === diagramId))
    if (!this.folder) {
      const controls = kid(kid(this.version, 'DIAGRAMS'), 'CONTROLS')
      for (const list of ['STAMPCONTROLS', 'VIEWCONTROLS']) {
        const parent = kid(controls, list)
        if (!parent) continue
        for (const el of kids(parent).filter(onIt)) {
          const i = parent.children.indexOf(el)
          const next = parent.children[i + 1]
          parent.children.splice(i, typeof next === 'string' && !next.trim() ? 2 : 1)
        }
      }
      return
    }
    for (const [path, doc] of this.docs) {
      const dir = lower(path.slice(0, Math.max(0, path.lastIndexOf('/'))))
      if (!DIAGRAM_OBJECT_DIRS.includes(dir)) continue
      const el = kids(doc.root)[0]
      if (el && onIt(el)) this.deleted.add(path)
    }
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

  /**
   * The highest number used as an id anywhere in the working model. Files that number their objects share one
   * counter between all kinds of them (tables, relationships, text areas, group boxes…), so the next id has to
   * be above everything, not just above the kinds this writer knows.
   */
  /** An element of a single-file project by its path under the model (`['DATADICT']`); none in a folder project. */
  section(path: string[]): El | undefined {
    let el = this.version
    for (const tag of path) el = kid(el, tag)
    return el
  }

  highestNumber(): number {
    let max = 0
    const walk = (el: El) => {
      for (const child of kids(el)) {
        if (child.tag === 'ID') {
          const value = child.children.filter((c) => typeof c === 'string').join('').trim()
          if (/^\d{1,15}$/.test(value)) max = Math.max(max, Number(value))
        } else walk(child)
      }
    }
    if (this.version) walk(this.version)
    for (const [path, doc] of this.docs) if (!this.deleted.has(path)) walk(doc.root)
    return max
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
export function saveToDezign(files: DezignFile[], given: TableInfo[], wanted: TableInfo[], options: SaveDezignOptions = {}): DezignSaveResult {
  const project = new Project(files)
  const assembled = project.folder ? assembleDezignProject(files) : files[0]!.text
  const source = readDezign(assembled, { encoding: options.encoding, fallbackEncoding: options.fallbackEncoding, node: options.node })
  const { nl } = project
  const { decode, encode, fit } = codec(source.encoding, nl)
  // The model as the document's code page can hold it: what is compared, written and read back is the same text,
  // so saving the saved model again changes nothing.
  const fitted = (tables: TableInfo[]): TableInfo[] => (JSON.stringify(tables) === fit(JSON.stringify(tables)) ? tables : (JSON.parse(JSON.stringify(tables), (_, value: unknown) => (typeof value === 'string' ? fit(value) : value)) as TableInfo[]))
  const [baseline, target] = [fitted(given), fitted(wanted)]
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
  /**
   * What a copied element must not take from the one it was copied from: its labels and its custom properties
   * (a new column next to one labelled "PII" is not personal data because of where it was copied from).
   */
  const forget = (el: El) => {
    remove(el, kid(el, 'OBJLABELS'))
    if (kid(el, 'USERDEFPROPS')) set(el, 'USERDEFPROPS', '')
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
  /** `NAME` and, in projects that have name templates, the `NAMETEMPLATE` DeZign writes next to it. */
  const named = (setting: string): El[] => (source.nameTemplates[setting] ? [leaf('NAME'), leaf('NAMETEMPLATE', source.nameTemplates[setting])] : [leaf('NAME')])
  const fromTemplate = (template: string, values: Record<string, string>) => template.replace(/%(\w+)%/g, (whole, key: string) => values[lower(key)] ?? whole)
  const pattern = (setting: string) => source.nameTemplates[setting] ?? ''
  /** Whether `name` is what the pattern gives for these values (`%counter%` is any number). */
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const fits = (template: string, name: string, values: Record<string, string>) => {
    const parts = template.split(/(%\w+%)/).map((part) => (!/^%\w+%$/.test(part) ? literal(part) : lower(part) === '%counter%' ? '\\d+' : values[lower(part.slice(1, -1))] !== undefined ? literal(values[lower(part.slice(1, -1))]!) : '.*'))
    return new RegExp(`^${parts.join('')}$`).test(name)
  }
  /**
   * DeZign makes a name from its template again when it opens a project: with the project's pattern next to a
   * name somebody typed, the typed name is gone (DeZign 14.9.3 turned our `ix_invoice_customer` into
   * `IDX_invoice_1`). DeZign's own files keep a typed name as its own template, so that is what is written;
   * a name the project's pattern gives keeps the pattern.
   */
  const setName = (el: El, name: string, setting: string, values: Record<string, string>) => {
    set(el, 'NAME', name)
    if (kid(el, 'NAMETEMPLATE')) set(el, 'NAMETEMPLATE', pattern(setting) && fits(pattern(setting), name, values) ? pattern(setting) : name)
  }
  /** A copied element named after its neighbour's own typed name goes back to the project's pattern. */
  const ownTemplate = (el: El, setting: string) => {
    if (text(el, 'NAMETEMPLATE') && !text(el, 'NAMETEMPLATE').includes('%')) set(el, 'NAMETEMPLATE', pattern(setting))
  }
  const columnSetting = (tag: string) => (tag === 'NNCON' ? 'NOTNULLCONNAMETEMPLATE' : tag === 'CCON' ? 'CCONNAMETEMPLATE' : 'DEFAULTCONNAMETEMPLATE')

  // --- ids --------------------------------------------------------------------------------------------------
  const allIds = [...project.list('ENT'), ...project.list('REL'), ...project.list('SUBCAT'), ...project.list('DIAGRAM')].map((s) => text(s.el, 'ID'))
  const numbered = allIds.length > 0 && allIds.every((id) => /^\d+$/.test(id))
  let lastNumber = numbered ? project.highestNumber() : 0
  const firstNumber = lastNumber
  /** The highest numeric id among a table's columns, indexes and constraints (see the counters at the end). */
  const childNumbers = (el: El) => [kids(kid(el, 'ATTRIBUTES'), 'ATTR'), kids(kid(el, 'INDEXES'), 'INDEX'), kids(kid(el, 'CONSTRAINTS'), 'CONSTRAINT')].map((list) => Math.max(0, ...list.map((x) => text(x, 'ID')).filter((id) => /^\d+$/.test(id)).map(Number)))
  const numbersBefore = new Map(project.list('ENT').map((e) => [e.el, childNumbers(e.el)]))
  const randomId = options.newId ?? (() => globalThis.crypto.randomUUID().toUpperCase())
  const newObjectId = () => (numbered ? String(++lastNumber) : randomId())
  const newChildId = (siblings: string[]) => (siblings.length ? siblings.every((id) => /^\d+$/.test(id)) : numbered) ? String(Math.max(0, ...siblings.map(Number)) + 1) : randomId()
  /**
   * The id of a new attribute or index. Projects that came to DeZign 14 from an older version keep numbers for
   * tables and give attributes and indexes ids that are unique in the whole project: `ATTR-<table>-<n>-<token>`.
   * A plain number there is renumbered when DeZign opens the file, and what pointed at it from another table is
   * lost (DeZign 14.9.3 dropped the columns of a new relationship that way).
   */
  const styled = (kind: 'ATTR' | 'IDX') => new RegExp(`^${kind}-.+-(\\d+)-[^-]+$`)
  const usesStyled = (kind: 'ATTR' | 'IDX') =>
    project.list('ENT').some((e) => (kind === 'ATTR' ? kids(kid(e.el, 'ATTRIBUTES'), 'ATTR') : kids(kid(e.el, 'INDEXES'), 'INDEX')).some((x) => styled(kind).test(text(x, 'ID'))))
  const styledAttrs = usesStyled('ATTR')
  const styledIndexes = usesStyled('IDX') || (styledAttrs && !project.list('ENT').some((e) => kids(kid(e.el, 'INDEXES'), 'INDEX').length))
  let idToken = ''
  const styledChildId = (kind: 'ATTR' | 'IDX', entityId: string, siblings: string[]) => {
    const own = siblings.filter((id) => styled(kind).test(id))
    if (!(own.length || (!siblings.length && (kind === 'ATTR' ? styledAttrs : styledIndexes)))) return newChildId(siblings)
    idToken ||= randomId().replace(/[^0-9A-Za-z]/g, '').slice(0, 16)
    return `${kind}-${entityId}-${Math.max(0, ...own.map((id) => Number(styled(kind).exec(id)![1]))) + 1}-${idToken}`
  }

  // --- the project's entities -----------------------------------------------------------------------------
  const entityOf = (slot: Slot): Entity => {
    const attrs = new Map<string, El>()
    for (const a of kids(kid(slot.el, 'ATTRIBUTES'), 'ATTR')) attrs.set(lower(text(a, 'NAME')), a)
    return { slot, el: slot.el, id: text(slot.el, 'ID'), attrs }
  }
  const schemaOf = (el: El) => text(el, 'SCHEMA') || text(el, 'SCHEMANAME') || undefined
  const entities = new Map<string, Entity>()
  for (const slot of project.list('ENT')) entities.set(tableKey({ schema: schemaOf(slot.el), name: text(slot.el, 'NAME') }), entityOf(slot))
  const everyAttr = () => [...entities.values()].flatMap((e) => [...e.attrs.values()])
  // "No domain" is -1 in the files of DeZign 4 to 6 and empty since: a column is taken off its domain the file's way.
  const noDomain = everyAttr().some((a) => text(a, 'DOMAINID') === '-1') ? '-1' : ''
  /** A column constraint of that kind from anywhere in the project, as the shape for a new one. */
  const anyConstraint = (tag: string): El | undefined => {
    for (const a of everyAttr()) if (kid(a, tag)) return kid(a, tag)
    return undefined
  }
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
    // ENUM('a','b') and SET(…) keep their values in ITMS.
    const listed = m ? null : /^(\w+)\s*\((.*')\s*\)$/s.exec(dataType.trim())
    set(dt, 'DTLISTNAME', (m?.[1] ?? listed?.[1] ?? dataType).trim().toUpperCase(), ['LE', 'PR', 'SD', 'INC', 'AN'])
    setOptional(dt, 'LE', m?.[2] ?? '', ['PR', 'SD', 'INC', 'AN'])
    setOptional(dt, 'PR', m?.[3] ?? '', ['SD', 'INC', 'AN'])
    setOptional(dt, 'ITMS', listed?.[2] ?? '', [])
    setOptional(dt, 'AN', identity ? '1' : '', [])
    // A column with its own type no longer follows a domain.
    if (kid(attr, 'DOMAINID')) set(attr, 'DOMAINID', noDomain)
  }
  // Old formats write a column's constraint elements only when they hold something.
  const CONSTRAINTS = { NNCON: ['NN', '5'], CCON: ['CC', '1'], DEFCON: ['DEF', '6'] } as const
  const columnConstraint = (attr: El, tag: keyof typeof CONSTRAINTS, create: boolean): El | undefined => {
    let con = kid(attr, tag)
    if (!con && create) {
      const id = text(attr, 'ID')
      const own = /^\d+$/.test(id) ? '0' : `${id}-${CONSTRAINTS[tag][0]}`
      // Shaped like the column constraints the file already has (of this kind, or of another: they differ only in
      // their type and value), so it carries whatever this DeZign version writes into one.
      const like = anyConstraint(tag) ?? anyConstraint('NNCON') ?? anyConstraint('DEFCON') ?? anyConstraint('CCON')
      if (like) {
        con = clone(like)
        Object.assign(con, { tag, open: `<${tag}>`, close: `</${tag}>` })
        remove(con, kid(con, 'VALUE'))
        if (kid(con, 'NAME')) set(con, 'NAME', '')
        if (kid(con, 'NAMETEMPLATE') && like.tag !== tag) set(con, 'NAMETEMPLATE', pattern(columnSetting(tag)))
        else ownTemplate(con, columnSetting(tag))
        set(con, 'ID', own)
        set(con, 'CONTYPE', CONSTRAINTS[tag][1])
        setIds(con, [id])
      } else con = container(tag, [leaf('NAME'), leaf('ID', own), leaf('CONLEVEL', '1'), leaf('CONTYPE', CONSTRAINTS[tag][1]), container('ATTRIBUTEIDS', [leaf('ATTRIBUTEID', id)])])
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
  // Domains of the project by name: a column that follows one has its id and a copy of its type.
  const domainsByName = new Map(project.list('DOMAIN').map((d) => [lower(text(d.el, 'NAME')), d.el]))
  // Domains first: the columns that follow one take its type from it.
  for (const wanted of options.domains ?? []) {
    if (!wanted.name.trim() || !wanted.dataType.trim()) continue
    const existing = domainsByName.get(lower(wanted.name))
    const typeOf = (el: El) => {
      const dt = kid(el, 'DT')
      return (text(dt, 'DTLISTNAME').toLowerCase() + (text(dt, 'LE') ? `(${text(dt, 'LE')}${text(dt, 'PR') ? `,${text(dt, 'PR')}` : ''})` : '')).trim()
    }
    if (existing) {
      let changed = false
      if (normType(typeOf(existing)) !== normType(wanted.dataType)) {
        // (An auto-numbered domain stays one.)
        setType(existing, wanted.dataType, text(kid(existing, 'DT'), 'AN') === '1')
        changed = true
      }
      if (wanted.comment !== undefined && normText(text(existing, 'DESC')) !== normText(wanted.comment)) {
        set(existing, 'DESC', wanted.comment ?? '', ['NOTE', 'DT'])
        changed = true
      }
      if (changed) changes.push({ kind: 'alter_domain', table: text(existing, 'NAME'), name: wanted.dataType })
      continue
    }
    const sample = project.list('DOMAIN')[0]
    const id = newObjectId()
    const el = sample ? clone(sample.el, [[text(sample.el, 'ID'), id]]) : container('DOMAIN', [leaf('NAME'), leaf('ID', id), leaf('SCHEMA'), leaf('DESC'), leaf('NOTE'), container('DT', [leaf('DTLISTNAME'), leaf('SD', '0'), leaf('INC', '1')])])
    // What belonged to the domain it was copied from.
    for (const tag of ['NNCON', 'CCON', 'DEFCON']) remove(el, kid(el, tag))
    for (const tag of ['DESC', 'NOTE']) if (kid(el, tag)) set(el, tag, '')
    forget(el)
    set(el, 'NAME', wanted.name)
    set(el, 'ID', id)
    if (wanted.comment) set(el, 'DESC', wanted.comment, ['NOTE', 'DT'])
    setType(el, wanted.dataType, false)
    project.add('DOMAIN', el, sample && project.fileStem(sample) === text(sample.el, 'ID') ? id : wanted.name)
    domainsByName.set(lower(wanted.name), el)
    changes.push({ kind: 'add_domain', table: wanted.name, name: wanted.dataType })
  }
  /** Takes a column out of the attribute package it was inherited from (see `DezignChange.detached`). */
  const detach = (attr: El): { detached?: string } => {
    const name = text(attr, 'PKGNAME')
    if (!name) return {}
    for (const tag of ['PKGNAME', 'PKGITEM']) remove(attr, kid(attr, tag))
    return { detached: name }
  }
  /** A column's collation sits right after its type, and only when it has one. */
  const setCollation = (attr: El, collation: string | undefined) => setOptional(attr, 'COLLATE', collation ?? '', ['NNCON', 'CCON', 'DEFCON'])
  const setDomain = (attr: El, table: string, column: ColumnInfo) => {
    if (!column.domain) {
      if (kid(attr, 'DOMAINID') && text(attr, 'DOMAINID') !== noDomain && text(attr, 'DOMAINID') !== '-1') set(attr, 'DOMAINID', noDomain)
      return
    }
    const domain = domainsByName.get(lower(column.domain))
    if (!domain) throw new Error(`${table}.${column.name}: the project has no domain "${column.domain}" (it has: ${[...domainsByName.values()].map((d) => text(d, 'NAME')).join(', ') || 'none'}). Domains are made in DeZign; remove the setting to give the column its own type.`)
    const dt = kid(domain, 'DT')
    const type = (text(dt, 'DTLISTNAME').toLowerCase() + (text(dt, 'LE') ? `(${text(dt, 'LE')}${text(dt, 'PR') ? `,${text(dt, 'PR')}` : ''})` : text(dt, 'ITMS') ? `(${text(dt, 'ITMS')})` : '')).trim()
    if (type && normType(type) !== normType(column.dataType)) {
      throw new Error(`${table}.${column.name} follows the domain "${column.domain}", whose type is ${type}, but is typed ${column.dataType}. Change one of them: remove the domain setting for a type of its own.`)
    }
    set(attr, 'DOMAINID', text(domain, 'ID'), ['DT', 'NNCON', 'CCON', 'DEFCON'])
    // The column carries a copy of the domain's type, as DeZign writes it.
    const own = kid(attr, 'DT')
    if (dt && own) own.children = clone(dt).children
  }

  const anyAttr = () => {
    for (const e of entities.values()) for (const a of e.attrs.values()) return a
    return undefined
  }
  const newAttr = (entity: Entity, table: string, column: ColumnInfo): El => {
    const id = styledChildId('ATTR', entity.id, [...entity.attrs.values()].map((a) => text(a, 'ID')))
    const template = [...entity.attrs.values()][0] ?? anyAttr()
    let attr: El
    if (template) {
      attr = clone(template, [[text(template, 'ID'), id]])
      // What belonged to the column it was copied from.
      for (const tag of ['PKGNAME', 'PKGITEM', 'COLLATE', 'CHARSET', 'AUTONUMBERDEFAULT']) remove(attr, kid(attr, tag))
      // (Not UNSIGNED or ZEROFILL because the column it was copied from is.)
      for (const holder of [attr, kid(attr, 'DT')]) for (const tag of ['UNS', 'ZF']) if (holder && kid(holder, tag)) set(holder, tag, '0')
      forget(attr)
      for (const tag of ['DESC', 'NOTE', 'DESCRIPTION']) if (kid(attr, tag)) set(attr, tag, '')
      if (kid(attr, 'DOMAINID')) set(attr, 'DOMAINID', noDomain)
      for (const tag of ['NNCON', 'CCON', 'DEFCON']) {
        const con = kid(attr, tag)
        if (!con) continue
        remove(con, kid(con, 'VALUE'))
        if (kid(con, 'NAME')) set(con, 'NAME', '')
        ownTemplate(con, columnSetting(tag))
      }
    } else {
      const con = (tag: string, suffix: string, type: string) => container(tag, [...named(tag === 'NNCON' ? 'NOTNULLCONNAMETEMPLATE' : tag === 'CCON' ? 'CCONNAMETEMPLATE' : 'DEFAULTCONNAMETEMPLATE'), leaf('ID', `${id}-${suffix}`), leaf('CONLEVEL', '1'), leaf('CONTYPE', type), container('ATTRIBUTEIDS', [leaf('ATTRIBUTEID', id)])])
      attr = container('ATTR', [leaf('NAME'), leaf('ID', id), leaf('DESC'), leaf('DOMAINID'), container('DT', [leaf('DTLISTNAME'), leaf('SD', '1'), leaf('INC', '1')]), con('NNCON', 'NN', '5'), con('CCON', 'CC', '1'), con('DEFCON', 'DEF', '6')])
    }
    set(attr, 'NAME', column.name)
    setType(attr, column.dataType, column.isIdentity)
    setNullable(attr, column.nullable)
    setDefault(attr, column.defaultValue)
    if (column.comment) set(attr, 'DESC', column.comment, ['NOTE', 'DOMAINID', 'DT'])
    if (column.domain) setDomain(attr, table, column)
    if (column.collation) setCollation(attr, column.collation)
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
    const orphanedChecks: string[] = []
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
      changes.push({ kind: 'rename_column', table: label, name: `${b.name} → ${c.name}`, ...detach(attr) })
    }
    for (const b of baseCols.filter((x) => !matched.has(x))) {
      const attr = entity.attrs.get(lower(b.name))
      if (!attr) continue
      droppedIds.push(text(attr, 'ID'))
      // The column's own check goes with it; if the model still has that check, it comes back as the table's.
      const own = text(kid(attr, 'CCON'), 'VALUE')
      if (own) orphanedChecks.push(own)
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
      // What the column is (as opposed to what is said about it).
      let typed = false
      if (normType(b.dataType) !== normType(c.dataType) || b.isIdentity !== c.isIdentity) {
        setType(existing, c.dataType, c.isIdentity)
        altered = typed = true
      }
      // After the type: a column that follows a domain takes the domain's type, and one that left it keeps its own.
      if ((b.domain ?? '') !== (c.domain ?? '') || (c.domain && altered)) {
        setDomain(existing, label, c)
        altered = typed = true
      }
      if ((b.collation ?? '') !== (c.collation ?? '')) {
        setCollation(existing, c.collation)
        altered = typed = true
      }
      if (b.nullable !== c.nullable) {
        setNullable(existing, c.nullable)
        altered = typed = true
      }
      if (normText(b.defaultValue) !== normText(c.defaultValue)) {
        setDefault(existing, c.defaultValue)
        altered = typed = true
      }
      if (normText(b.comment) !== normText(c.comment)) {
        set(existing, 'DESC', c.comment ?? '', ['NOTE', 'DOMAINID', 'DT'])
        altered = true
      }
      if (b.name !== c.name && lower(b.name) === lower(c.name)) {
        set(existing, 'NAME', c.name)
        altered = typed = true
      }
      // (A new description is the column's own business: DeZign keeps the package's type, not what is said about it.)
      if (altered) changes.push({ kind: 'alter_column', table: label, name: c.name, ...(typed ? detach(existing) : {}) })
    }
    const order = next.columns.map((c) => keep.get(c)!).filter(Boolean)
    const current = kids(attributes, 'ATTR')
    if (order.length === current.length && order.some((a, i) => a !== current[i])) fill(attributes, order)
    entity.attrs = new Map(next.columns.map((c) => [lower(c.name), keep.get(c)!]))

    const idOf = (name: string) => text(entity.attrs.get(lower(name)), 'ID')
    if (!base || base.primaryKey.map(lower).join(',') !== next.primaryKey.map(lower).join(',')) {
      let pk = kid(entity.el, 'PKCON')
      if (!pk) insert(entity.el, (pk = container('PKCON', [...named('PKCONNAMETEMPLATE'), leaf('ID', `${entity.id}-PK`), leaf('CONLEVEL', '2'), leaf('CONTYPE', '3'), container('ATTRIBUTEIDS', [])])), ['ATTRIBUTES'])
      setIds(pk, next.primaryKey.map(idOf).filter(Boolean))
      if (base) changes.push({ kind: 'set_primary_key', table: label, name: next.primaryKey.join(', ') })
    }

    // Unique constraints and indexes, compared by the ids of their columns (so a renamed column changes nothing).
    const nextIndexes = next.indexes.filter((ix) => !ix.primary)
    const baseIndexes = (base?.indexes ?? []).filter((ix) => !ix.primary)
    const keyOf = (unique: boolean, ids: (string | undefined)[]) => `${unique ? 'u' : 'i'}:${ids.join(',')}`
    // Counted, not just listed: a model can hold two indexes on the same columns, and each is one in the file.
    const byKey = (list: IndexInfo[], key: (ix: IndexInfo) => string) => {
      const map = new Map<string, IndexInfo[]>()
      for (const ix of list) map.set(key(ix), [...(map.get(key(ix)) ?? []), ix])
      return map
    }
    const baseKeys = byKey(baseIndexes, (ix) => keyOf(ix.unique, ix.columns.map((c) => baseIds.get(lower(c)))))
    const nextKeys = byKey(nextIndexes, (ix) => keyOf(ix.unique, ix.columns.map(idOf)))
    const indexIds = (ix: El) => kids(kid(ix, 'IDXCOLS'), 'IDXCOL').map((c) => text(c, 'IDXCOLATTRID'))
    const constraintsFor = (key: string) => kids(kid(entity.el, 'CONSTRAINTS'), 'CONSTRAINT').filter((c) => text(c, 'CONTYPE') === '2' && keyOf(true, idsOf(c)) === key)
    const indexesFor = (key: string) => kids(kid(entity.el, 'INDEXES'), 'INDEX').filter((i) => keyOf(/unique/i.test(text(i, 'INDEXTYPE')), indexIds(i)) === key)
    for (const [key, list] of baseKeys) {
      for (const ix of list.slice(nextKeys.get(key)?.length ?? 0)) {
        // Of a unique constraint and a unique index on the same columns, the index goes first.
        const index = indexesFor(key)[0]
        const con = constraintsFor(key)[0]
        if (index) remove(kid(entity.el, 'INDEXES'), index)
        else if (con) remove(kid(entity.el, 'CONSTRAINTS'), con)
        else continue
        changes.push({ kind: 'drop_index', table: label, name: ix.columns.join(', ') })
      }
    }
    for (const [key, list] of nextKeys) {
      for (const ix of list.slice(baseKeys.get(key)?.length ?? 0)) {
        // A second unique on the same columns cannot be another constraint: two of those read as one.
        addIndex(entity, label, ix, ix.unique && constraintsFor(key).length > 0)
        if (base) changes.push({ kind: 'add_index', table: label, name: ix.columns.join(', ') })
      }
    }
    // The same index or unique constraint under another name.
    if (base) {
      for (const [key, list] of nextKeys) {
        const before = baseKeys.get(key) ?? []
        const elements = [...indexesFor(key), ...constraintsFor(key)]
        list.slice(0, before.length).forEach((ix, i) => {
          const old = before[i]!
          const el = ix.name && old.name && ix.name !== old.name ? elements.find((e) => text(e, 'NAME') === old.name) : undefined
          if (!el) return
          setName(el, ix.name, el.tag === 'INDEX' ? 'INDEXNAMETEMPLATE' : 'TUCONNAMETEMPLATE', { table: next.name })
          changes.push({ kind: 'rename_index', table: label, name: `${old.name} → ${ix.name}` })
        })
      }
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
    const orphaned = new Set(orphanedChecks.map(exprKey))
    // The same condition under another name.
    for (const old of base?.checks ?? []) {
      const now = nextChecks.get(exprKey(old.expression))
      if (!now?.name || !old.name || now.name === old.name || orphaned.has(exprKey(old.expression))) continue
      const tableCheck = kids(kid(entity.el, 'CONSTRAINTS'), 'CONSTRAINT').find((c) => text(c, 'CONTYPE') === '1' && text(c, 'NAME') === old.name)
      const column = kids(kid(entity.el, 'ATTRIBUTES'), 'ATTR').find((a) => text(kid(a, 'CCON'), 'NAME') === old.name && exprKey(text(kid(a, 'CCON'), 'VALUE')) === exprKey(old.expression))
      if (tableCheck) setName(tableCheck, now.name, 'TCCONNAMETEMPLATE', { table: next.name })
      else if (column) setName(kid(column, 'CCON')!, now.name, 'CCONNAMETEMPLATE', { table: next.name, column: text(column, 'NAME') })
      else continue
      changes.push({ kind: 'rename_check', table: label, name: `${old.name} → ${now.name}` })
    }
    for (const [key, check] of nextChecks) {
      if (baseChecks.has(key) && !orphaned.has(key)) continue
      let list = kid(entity.el, 'CONSTRAINTS')
      if (!list) insert(entity.el, (list = container('CONSTRAINTS', [])))
      const id = newChildId(kids(list, 'CONSTRAINT').map((c) => text(c, 'ID')))
      const con = tableConstraint('1', id)
      for (const tag of ['DESC', 'NOTE']) if (kid(con, tag)) set(con, tag, '')
      const counter = String(kids(list, 'CONSTRAINT').length + 1)
      setName(con, check.name || fromTemplate(pattern('TCCONNAMETEMPLATE') || 'TCC_%table%_%counter%', { table: next.name, counter }), 'TCCONNAMETEMPLATE', { table: next.name })
      set(con, 'VALUE', check.expression, ['CONLEVEL', 'CONTYPE', 'ATTRIBUTEIDS'])
      const mentioned = new Set((check.expression.toLowerCase().match(/[a-z_][\w$]*/g) ?? []))
      setIds(con, next.columns.filter((c) => mentioned.has(lower(c.name))).map((c) => idOf(c.name)).filter(Boolean))
      insert(list, con)
      if (base && !orphaned.has(key)) changes.push({ kind: 'add_check', table: label, name: check.expression })
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

  /**
   * A new check ('1') or unique ('2') constraint of a table, shaped like one the project has: of the same kind,
   * or else any constraint of a table or of a relationship (they hold the same fields), so it carries whatever
   * this DeZign version writes into a constraint.
   */
  const tableConstraint = (type: '1' | '2', id: string): El => {
    const sameKind = anyOf((e) => kids(kid(e, 'CONSTRAINTS'), 'CONSTRAINT').find((c) => text(c, 'CONTYPE') === type))
    const like = sameKind ?? anyOf((e) => kids(kid(e, 'CONSTRAINTS'), 'CONSTRAINT')[0]) ?? project.list('REL').map((r) => kid(r.el, 'CONSTRAINT')).find(Boolean)
    const setting = type === '1' ? 'TCCONNAMETEMPLATE' : 'TUCONNAMETEMPLATE'
    if (!like) return container('CONSTRAINT', [...named(setting), leaf('ID', id), ...(type === '1' ? [leaf('VALUE')] : []), leaf('CONLEVEL', '2'), leaf('CONTYPE', type), container('ATTRIBUTEIDS', [])])
    const con = clone(like)
    set(con, 'ID', id, ['POSNR', 'SCHEMA', 'DESC', 'NOTE', 'VALUE', 'CONLEVEL', 'CONTYPE', 'ATTRIBUTEIDS'])
    if (like !== sameKind) {
      remove(con, kid(con, 'VALUE'))
      set(con, 'CONLEVEL', '2', ['CONTYPE', 'ATTRIBUTEIDS'])
      set(con, 'CONTYPE', type, ['ATTRIBUTEIDS'])
      if (kid(con, 'NAMETEMPLATE')) set(con, 'NAMETEMPLATE', source.nameTemplates[setting] ?? '')
      setIds(con, [])
    }
    return con
  }
  const anyOf = (pick: (entity: El) => El | undefined) => {
    for (const e of entities.values()) {
      const found = pick(e.el)
      if (found) return found
    }
    return undefined
  }
  /** A unique index is written as a unique constraint (the form DeZign's own files use most) unless told otherwise. */
  const addIndex = (entity: Entity, table: string, ix: IndexInfo, asIndex = false) => {
    const ids = ix.columns.map((c) => text(entity.attrs.get(lower(c)), 'ID')).filter(Boolean)
    if (ix.unique && !asIndex) {
      let list = kid(entity.el, 'CONSTRAINTS')
      if (!list) insert(entity.el, (list = container('CONSTRAINTS', [])))
      const id = newChildId(kids(list, 'CONSTRAINT').map((c) => text(c, 'ID')))
      const con = tableConstraint('2', id)
      for (const tag of ['DESC', 'NOTE']) if (kid(con, tag)) set(con, tag, '')
      const counter = String(kids(list, 'CONSTRAINT').length + 1)
      setName(con, ix.name || fromTemplate(pattern('TUCONNAMETEMPLATE') || 'TUC_%table%_%counter%', { table, counter }), 'TUCONNAMETEMPLATE', { table })
      setIds(con, ids)
      insert(list, con)
      return
    }
    let list = kid(entity.el, 'INDEXES')
    // (DeZign keeps a table's indexes before its triggers and constraints.)
    if (!list) insert(entity.el, (list = container('INDEXES', [])), ['TRIGGERS', 'CONSTRAINTS'])
    const id = styledChildId('IDX', entity.id, kids(list, 'INDEX').map((c) => text(c, 'ID')))
    // Shaped like an index somebody made in this project, or else like one DeZign made itself (for a key): the
    // same element, turned into an ordinary index.
    const own = anyOf((e) => kids(kid(e, 'INDEXES'), 'INDEX').find((i) => text(i, 'AUTOIDXTYPE') === '0' || !kid(i, 'AUTOIDXTYPE')))
    const template = own ?? anyOf((e) => kids(kid(e, 'INDEXES'), 'INDEX')[0])
    const index = template ? clone(template, [[text(template, 'ID'), id]]) : container('INDEX', [...named('INDEXNAMETEMPLATE'), leaf('ID', id), leaf('RELID', '0'), leaf('AUTOIDXTYPE', '0'), container('IDXCOLS', [])])
    if (template && template !== own) {
      set(index, 'ID', id)
      if (kid(index, 'AUTOIDXTYPE')) set(index, 'AUTOIDXTYPE', '0')
      if (kid(index, 'RELID')) set(index, 'RELID', '0')
      if (kid(index, 'NAMETEMPLATE')) set(index, 'NAMETEMPLATE', source.nameTemplates.INDEXNAMETEMPLATE ?? '')
    }
    for (const tag of ['DESC', 'NOTE']) if (kid(index, tag)) set(index, tag, '')
    forget(index)
    remove(index, kid(index, 'INDEXTYPE'))
    if (ix.unique) insert(index, leaf('INDEXTYPE', 'UNIQUE'), ['RELID', 'AUTOIDXTYPE', 'IDXCOLS'])
    setName(index, ix.name || fromTemplate(pattern('INDEXNAMETEMPLATE') || 'IDX_%table%_%counter%', { table, counter: String(kids(list, 'INDEX').length + 1) }), 'INDEXNAMETEMPLATE', { table })
    let cols = kid(index, 'IDXCOLS')
    if (!cols) insert(index, (cols = container('IDXCOLS', [])))
    const colTemplate = kids(cols, 'IDXCOL')[0] ?? anyOf((e) => kids(kid(e, 'INDEXES'), 'INDEX').flatMap((i) => kids(kid(i, 'IDXCOLS'), 'IDXCOL'))[0])
    fill(
      cols,
      ix.columns.map((name, i) => {
        // (DeZign 14 names an index column by its attribute alone; older formats also keep the name.)
        const col = colTemplate ? clone(colTemplate) : container('IDXCOL', Number(source.formatVersion) >= 140 ? [leaf('IDXCOLATTRID')] : [leaf('NAME'), leaf('ID', '0'), leaf('IDXCOLATTRID')])
        if (kid(col, 'NAME')) set(col, 'NAME', name)
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
      : container('ENTC', [leaf('ID'), leaf('DIAGRAMID', diagramId), leaf('W', '200'), leaf('H', '120'), leaf('L'), leaf('T'), leaf('BRUSH', '0,16119285'), leaf('PEN', '0,1,4,10987431'), leaf('FONT', 'Arial,8,,0,clWindowText,0'), leaf('TR', '0'), leaf('AS', '1'), leaf('ROUNDED', '8'), ...(Number(source.formatVersion) >= 140 ? [leaf('HEADERCOLOR', '16446189')] : [])])
    for (const tag of ['HIDDENATTR', 'ATTRCLIST']) if (kid(el, tag)) set(el, tag, '')
    // DeZign reads numbers without a default: one empty number and the project does not open at all
    // ("'' is not a valid integer value"). A new table gets the header its diagram's tables usually have.
    if (kid(el, 'HEADERCOLOR')) {
      const seen = new Map<string, number>()
      for (const c of controls.length ? controls : project.list('ENTC')) {
        const color = text(c.el, 'HEADERCOLOR')
        if (/^\d+$/.test(color)) seen.set(color, (seen.get(color) ?? 0) + 1)
      }
      const usual = [...seen].sort((a, b) => b[1] - a[1])[0]?.[0]
      if (usual) set(el, 'HEADERCOLOR', usual)
    }
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
    // The lines DeZign 14.5+ draws from a view to the tables it reads (the view itself stays as it is written).
    for (const link of project.list('VIEWCONN')) {
      if (text(link.el, 'PARENTOBJECTID') !== entity.id && text(link.el, 'CHILDOBJECTID') !== entity.id) continue
      const linkId = text(link.el, 'ID')
      project.remove('VIEWCONN', link)
      for (const c of project.list('VIEWCONNC')) if (text(c.el, 'ID') === linkId) project.remove('VIEWCONNC', c)
    }
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

  /** Tables renamed in this save: id → the name they had. */
  const renamed = new Map<string, string>()
  for (const { base, next, entity } of pairs) {
    baseEntityIds.set(tableKey(base), entity.id)
    baseAttrIds.set(tableKey(base), new Map([...entity.attrs].map(([name, a]) => [name, text(a, 'ID')])))
    if (base.name !== next.name || (base.schema ?? '') !== (next.schema ?? '')) {
      set(entity.el, 'NAME', next.name)
      if ((base.schema ?? '') !== (next.schema ?? '')) set(entity.el, kid(entity.el, 'SCHEMANAME') ? 'SCHEMANAME' : 'SCHEMA', next.schema ?? '', ['DESC', 'NOTE', 'PKCON'])
      const pk = kid(entity.el, 'PKCON')
      if (pk && text(pk, 'NAME') && text(pk, 'NAMETEMPLATE')) set(pk, 'NAME', fromTemplate(text(pk, 'NAMETEMPLATE'), { table: next.name }))
      // Names DeZign made from a pattern follow the table, as they do when DeZign opens the project: an index or
      // a constraint keeps its number. (A typed name is its own template and stays.)
      if (base.name !== next.name) {
        renamed.set(entity.id, base.name)
        for (const el of [...kids(kid(entity.el, 'INDEXES'), 'INDEX'), ...kids(kid(entity.el, 'CONSTRAINTS'), 'CONSTRAINT')]) {
          const template = text(el, 'NAMETEMPLATE')
          const parts = template.split(/(%\w+%)/)
          if (!/%table%/i.test(template) || parts.some((part) => /^%\w+%$/.test(part) && !['%table%', '%counter%'].includes(lower(part)))) continue
          const made = new RegExp(`^${parts.map((part) => (lower(part) === '%table%' ? literal(base.name) : lower(part) === '%counter%' ? '(\\d+)' : literal(part))).join('')}$`).exec(text(el, 'NAME'))
          if (made) set(el, 'NAME', fromTemplate(template, { table: next.name, counter: made[1] ?? '' }))
        }
      }
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
      for (const tag of ['ABBR', 'DESCRIPTION']) if (kid(el, tag)) set(el, tag, '')
      // The lists stay, emptied: a DeZign version that writes them into every table writes them into an empty one too.
      for (const tag of ['INDEXES', 'CONSTRAINTS', 'TRIGGERS']) {
        const list = kid(el, tag)
        if (list) fill(list, [])
      }
      for (const tag of ['DESC', 'NOTE', 'BEGINTABLESCR', 'ENDTABLESCR']) if (kid(el, tag)) set(el, tag, '')
      forget(el)
      const attributes = kid(el, 'ATTRIBUTES')
      if (attributes) fill(attributes, [])
      const pk = kid(el, 'PKCON')
      if (pk) {
        setIds(pk, [])
        ownTemplate(pk, 'PKCONNAMETEMPLATE')
        if (kid(pk, 'NAME')) set(pk, 'NAME', text(pk, 'NAMETEMPLATE') ? fromTemplate(text(pk, 'NAMETEMPLATE'), { table: table.name }) : '')
      }
    } else {
      el = container('ENT', [leaf('NAME'), leaf('ID', id), leaf('SCHEMA'), leaf('DESC'), container('PKCON', [...named('PKCONNAMETEMPLATE'), leaf('ID', `${id}-PK`), leaf('CONLEVEL', '2'), leaf('CONTYPE', '3'), container('ATTRIBUTEIDS', [])]), container('ATTRIBUTES', [])])
    }
    set(el, 'NAME', table.name)
    // A key made here is named by the project's template, as DeZign names one.
    const madeKey = kid(el, 'PKCON')
    if (!template && madeKey && table.primaryKey.length && text(madeKey, 'NAMETEMPLATE')) set(madeKey, 'NAME', fromTemplate(text(madeKey, 'NAMETEMPLATE'), { table: table.name }))
    set(el, kid(el, 'SCHEMANAME') ? 'SCHEMANAME' : 'SCHEMA', table.schema ?? '', ['DESC', 'NOTE', 'PKCON'])
    if (table.comment) set(el, 'DESC', table.comment, ['NOTE', 'PKCON', 'ATTRIBUTES'])
    const entity: Entity = { slot: { el }, el, id, attrs: new Map() }
    syncColumns(entity, undefined, table)
    entity.slot = project.add('ENT', el, entityFileName(el))
    entities.set(tableKey(table), entity)
    addControl(entity, table)
    changes.push({ kind: 'add_table', table: table.name })
  }

  // Diagrams that are asked for and not in the project yet are made like a neighbour; from here on every diagram
  // goes by its id in the file.
  const diagramRequests: [id: string, wanted: NonNullable<SaveDezignOptions['diagrams']>[string]][] = []
  for (const [key, wanted] of Object.entries(options.diagrams ?? {})) {
    const existing = project.list('DIAGRAM')
    const known = existing.find((d) => text(d.el, 'ID') === key)
    if (known && wanted.remove && text(known.el, 'ISMAINDIAGRAM') !== '1' && key !== layout.diagramId) {
      // Everything drawn on it goes with it; the tables, notes and frames themselves stay in the project.
      const name = text(known.el, 'NAME')
      for (const kind of ['ENTC', 'RELC', 'TEXTC', 'SUBCATC', 'SUBCONNC', 'VIEWCONNC', 'GROUPBOXC'] as const) for (const c of project.list(kind)) if (text(c.el, 'DIAGRAMID') === key) project.remove(kind, c)
      project.removeDiagramObjects(key)
      project.remove('DIAGRAM', known)
      changes.push({ kind: 'drop_diagram', table: name })
      continue
    }
    if (key === layout.diagramId || known || wanted.name === undefined) {
      // A diagram of the project under a new name.
      if (known && wanted.name !== undefined && wanted.name.trim() && wanted.name !== text(known.el, 'NAME')) {
        const was = text(known.el, 'NAME')
        set(known.el, 'NAME', wanted.name)
        changes.push({ kind: 'rename_diagram', table: wanted.name, name: was })
      }
      diagramRequests.push([key, wanted])
      continue
    }
    const id = newObjectId()
    const template = (existing.find((d) => text(d.el, 'ISMAINDIAGRAM') !== '1') ?? existing[0])?.el
    const el = template ? clone(template, [[text(template, 'ID'), id]]) : container('DIAGRAM', [leaf('ID', id), leaf('NAME'), leaf('ISMAINDIAGRAM', '0')])
    for (const tag of ['DESC', 'TODO']) if (kid(el, tag)) set(el, tag, '')
    set(el, 'NAME', wanted.name)
    set(el, 'ISMAINDIAGRAM', '0', ['BGCOLOR', 'DISPLAYLEVEL'])
    if (kid(el, 'POSNR')) set(el, 'POSNR', String(existing.length))
    project.add('DIAGRAM', el, id)
    diagramRequests.push([id, wanted])
    changes.push({ kind: 'add_diagram', table: wanted.name })
  }
  const diagramName = (id: string) => text(project.list('DIAGRAM').find((d) => text(d.el, 'ID') === id)?.el, 'NAME')

  // Which tables the other diagrams show (a new table drawn in a subject area belongs to it as well as to the main
  // diagram). A table taken off a diagram takes the relationship lines that ended at it along.
  const membershipChanged = new Set<string>()
  for (const [diagramId, wanted] of diagramRequests) {
    if (diagramId === layout.diagramId || !wanted.tables) continue
    const shown = new Set(controlsOf(diagramId).map((c) => text(c.el, 'ID')))
    const positions = new Map(Object.entries(wanted.positions ?? {}).map(([key, p]) => [lower(key), p]))
    const keep = new Set<string>()
    for (const key of wanted.tables.map(lower)) {
      const entity = entities.get(key)
      const table = targetByKey.get(key)
      if (!entity || !table) continue
      keep.add(entity.id)
      if (shown.has(entity.id)) continue
      addControl(entity, table, diagramId, positions.get(key))
      shown.add(entity.id)
      membershipChanged.add(diagramId)
      if (!changes.some((x) => x.kind === 'add_table' && x.table === table.name)) changes.push({ kind: 'add_to_diagram', table: table.name, name: diagramName(diagramId) })
    }
    if (!wanted.exact) continue
    const entityNames = new Map([...entities.values()].map((e) => [e.id, text(e.el, 'NAME')]))
    for (const control of controlsOf(diagramId)) {
      const id = text(control.el, 'ID')
      // Only tables of the model: views and whatever else sits on the diagram are not ours to take off.
      if (keep.has(id) || !entityNames.has(id)) continue
      project.remove('ENTC', control)
      membershipChanged.add(diagramId)
      changes.push({ kind: 'remove_from_diagram', table: entityNames.get(id)!, name: diagramName(diagramId) })
    }
  }

  for (const [key, entity] of entities) {
    entityIds.set(key, entity.id)
    attrIds.set(key, new Map([...entity.attrs].map(([name, a]) => [name, text(a, 'ID')])))
  }

  /** Draws a relationship on a diagram that shows both its tables and does not have the line yet: straight, between their middles. */
  const addConnector = (relId: string, diagramId: string, childId: string, parentId: string) => {
    const controls = project.list('ENTC')
    const of = (entityId: string) => controls.find((c) => text(c.el, 'ID') === entityId && text(c.el, 'DIAGRAMID') === diagramId)?.el
    const from = of(childId)
    const to = of(parentId)
    if (!from || !to || project.list('RELC').some((c) => text(c.el, 'ID') === relId && text(c.el, 'DIAGRAMID') === diagramId)) return
    const connectorTemplate = project.list('RELC')[0]?.el
    const middle = (c: El) => ({ x: Math.round(Number(text(c, 'L')) + Number(text(c, 'W')) / 2) || 0, y: Math.round(Number(text(c, 'T')) + Number(text(c, 'H')) / 2) || 0 })
    const connector = connectorTemplate ? clone(connectorTemplate) : container('RELC', [leaf('ID'), leaf('DIAGRAMID'), leaf('FONT', 'Arial,8,,0,clWindowText,0'), leaf('PEN', '1,1,4,0'), container('POINTS', [])])
    remove(connector, kid(connector, 'ROUTING'))
    set(connector, 'ID', relId)
    if (kid(connector, 'DIAGRAMID') || diagramId) set(connector, 'DIAGRAMID', diagramId, ['FONT', 'PEN', 'HIDDEN', 'POINTS'])
    if (kid(connector, 'HIDDEN')) set(connector, 'HIDDEN', '0')
    let points = kid(connector, 'POINTS')
    if (!points) insert(connector, (points = container('POINTS', [])))
    fill(points, [middle(from), middle(to)].map((p) => container('POINT', [leaf('X', String(p.x)), leaf('Y', String(p.y))])))
    project.add('RELC', connector, controlFileName('relc', diagramId, relId))
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
  // Counted by signature, not just listed: a model can hold the same relationship twice, and each is one in the file.
  const push = <T,>(map: Map<string, T[]>, key: string, value: T) => map.set(key, [...(map.get(key) ?? []), value])
  const before = new Map<string, { table: TableInfo; fk: ForeignKeyInfo }[]>()
  for (const { base } of pairs) for (const fk of base.foreignKeys.filter((f) => !f.virtual)) push(before, signature(base, fk, baseEntityIds, baseAttrIds).sig, { table: base, fk })
  const after = new Map<string, { table: TableInfo; fk: ForeignKeyInfo; parentKey: string }[]>()
  for (const table of target.filter((t) => t.type === 'table')) {
    for (const fk of table.foreignKeys.filter((f) => !f.virtual)) {
      const { sig, parentKey } = signature(table, fk, entityIds, attrIds)
      if (!sig.includes('?')) push(after, sig, { table, fk, parentKey })
    }
  }
  const ruleCode = (rule: string | undefined) => String(Math.max(0, DEZIGN_RULES.indexOf(rule?.toUpperCase() === 'NO ACTION' ? undefined : rule?.toUpperCase())))
  const sameRule = (a: string | undefined, b: string | undefined) => ruleCode(a) === ruleCode(b)

  const met = new Map<string, number>()
  for (const slot of project.list('REL')) {
    const sig = signatureOfRel(slot.el)
    const was = before.get(sig)
    // A relationship the model never showed (drawn without columns, virtual) is not the model's to remove.
    if (!was) continue
    const nth = met.get(sig) ?? 0
    met.set(sig, nth + 1)
    const now = after.get(sig)?.[nth]
    const old = was[Math.min(nth, was.length - 1)]!
    if (!now) {
      const relId = text(slot.el, 'ID')
      project.remove('REL', slot)
      for (const c of project.list('RELC')) if (text(c.el, 'ID') === relId) project.remove('RELC', c)
      changes.push({ kind: 'drop_relationship', table: old.table.name, name: old.fk.refTable })
      continue
    }
    if (!sameRule(old.fk.onDelete, now.fk.onDelete) || !sameRule(old.fk.onUpdate, now.fk.onUpdate)) {
      set(slot.el, 'UPDATERULE', ruleCode(now.fk.onUpdate), ['DELETERULE', 'CONSTRAINT', 'PAIRS'])
      set(slot.el, 'DELETERULE', ruleCode(now.fk.onDelete), ['CONSTRAINT', 'PAIRS'])
      changes.push({ kind: 'alter_relationship', table: now.table.name, name: now.fk.refTable })
    }
    // A name typed for the foreign key (`Ref name: …`): the name of the relationship's constraint, which is the
    // one the model shows and scripts use. The relationship keeps its own name.
    const constraint = kid(slot.el, 'CONSTRAINT')
    const typed = now.fk.name && now.fk.name !== defaultFkName(now.table.name, now.fk.columns) ? now.fk.name : ''
    if (constraint && typed && typed !== (old.fk.name ?? '') && typed !== text(constraint, 'NAME')) {
      const was = text(constraint, 'NAME') || text(slot.el, 'NAME')
      setName(constraint, typed, 'FKCONNAMETEMPLATE', { relname: text(slot.el, 'NAME') })
      changes.push({ kind: 'rename_relationship', table: now.table.name, name: `${was} → ${typed}` })
    }
  }
  // A relationship named by the project's pattern (`%parent%_%child%`) is named again when one of its tables is
  // renamed: DeZign does that itself when it opens the project (14.9.3), so the file says what DeZign will say.
  if (renamed.size) {
    const nameOf = new Map(project.list('ENT').map((e) => [text(e.el, 'ID'), text(e.el, 'NAME')]))
    for (const slot of project.list('REL')) {
      const [parent, child] = [text(slot.el, 'PARENTOBJECTID'), text(slot.el, 'CHILDOBJECTID')]
      const template = text(slot.el, 'NAMETEMPLATE')
      if ((!renamed.has(parent) && !renamed.has(child)) || !template.includes('%') || !nameOf.has(parent) || !nameOf.has(child)) continue
      const was = { parent: renamed.get(parent) ?? nameOf.get(parent)!, child: renamed.get(child) ?? nameOf.get(child)! }
      const now = { parent: nameOf.get(parent)!, child: nameOf.get(child)! }
      const old = text(slot.el, 'NAME')
      if (old !== fromTemplate(template, was)) continue
      const name = fromTemplate(template, now)
      set(slot.el, 'NAME', name)
      const constraint = kid(slot.el, 'CONSTRAINT')
      const own = text(constraint, 'NAMETEMPLATE')
      if (constraint && own.includes('%') && text(constraint, 'NAME') === fromTemplate(own, { relname: old, ...was })) set(constraint, 'NAME', fromTemplate(own, { relname: name, ...now }))
      project.rename('REL', slot, relFileName(slot.el))
    }
  }
  const existing = new Map<string, number>()
  for (const slot of project.list('REL')) existing.set(signatureOfRel(slot.el), (existing.get(signatureOfRel(slot.el)) ?? 0) + 1)
  // A relationship's constraint is `<relationship id>-FK` in DeZign 14 and plain `1` in every older format
  // (a number there: DeZign does not open a file with anything else in a number's place).
  const fkConstraintId = (relId: string) => (Number(source.formatVersion) >= 140 ? `${relId}-FK` : '1')
  for (const [sig, { table, fk, parentKey }] of [...after].flatMap(([key, list]) => list.slice(existing.get(key) ?? 0).map((item) => [key, item] as const))) {
    void sig
    const child = entities.get(tableKey(table))!
    const parent = entities.get(parentKey)!
    const id = newObjectId()
    const template = project.list('REL').find((s) => kids(kid(s.el, 'PAIRS'), 'PAIR').length > 0)?.el
    const fkIds = fk.columns.map((c) => text(child.attrs.get(lower(c)), 'ID'))
    const keyIds = fk.refColumns.map((c) => text(parent.attrs.get(lower(c)), 'ID'))
    const el = template
      ? clone(template, [[text(template, 'ID'), id]])
      : container('REL', [
          ...named('RELNAMETEMPLATE'),
          leaf('ID', id),
          leaf('PARENTOBJECTID'),
          leaf('CHILDOBJECTID'),
          leaf('CARDINALITY', '0'),
          leaf('RELTYPE', '1'),
          leaf('MANDATORYPARENT', '0'),
          leaf('UPDATERULE', '0'),
          leaf('DELETERULE', '0'),
          container('CONSTRAINT', [...named('FKCONNAMETEMPLATE'), leaf('ID', fkConstraintId(id)), leaf('CONLEVEL', '2'), leaf('CONTYPE', '4'), container('ATTRIBUTEIDS', [])]),
          container('PAIRS', []),
        ])
    for (const tag of ['DESC', 'NOTE', 'PARENTPHRASE', 'CHILDPHRASE']) if (kid(el, tag)) set(el, tag, '')
    // Zero or more, DeZign's own default: not the cardinality of the relationship it was copied from.
    if (kid(el, 'CARDINALITY')) set(el, 'CARDINALITY', '0')
    forget(el)
    const parentName = text(parent.el, 'NAME')
    // A name typed for the relationship (`Ref name: …`) is its name; otherwise the project's template makes one.
    const typed = fk.name && fk.name !== defaultFkName(table.name, fk.columns) ? fk.name : ''
    const name = typed || fromTemplate(pattern('RELNAMETEMPLATE') || '%parent%_%child%', { parent: parentName, child: table.name })
    setName(el, name, 'RELNAMETEMPLATE', { parent: parentName, child: table.name })
    set(el, 'PARENTOBJECTID', parent.id)
    set(el, 'CHILDOBJECTID', child.id)
    if (kid(el, 'VIRTUALREL')) set(el, 'VIRTUALREL', '0')
    // 0 identifying (the key is part of the child's key), 1 non-identifying.
    set(el, 'RELTYPE', fk.columns.every((c) => table.primaryKey.map(lower).includes(lower(c))) ? '0' : '1', ['MANDATORYPARENT', 'UPDATERULE', 'DELETERULE', 'CONSTRAINT', 'PAIRS'])
    set(el, 'MANDATORYPARENT', fk.columns.every((c) => table.columns.find((x) => lower(x.name) === lower(c))?.nullable === false) ? '1' : '0', ['UPDATERULE', 'DELETERULE', 'CONSTRAINT', 'PAIRS'])
    set(el, 'UPDATERULE', ruleCode(fk.onUpdate), ['DELETERULE', 'CONSTRAINT', 'PAIRS'])
    set(el, 'DELETERULE', ruleCode(fk.onDelete), ['CONSTRAINT', 'PAIRS'])
    let constraint = kid(el, 'CONSTRAINT')
    if (!constraint) insert(el, (constraint = container('CONSTRAINT', [...named('FKCONNAMETEMPLATE'), leaf('ID', fkConstraintId(id)), leaf('CONLEVEL', '2'), leaf('CONTYPE', '4'), container('ATTRIBUTEIDS', [])])), ['PAIRS'])
    const names = { relname: name, parent: parentName, child: table.name }
    setName(constraint, pattern('FKCONNAMETEMPLATE') ? fromTemplate(pattern('FKCONNAMETEMPLATE'), names) : name, 'FKCONNAMETEMPLATE', names)
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
    // A connector in every diagram that shows both tables.
    for (const diagramId of new Set(project.list('ENTC').map((c) => text(c.el, 'DIAGRAMID')))) addConnector(id, diagramId, child.id, parent.id)
    changes.push({ kind: 'add_relationship', table: table.name, name: fk.refTable })
  }

  // Diagrams that gained or lost tables: every relationship between two tables on the diagram is drawn there, and
  // no line is left that ends at a table that is not.
  for (const diagramId of membershipChanged) {
    const onDiagram = new Set(controlsOf(diagramId).map((c) => text(c.el, 'ID')))
    const clusters = new Map(project.list('SUBCAT').map((x) => [text(x.el, 'ID'), text(x.el, 'AOID')]))
    const ends = new Map(project.list('REL').map((r) => [text(r.el, 'ID'), { child: text(r.el, 'CHILDOBJECTID'), parent: text(r.el, 'PARENTOBJECTID') }]))
    for (const c of project.list('RELC')) {
      if (text(c.el, 'DIAGRAMID') !== diagramId) continue
      const rel = ends.get(text(c.el, 'ID'))
      if (rel && (!onDiagram.has(rel.child) || !onDiagram.has(clusters.get(rel.parent) ?? rel.parent))) project.remove('RELC', c)
    }
    for (const [relId, rel] of ends) if (!clusters.has(rel.parent)) addConnector(relId, diagramId, rel.child, rel.parent)
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

  for (const [diagramId, wanted] of diagramRequests) {
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

  /** A file name like the neighbours': theirs with the diagram and object ids swapped for the new ones. */
  const controlNameLike = (kind: Kind, prefix: string, diagramId: string, id: string) => {
    const neighbour = project.list(kind).find((x) => x.path && text(x.el, 'DIAGRAMID') && project.fileStem(x).includes(text(x.el, 'ID')))
    if (!neighbour) return controlFileName(prefix, diagramId, id)
    return project.fileStem(neighbour).replace(text(neighbour.el, 'DIAGRAMID'), diagramId).replace(text(neighbour.el, 'ID'), id)
  }
  const firstLine = (value: string) => value.split(/\r?\n/)[0]!.slice(0, 40)

  // Text areas of each diagram whose list was given: changed text or place, new ones, and the ones taken away.
  for (const [diagramId, wanted] of diagramRequests) {
    if (!wanted.notes) continue
    const onDiagram = (c: Slot) => !kid(c.el, 'DIAGRAMID') || text(c.el, 'DIAGRAMID') === diagramId
    const keep = new Set(wanted.notes.map((n) => n.id))
    for (const control of project.list('TEXTC').filter(onDiagram)) {
      const id = text(control.el, 'ID')
      if (keep.has(id)) continue
      const area = project.list('TEXTAR').find((x) => text(x.el, 'ID') === id)
      project.remove('TEXTC', control)
      // The text itself goes when no other diagram shows it.
      if (area && !project.list('TEXTC').some((c) => text(c.el, 'ID') === id)) project.remove('TEXTAR', area)
      changes.push({ kind: 'drop_note', table: firstLine(area ? text(area.el, 'TEXT') : id) })
    }
    for (const note of wanted.notes) {
      const at = toDiagram(diagramId, note)
      let area = project.list('TEXTAR').find((x) => text(x.el, 'ID') === note.id)
      let control = project.list('TEXTC').find((c) => text(c.el, 'ID') === note.id && onDiagram(c))
      if (!area || !control) {
        if (!note.text.trim()) continue
        const id = area ? note.id : newObjectId()
        if (!area) {
          const template = project.list('TEXTAR')[0]?.el
          const el = template ? clone(template, [[text(template, 'ID'), id]]) : container('TEXTAR', [leaf('NAME'), leaf('ID', id), leaf('TEXT')])
          for (const tag of ['DESC', 'NOTE']) if (kid(el, tag)) set(el, tag, '')
          const name = `TextArea${project.list('TEXTAR').length + 1}`
          set(el, 'NAME', name)
          set(el, 'TEXT', note.text)
          const sample = project.list('TEXTAR')[0]
          area = project.add('TEXTAR', el, sample && project.fileStem(sample) === text(sample.el, 'ID') ? id : name)
        }
        const template = project.list('TEXTC')[0]?.el
        const el = template
          ? clone(template)
          : container('TEXTC', [leaf('ID'), leaf('DIAGRAMID'), leaf('W', '200'), leaf('H', '60'), leaf('L'), leaf('T'), leaf('BRUSH', '0,16777215'), leaf('PEN', '0,1,4,0'), leaf('FONT', 'Arial,8,,0,clWindowText,0'), leaf('TR', '0'), leaf('AS', '1')])
        set(el, 'ID', id)
        if (kid(el, 'DIAGRAMID') || diagramId) set(el, 'DIAGRAMID', diagramId, ['W'])
        set(el, 'L', String(at.l))
        set(el, 'T', String(at.t))
        control = project.add('TEXTC', el, controlNameLike('TEXTC', 'textc', diagramId, id))
        changes.push({ kind: 'add_note', table: firstLine(note.text) })
        continue
      }
      let changed = false
      if (normText(text(area.el, 'TEXT')) !== normText(note.text)) {
        set(area.el, 'TEXT', note.text)
        changed = true
      }
      if (Math.abs(at.l - Number(text(control.el, 'L'))) > 2 || Math.abs(at.t - Number(text(control.el, 'T'))) > 2) {
        set(control.el, 'L', String(at.l))
        set(control.el, 'T', String(at.t))
        changed = true
      }
      if (changed) changes.push({ kind: 'alter_note', table: firstLine(note.text) })
    }
  }

  // Table colors that were changed: the fill of the table's control on that diagram.
  for (const [diagramId, wanted] of diagramRequests) {
    if (!wanted.colors) continue
    const controls = controlsOf(diagramId)
    const fills = controls.map((c) => text(c.el, 'BRUSH').split(',')[1]?.trim() ?? '').filter(Boolean)
    // The usual color is the one most tables on the diagram have.
    const usual = [...new Set(fills)].sort((a, b) => fills.filter((f) => f === b).length - fills.filter((f) => f === a).length)[0] ?? '16119285'
    for (const [key, color] of Object.entries(wanted.colors)) {
      const entity = entities.get(lower(key))
      const control = entity && controls.find((c) => text(c.el, 'ID') === entity.id)
      if (!entity || !control) continue
      const rgb = color ? /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color) : null
      if (color && !rgb) continue
      // Delphi colors are 0x00BBGGRR.
      const fill = rgb ? String(parseInt(rgb[3]!, 16) * 65536 + parseInt(rgb[2]!, 16) * 256 + parseInt(rgb[1]!, 16)) : usual
      const [style] = text(control.el, 'BRUSH').split(',')
      if (text(control.el, 'BRUSH').split(',')[1]?.trim() === fill) continue
      set(control.el, 'BRUSH', `${style?.trim() || '0'},${fill}`, ['PEN', 'FONT', 'TR', 'AS'])
      changes.push({ kind: 'color_table', table: text(entity.el, 'NAME') })
    }
  }

  // Group boxes (captioned frames) of each diagram whose list was given: moved, resized or renamed, new, gone.
  for (const [diagramId, wanted] of diagramRequests) {
    if (!wanted.boxes) continue
    const l = diagramId === layout.diagramId ? layout : (source.diagrams.find((d) => d.id === diagramId)?.layout ?? { originX: 0, originY: 0, scaleX: 1, scaleY: 1 })
    const size = (w: number, h: number) => ({ w: Math.max(20, Math.round(w / l.scaleX)), h: Math.max(20, Math.round(h / l.scaleY)) })
    const onDiagram = (c: Slot) => !kid(c.el, 'DIAGRAMID') || text(c.el, 'DIAGRAMID') === diagramId
    const titled = (id: string) => project.list('GROUPBOX').find((x) => text(x.el, 'ID') === id)
    const keep = new Set(wanted.boxes.map((b) => b.id))
    for (const control of project.list('GROUPBOXC').filter(onDiagram)) {
      const id = text(control.el, 'ID')
      if (keep.has(id)) continue
      const box = titled(id)
      project.remove('GROUPBOXC', control)
      if (box && !project.list('GROUPBOXC').some((c) => text(c.el, 'ID') === id)) project.remove('GROUPBOX', box)
      changes.push({ kind: 'drop_box', table: box ? text(box.el, 'OBJECTCAPTION') || text(box.el, 'NAME') : id })
    }
    for (const wantedBox of wanted.boxes) {
      const at = toDiagram(diagramId, wantedBox)
      const dims = size(wantedBox.w, wantedBox.h)
      let box = titled(wantedBox.id)
      const control = project.list('GROUPBOXC').find((c) => text(c.el, 'ID') === wantedBox.id && onDiagram(c))
      if (box && control) {
        let changed = false
        if (text(box.el, 'OBJECTCAPTION') !== wantedBox.title) {
          set(box.el, 'OBJECTCAPTION', wantedBox.title)
          changed = true
        }
        const near = (tag: string, value: number) => Math.abs(Number(text(control.el, tag)) - value) <= 2
        if (!near('L', at.l) || !near('T', at.t) || !near('W', dims.w) || !near('H', dims.h)) {
          for (const [tag, value] of [['W', dims.w], ['H', dims.h], ['L', at.l], ['T', at.t]] as const) set(control.el, tag, String(value))
          changed = true
        }
        if (changed) changes.push({ kind: 'alter_box', table: wantedBox.title })
        continue
      }
      const id = box ? wantedBox.id : newObjectId()
      if (!box) {
        const template = project.list('GROUPBOX')[0]?.el
        const el = template ? clone(template, [[text(template, 'ID'), id]]) : container('GROUPBOX', [leaf('NAME'), leaf('ID', id), leaf('OBJECTCAPTION')])
        for (const tag of ['DESC', 'NOTE']) if (kid(el, tag)) set(el, tag, '')
        set(el, 'NAME', `Groupbox${project.list('GROUPBOX').length + 1}`)
        set(el, 'ID', id)
        set(el, 'OBJECTCAPTION', wantedBox.title)
        const sample = project.list('GROUPBOX')[0]
        box = project.add('GROUPBOX', el, sample && project.fileStem(sample) !== text(sample.el, 'ID') ? text(el, 'NAME') : id)
      }
      // As DeZign 14.9.3 draws a new one: pale fill, grey dashed line, bold caption.
      const template = project.list('GROUPBOXC')[0]?.el
      const el = template
        ? clone(template)
        : container('GROUPBOXC', [leaf('ID'), leaf('DIAGRAMID'), leaf('W'), leaf('H'), leaf('L'), leaf('T'), leaf('BRUSH', '0,16775912'), leaf('PEN', '2,1,4,8421504'), leaf('FONT', 'Arial,10,B,0,clWindowText,0'), leaf('TR', '0'), leaf('AS', '0'), leaf('ROUNDED', '15'), leaf('ALIGNMENT', '0'), leaf('ALIGNMENTTYPE', '0')])
      set(el, 'ID', id)
      if (kid(el, 'DIAGRAMID') || diagramId) set(el, 'DIAGRAMID', diagramId, ['W'])
      for (const [tag, value] of [['W', dims.w], ['H', dims.h], ['L', at.l], ['T', at.t]] as const) set(el, tag, String(value))
      project.add('GROUPBOXC', el, controlNameLike('GROUPBOXC', 'groupboxc', diagramId, id))
      changes.push({ kind: 'add_box', table: wantedBox.title })
    }
  }

  // What the tables of a diagram show: DeZign's display level and data type display, and the columns hidden in a
  // table's box (attribute ids, comma separated).
  for (const [diagramId, wanted] of diagramRequests) {
    const display = wanted.display
    if (!display) continue
    const diagram = project.list('DIAGRAM').find((d) => text(d.el, 'ID') === diagramId)?.el
    let changed = false
    if (diagram && display.columns) {
      const level = String(DEZIGN_COLUMNS_SHOWN.indexOf(display.columns))
      if (level !== '-1' && kid(diagram, 'DISPLAYLEVEL') && text(diagram, 'DISPLAYLEVEL') !== level) {
        set(diagram, 'DISPLAYLEVEL', level)
        changed = true
      }
    }
    if (diagram && display.types && kid(diagram, 'VISIBLEATTR')) {
      // DeZign has the type and the physical type (and with the domain each): a choice of the same kind stays.
      const now = text(diagram, 'VISIBLEATTR')
      const kind = now === '1' || now === '3' ? 'type' : now === '2' || now === '4' ? 'domain' : 'none'
      if (kind !== display.types) {
        set(diagram, 'VISIBLEATTR', display.types === 'none' ? '0' : display.types === 'type' ? '3' : '4')
        changed = true
      }
    }
    for (const [key, names] of Object.entries(display.hidden ?? {})) {
      const entity = entities.get(lower(key))
      const control = entity && controlsOf(diagramId).find((c) => text(c.el, 'ID') === entity.id)
      if (!entity || !control) continue
      const ids = names.map((n) => text(entity.attrs.get(lower(n)), 'ID')).filter(Boolean).join(',')
      if (text(control.el, 'HIDDENATTR') === ids) continue
      if (kid(control.el, 'HIDDENATTR') || ids) set(control.el, 'HIDDENATTR', ids, ['ATTRCLIST'])
      changed = true
    }
    if (changed) changes.push({ kind: 'diagram_display', table: text(diagram, 'NAME') || diagramId })
  }

  // Formats before DeZign 14 keep counters of the ids handed out, for the project, its diagrams and each table's
  // columns, indexes and constraints. DeZign takes its next id from them: they follow what was added here.
  // (Only where a higher id was handed out here: a counter DeZign left behind its ids is DeZign's business.)
  const bump = (parent: El | undefined, tag: string, highest: number) => {
    if (parent && /^\d+$/.test(text(parent, tag)) && highest > Number(text(parent, tag))) set(parent, tag, String(highest))
  }
  if (lastNumber > firstNumber) for (const path of [['DATADICT'], ['DIAGRAMS']]) bump(project.section(path), 'LASTID', lastNumber)
  for (const { el } of project.list('ENT')) {
    const now = childNumbers(el)
    const was = numbersBefore.get(el) ?? [0, 0, 0]
    ;['ATTRLASTID', 'IDXLASTID', 'CONLASTID'].forEach((tag, i) => {
      if (now[i]! > was[i]!) bump(el, tag, now[i]!)
    })
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
        const cols = t.columns.map((c) => `${lower(c.name)} ${normType(c.dataType)}${c.domain ? ` @${lower(c.domain)}` : ''}${c.collation ? ` ~${c.collation}` : ''}${c.nullable ? '' : ' nn'}${c.isIdentity ? ' id' : ''}${normText(c.defaultValue) ? ` =${normText(c.defaultValue)}` : ''}${normText(c.comment) ? ` #${normText(c.comment)}` : ''}`)
        const fks = t.foreignKeys.filter((f) => !f.virtual).map((f) => `${f.columns.map(lower).join(',')}>${lower(f.refTable)}(${f.refColumns.map(lower).join(',')})`)
        const indexes = t.indexes.filter((ix) => !ix.primary).map(indexKey)
        const checks = (t.checks ?? []).map((c) => `check ${c.expression.replace(/\s+/g, ' ').trim().toLowerCase()}`)
        return [tableKey(t), `pk(${t.primaryKey.map(lower).join(',')})`, normText(t.comment), ...cols, ...fks.sort(), ...indexes.sort(), ...checks.sort()].join('\n  ')
      })
      .sort()
  // (What the document's code page cannot hold was written the way it can: see `codec`.)
  const want = describe(target).map(codec(options.encoding, '\n').fit)
  const got = describe(options.normalize ? options.normalize(model.tables) : model.tables)
  const wrong = want.find((w, i) => w !== got[i]) ?? (got.length !== want.length ? got[want.length] : undefined)
  // Local debugging of the writer against public sample models.
  if (wrong !== undefined && typeof process !== 'undefined' && process.env.DBM_DEZ_DEBUG) console.log(`WANT\n${wrong}\nGOT\n${got[want.indexOf(wrong)] ?? '(nothing)'}`)
  if (wrong !== undefined) throw new Error(`The DeZign file could not be written safely: table "${wrong.split('\n')[0]}" would not read back as edited. Nothing was changed.`)
}

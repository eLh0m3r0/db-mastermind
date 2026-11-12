import { unquotedName, type MigrationOptions, type ModelDomain } from './ddl.js'
import type { CheckInfo, ColumnInfo, DriverId, ForeignKeyInfo, IndexInfo, TableInfo } from './types.js'

/**
 * Reader for DeZign for Databases models: single-file projects (`.dez`, file formats 41 to 140, i.e. DeZign 4
 * to 14) and folder projects (`.dezproj` with one XML file per object, DeZign 14).
 *
 * The files are element-only XML with quirks a strict parser rejects (`<X /></X />` for empty settings, a
 * Latin-1 declaration over Windows code page bytes), so they are read with a tolerant tokenizer into a tree that
 * serializes back byte for byte. Callers pass the file as a *binary string* (`readFile(path, 'latin1')`): one
 * char per byte, which keeps the original bytes for writing back; text is decoded when it is read out.
 */

export interface DezignElement {
  tag: string
  /** Raw opening tag, e.g. `<ENT>`. */
  open: string
  /** Raw closing tag; empty for a self-closing element. */
  close: string
  children: (DezignElement | string)[]
}

export type DezignEncoding = 'utf-8' | 'windows-1250' | 'windows-1252'

/** A label a project defines (DeZign: Labels, e.g. "Personally Identifiable Information"), possibly under another. */
export interface DezignLabel {
  id: string
  name: string
  /** DeZign's color: a Delphi name (`clRed`) or `$00BBGGRR`. */
  color?: string
  parent?: string
}

/** A custom property a project defines for its objects (DeZign: user defined property). */
export interface DezignUserProperty {
  id: string
  name: string
  /** DeZign's own words: `Text`, `Number`, `Yes/No`, `Value from list`. */
  type: string
  /** What it is for, in DeZign's words: `Entity`, `Attribute`, `Relationship`, `Domain`, `View`, `Trigger`… */
  objectTypes: string[]
  /** The choices of a `Value from list` property. */
  values: string[]
  group?: string
}

/** What the DeZign model has and the table model does not carry yet. */
export interface DezignLeftOut {
  /** Domains: their columns keep the domain's base type. */
  domains: number
  views: number
  procedures: number
  sequences: number
  triggers: number
  /** Kept for callers of older versions: check constraints are part of the model now, so this stays 0. */
  checks: number
  /** Relationships drawn without column pairs: there is no foreign key to create. */
  relationshipsWithoutColumns: number
  /** Diagrams besides the main one. */
  subdiagrams: number
  /**
   * Notes of tables, columns and relationships: DeZign keeps a "Notes" text next to the description, which is the
   * comment here. They stay in the file as they are.
   */
  objectNotes: number
}

export interface DezignSqlObject {
  kind: 'view' | 'sequence' | 'procedure' | 'trigger'
  name: string
  schema?: string
  /** The table a trigger belongs to. */
  table?: string
  /** One statement, without its terminator. */
  sql: string
  /**
   * The object's own id, and for a view, a trigger or a procedure its code as the project keeps it (DeZign's
   * placeholders such as `%viewname%` or `%triggername%` in it).
   */
  id?: string
  code?: string
  /** A sequence's settings as the project keeps them. */
  sequence?: DezignSequenceSettings
}

/** What DeZign keeps of a sequence (empty: the database's default). */
export interface DezignSequenceSettings {
  increment?: string
  start?: string
  min?: string
  max?: string
  cache?: string
  cycle?: boolean
}

/** The statement a sequence's settings stand for. */
export function dezignSequenceSql(o: { name: string; schema?: string }, q: DezignSequenceSettings): string {
  const num = (v: string | undefined) => (v !== undefined && /^-?\d+$/.test(v.trim()) ? v.trim() : '')
  const part = (v: string | undefined, sql: string) => (num(v) ? ` ${sql} ${num(v)}` : '')
  // A sequence that starts below 1 with no minimum of its own: databases default the minimum to 1 and refuse it.
  const floor = !num(q.min) && num(q.start) && Number(num(q.start)) < 1 && !(q.increment ?? '').trim().startsWith('-') ? ` MINVALUE ${num(q.start)}` : ''
  return `CREATE SEQUENCE ${o.schema ? `${o.schema}.` : ''}${o.name}${part(q.increment, 'INCREMENT BY')}${part(q.start, 'START WITH')}${part(q.min, 'MINVALUE')}${floor}${part(q.max, 'MAXVALUE')}${part(q.cache, 'CACHE')}${q.cycle ? ' CYCLE' : ''}`
}

/** The statement a trigger's or a procedure's code (with DeZign's placeholders) stands for. */
export function dezignCodeSql(o: { kind: 'trigger' | 'procedure'; name: string; schema?: string; table?: string }, code: string): string {
  const full = (o.schema ? `${o.schema}.` : '') + o.name
  const table = o.table ? (o.schema ? `${o.schema}.` : '') + o.table : ''
  const names: Record<string, string> = o.kind === 'trigger' ? { triggername: o.name, name: o.name, tablename: table, table } : { procname: full, procedurename: full, name: full }
  return code.replace(/%(\w+)%/g, (whole, key: string) => names[key.toLowerCase()] ?? whole).replace(/[;/\s]+$/, '')
}

/** A trigger, procedure, sequence or view with its SQL made again from its code or settings (after an edit). */
export function withDezignSql(o: DezignSqlObject): DezignSqlObject {
  if (o.kind === 'sequence') return o.sequence ? { ...o, sql: dezignSequenceSql(o, o.sequence) } : o
  if (o.code === undefined) return o
  return { ...o, sql: o.kind === 'view' ? dezignViewSql(o, o.code) : dezignCodeSql(o as DezignSqlObject & { kind: 'trigger' | 'procedure' }, o.code) }
}

/** The statement a view's code (with DeZign's placeholders for its name) stands for. */
export function dezignViewSql(view: { name: string; schema?: string }, code: string): string {
  const full = (view.schema ? `${view.schema}.` : '') + view.name
  const sql = code.replace(/%(\w+)%/g, (whole, key: string) => (['viewname', 'name'].includes(key.toLowerCase()) ? full : whole)).replace(/[;/\s]+$/, '')
  return !sql.trim() || /^\s*create\b/i.test(sql) ? sql : `CREATE VIEW ${full} AS\n${sql}`
}

export interface DezignDiagram {
  id: string
  name: string
  main: boolean
  /** Keys (`schema.table`) of the tables on the diagram. */
  tables: string[]
  positions: Record<string, { x: number; y: number }>
  /** Fill colors (`#rrggbb`) of the tables that don't have the project's default color. */
  colors: Record<string, string>
  /** Text areas on the diagram. */
  notes: { id: string; text: string; x: number; y: number }[]
  /** Group boxes: captioned frames drawn behind the tables they hold together. */
  boxes: { id: string; title: string; x: number; y: number; w: number; h: number }[]
  /** `x = (L - originX) * scaleX`: lets a writer turn positions back into DeZign's coordinates. */
  layout: { originX: number; originY: number; scaleX: number; scaleY: number }
  /** What the diagram's tables show (DeZign: Diagram → Entity display options). */
  display: DezignDisplay
}

/**
 * What a diagram's tables show. `columns` is DeZign's attribute display level (DISPLAYLEVEL 0–5: all, keys,
 * primary keys, none, first 10, first 20), `types` its data type display (VISIBLEATTR 0 none, 1/3 the type,
 * 2/4 the domain where the column has one), `hidden` the columns hidden in one table's box (HIDDENATTR of the
 * diagram object), by table key. Codes checked by setting them in DeZign 14.9.3.
 */
export interface DezignDisplay {
  columns: DezignColumnsShown
  types: 'none' | 'type' | 'domain'
  hidden?: Record<string, string[]>
  /** How relationships are drawn (DeZign's NOTATION: 0 crow's feet, 1 IDEF1X); none read: crow's feet. */
  notation?: 'crow' | 'idef1x'
}
export type DezignColumnsShown = 'all' | 'keys' | 'primary' | 'none' | 'first10' | 'first20'
export const DEZIGN_COLUMNS_SHOWN: DezignColumnsShown[] = ['all', 'keys', 'primary', 'none', 'first10', 'first20']
export const dezignDisplayOf = (displayLevel: string, visibleAttr: string, notation = ''): DezignDisplay => ({
  ...(notation === '1' ? { notation: 'idef1x' as const } : {}),
  columns: DEZIGN_COLUMNS_SHOWN[Number(displayLevel)] ?? 'all',
  // (No setting at all: types shown, as a diagram here shows them.)
  types: visibleAttr === '1' || visibleAttr === '3' || visibleAttr === '' ? 'type' : visibleAttr === '2' || visibleAttr === '4' ? 'domain' : 'none',
})

export interface DezignModel {
  /** `FILEFORMATVERSION`: 41, 51, 60, 120, 140… (the DeZign version times ten). */
  formatVersion: string
  /** DeZign's target database id, e.g. `postgresql16`, `mssqlserver2022`. */
  targetDatabase: string
  encoding: DezignEncoding
  tables: TableInfo[]
  /** Table positions in the main diagram, keyed `schema.table` (empty schema: `.table`). */
  positions: Record<string, { x: number; y: number }>
  /** How `positions` were derived from the main diagram: `x = (L - originX) * scaleX`. Lets a writer turn them back. */
  layout: { diagramId: string; originX: number; originY: number; scaleX: number; scaleY: number }
  /** Every diagram of the project (the main one included) with the tables it shows and where. */
  diagrams: DezignDiagram[]
  /** The custom properties the project defines (values: `TableInfo.properties`, `ColumnInfo.properties`). */
  userProperties: DezignUserProperty[]
  /** The labels the project defines (on objects: `TableInfo.labels`, `ColumnInfo.labels`). */
  labels: DezignLabel[]
  /** The project's domains (named reusable types): a column follows one through `ColumnInfo.domain`. */
  domains: { name: string; dataType: string }[]
  /** Views, sequences, procedures and triggers as the SQL the project holds for them (in its target database's dialect). */
  sqlObjects: DezignSqlObject[]
  /** What the project decides about the scripts made from it. */
  scripting: DezignScripting
  /** The project's name templates by setting (`PKCONNAMETEMPLATE` → `PK_%table%`): a new object is named by them. */
  nameTemplates: Record<string, string>
  leftOut: DezignLeftOut
}

/**
 * How a project wants its scripts: the names of its primary keys, and its domains where it keeps them as types
 * of the database (DeZign's "convert domains" off: `CREATE DOMAIN` in PostgreSQL, and columns typed by it).
 */
export interface DezignScripting {
  primaryKeys: DezignKeyNames
  domains: ModelDomain[]
  /** The names of the project's UNIQUE constraints (as opposed to its unique indexes), lower case. */
  uniqueConstraints: string[]
  /** The names of its unique indexes, lower case. Anything else unique in the model is saved, and made, as a constraint. */
  uniqueIndexes: string[]
  /**
   * SQL the project puts at the start and at the end of every script DeZign generates from it (Project options:
   * "begin/end database script"), for a CREATE script and for an ALTER script: `[begin, end]`.
   */
  around?: { create: [string, string]; alter: [string, string] }
}

/** A script with what the DeZign project wants before and after it (see `DezignScripting.around`). */
export function dezignWrapScript(script: string, scripting: DezignScripting | undefined, kind: 'create' | 'alter'): string {
  const [begin, end] = scripting?.around?.[kind] ?? ['', '']
  return [begin, script.trim(), end].filter((part) => part.trim()).join('\n\n') + (script.endsWith('\n') || end.trim() ? '\n' : '')
}

/** The options for a script or migration of a DeZign project's model, for `driver`: names as DeZign's scripts have them. */
export function dezignMigrationOptions(scripting: DezignScripting | undefined, driver: DriverId): MigrationOptions {
  if (!scripting) return {}
  const indexes = new Set(scripting.uniqueIndexes ?? [])
  return {
    primaryKeyName: (table) => unquotedName(dezignKeyName(scripting.primaryKeys, table), driver),
    domains: scripting.domains,
    // What is unique in a DeZign project is a UNIQUE constraint (that is how a new one is saved into the project
    // too), except the unique indexes the project has.
    uniqueConstraint: (_table, name) => !(name && indexes.has(name.toLowerCase())),
  }
}

/** Primary key names of a project: by table (`schema.table`, lower case) and the template for a new table (`PK_%table%`). */
export interface DezignKeyNames {
  names: Record<string, string>
  template?: string
}

/** The name of a table's primary key as the project would have it, if it says. */
export function dezignKeyName(keys: DezignKeyNames | undefined, table: { schema?: string; name: string }): string | undefined {
  if (!keys) return undefined
  const name = table.name.toLowerCase()
  const known = keys.names[`${(table.schema ?? '').toLowerCase()}.${name}`] ?? Object.entries(keys.names).find(([key]) => key.endsWith(`.${name}`))?.[1]
  return known ?? (keys.template ? keys.template.replace(/%(table|tab_name)%/gi, table.name) : undefined)
}

export function parseDezignXml(text: string): DezignElement {
  const root: DezignElement = { tag: '#document', open: '', close: '', children: [] }
  const stack = [root]
  for (const m of text.matchAll(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^<>]+>|[^<]+|</g)) {
    const token = m[0]
    const top = stack[stack.length - 1]!
    if (!token.startsWith('<') || token.startsWith('<?') || token.startsWith('<!') || token === '<') {
      top.children.push(token)
    } else if (token.startsWith('</')) {
      const tag = token.slice(2, -1).replace(/\/\s*$/, '').trim()
      const last = top.children[top.children.length - 1]
      // DeZign writes some empty settings as `<X /></X />`: that "self-closing" tag was an opening one.
      if (top.tag !== tag && last && typeof last !== 'string' && last.tag === tag && last.open.endsWith('/>') && !last.close) {
        last.close = token
        continue
      }
      if (top.tag !== tag || stack.length === 1) throw new Error(`Not a readable DeZign file: </${tag}> closes <${top.tag}>`)
      top.close = token
      stack.pop()
    } else {
      const selfClosing = token.endsWith('/>')
      const el: DezignElement = { tag: token.slice(1, selfClosing ? -2 : -1).trim().split(/\s/)[0]!, open: token, close: '', children: [] }
      top.children.push(el)
      if (!selfClosing) stack.push(el)
    }
  }
  if (stack.length !== 1) throw new Error(`Not a readable DeZign file: <${stack[stack.length - 1]!.tag}> is not closed`)
  return root
}

export function serializeDezignXml(node: DezignElement | string): string {
  return typeof node === 'string' ? node : node.open + node.children.map(serializeDezignXml).join('') + node.close
}

const CZECH_BYTES = new Set([0xec, 0xf8, 0xf9, 0xf2, 0xef, 0x9d, 0xd8, 0xcc, 0xcf, 0xd2, 0xb3, 0xb9, 0xbe, 0xbf])
const WESTERN_BYTES = new Set([0xe0, 0xe3, 0xe5, 0xe6, 0xf5, 0xf1, 0xea, 0xfb, 0xe2, 0xee, 0xc0, 0xc5, 0xc6])

/**
 * DeZign declares `iso-8859-1` and writes the bytes of the Windows ANSI code page it ran on, so the declaration
 * says nothing. UTF-8 is recognized exactly; between the Central European and Western code pages the letters
 * that only one of them uses decide (ě ř ů ň ď ť ł ą against à ã å æ õ ñ ê). Text with none of them (á í é
 * are the same bytes in both, č and è share one) gets `fallback`: the caller knows the user's language.
 */
export function detectDezignEncoding(binary: string, fallback: Exclude<DezignEncoding, 'utf-8'> = 'windows-1252'): DezignEncoding {
  let central = 0
  let western = 0
  let high = false
  for (let i = 0; i < binary.length; i++) {
    const b = binary.charCodeAt(i)
    if (b < 0x80) continue
    high = true
    if (CZECH_BYTES.has(b)) central++
    else if (WESTERN_BYTES.has(b)) western++
  }
  if (!high) return fallback
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
    return 'utf-8'
  } catch {
    return central === western ? fallback : central > western ? 'windows-1250' : 'windows-1252'
  }
}

// Some Node versions (24.5 among them) read windows-1252 as ISO-8859-1: the bytes 0x80–0x9F, which hold
// € „ “ – Š ž …, come out as control characters. They are put right here, whatever the runtime does.
const CP1252_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ'
/** A decoder for the bytes of a DeZign document. */
export function dezignDecoder(encoding: DezignEncoding): { decode(bytes: Uint8Array): string } {
  const decoder = new TextDecoder(encoding)
  if (encoding !== 'windows-1252') return decoder
  return { decode: (bytes) => decoder.decode(bytes).replace(/[\u0080-\u009f]/g, (c) => CP1252_HIGH[c.charCodeAt(0) - 0x80]!) }
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
export const unescapeDezignText = (s: string) =>
  s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
  })

export const dezignChildren = (el: DezignElement | undefined, tag?: string): DezignElement[] =>
  el ? el.children.filter((k): k is DezignElement => typeof k !== 'string' && (!tag || k.tag === tag)) : []
export const dezignChild = (el: DezignElement | undefined, tag: string): DezignElement | undefined => dezignChildren(el, tag)[0]
const kids = dezignChildren
const kid = dezignChild
const unescapeXml = unescapeDezignText

// 0 is "none"; 1 and 2 are confirmed by SQL that DeZign generated from a public model, 3 and 4 follow its dialog order.
export const DEZIGN_RULES = [undefined, 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']
// A relationship's CARDINALITY, in the order of DeZign's dialog and manual: zero or more (the default), one or
// more, zero or one, exactly one.
export const DEZIGN_CARDINALITIES = [undefined, 'one-or-more', 'zero-or-one', 'exactly-one'] as const
const RULES = DEZIGN_RULES

export interface ReadDezignOptions {
  /** Overrides the detected code page. */
  encoding?: DezignEncoding
  /** Code page for text whose letters don't tell (default Western); pass Central European for a Czech, Slovak, Polish… user. */
  fallbackEncoding?: Exclude<DezignEncoding, 'utf-8'>
  /** Size of a table in the target diagram: positions are spread so tables of this size don't overlap. */
  node?: { width: number; header: number; row: number }
  /** Read this archived version (its index among the file's archived versions) instead of the working model. */
  archived?: number
}

/**
 * A default as SQL. DeZign takes what was typed: a plain word typed for a text column (`free` for an ENUM,
 * `N` for a CHAR) is a string that lost its quotes, not a name the database would know.
 */
function defaultSql(value: string, dataType: string): string {
  if (!/^(n?(var)?char2?|character|text|string|memo|enum|set|(tiny|medium|long)text|n?clob)\b/i.test(dataType)) return value
  if (!/^[\p{L}_][\p{L}\p{N}_.\- ]*$/u.test(value) || /^(null|user|(current|session|system)_user|current_(date|time|timestamp|role|schema|catalog)|sysdate|systimestamp|localtime(stamp)?|true|false)$/i.test(value)) return value
  return `'${value}'`
}

/** The driver for a DeZign target database id (`postgresql16`, `mssqlserver2022`, `mysql8`, `oracle12`…), when there is one. */
export function dezignDriver(targetDatabase: string | undefined): DriverId | undefined {
  const id = (targetDatabase ?? '').toLowerCase()
  if (/^postgres/.test(id)) return 'postgres'
  if (/^(mssql|sqlserver|azure)/.test(id)) return 'mssql'
  if (/^maria/.test(id)) return 'mariadb'
  if (/^mysql/.test(id)) return 'mysql'
  if (/^oracle/.test(id)) return 'oracle'
  if (/^sqlite/.test(id)) return 'sqlite'
  return undefined
}

/** The model of a DeZign project given as a binary string (`.dez` content, or `assembleDezignProject`). */
export function readDezign(binary: string, options: ReadDezignOptions = {}): DezignModel {
  const encoding = options.encoding ?? detectDezignEncoding(binary, options.fallbackEncoding)
  const decoder = dezignDecoder(encoding)
  const decode = (s: string) => (/[\x80-\xff]/.test(s) ? decoder.decode(Uint8Array.from(s, (c) => c.charCodeAt(0))) : s)
  const text = (el: DezignElement | undefined, tag: string): string => {
    const k = kid(el, tag)
    if (!k) return ''
    return unescapeXml(decode(k.children.map((c) => (typeof c === 'string' ? (c.startsWith('<![CDATA[') ? c.slice(9, -3) : c) : '')).join(''))).trim()
  }

  const dezign = kid(parseDezignXml(binary), 'dezign')
  const versions = kids(dezign, 'VERSION')
  // Archived versions carry VERSIONINFO; the working model does not.
  const version = options.archived !== undefined ? versions.filter((v) => kid(v, 'VERSIONINFO'))[options.archived] : (versions.find((v) => !kid(v, 'VERSIONINFO')) ?? versions[0])
  const dict = kid(version, 'DATADICT')
  if (!dezign || !dict) {
    // DeZign 3 and older (2003) kept everything flat under VERSION: a different layout, not read here.
    const old = /<FILEFORMATVERSIONNUMBER>(\d+)</.exec(binary)?.[1]
    if (dezign && old) throw new Error(`This file is in DeZign's file format ${old}, older than the formats that can be read here (41 and later, DeZign 4 onwards). Open it in a newer DeZign and save it again.`)
    throw new Error(options.archived !== undefined ? 'The archived version is not in the file' : 'This is not a DeZign for Databases model')
  }

  const formatVersion = text(dezign, 'FILEFORMATVERSION') || text(kid(kid(version, 'PROJECTSETTINGS'), 'COMMONSETTINGS'), 'FILEFORMATVERSION')
  const leftOut: DezignLeftOut = { domains: 0, views: 0, procedures: 0, sequences: 0, triggers: 0, checks: 0, relationshipsWithoutColumns: 0, subdiagrams: 0, objectNotes: 0 }

  const domains = new Map(kids(kid(dict, 'DOMAINS'), 'DOMAIN').map((d) => [text(d, 'ID'), d]))
  const userProperties: DezignUserProperty[] = kids(kid(dict, 'USERDEFINEDPROPERTIES'), 'USERDEFPROP').map((p) => ({
    id: text(p, 'ID'),
    name: text(p, 'NAME'),
    type: text(p, 'PROPTYPE') || 'Text',
    objectTypes: text(p, 'OBJECTTYPES').split(',').map((x) => x.trim()).filter(Boolean),
    values: text(p, 'LISTVALUES').split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
    ...(text(p, 'GROUP') ? { group: text(p, 'GROUP') } : {}),
  }))
  const propertyNames = new Map(userProperties.map((p) => [p.id, p.name]))
  const labels: DezignLabel[] = kids(kid(version, 'LABELS'), 'LABEL').map((l) => ({ id: text(l, 'ID'), name: text(l, 'NAME'), ...(text(l, 'LABCOL') ? { color: text(l, 'LABCOL') } : {}), ...(text(l, 'PARENTLABELID') ? { parent: text(l, 'PARENTLABELID') } : {}) }))
  /** An object's labels (`OBJLABELS`: one name a line). */
  const labelsOf = (el: DezignElement | undefined) => {
    const names = text(el, 'OBJLABELS').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
    return names.length ? names : undefined
  }
  /** An object's custom property values by name (`USERDEFPROPS/UDP_<id>`), empty ones left out. */
  const dezignPropertyValues = (el: DezignElement | undefined, byId: Map<string, string>): Record<string, string> | undefined => {
    const props = kid(el, 'USERDEFPROPS')
    const out: Record<string, string> = {}
    for (const p of kids(props)) {
      const name = byId.get(p.tag.replace(/^UDP_/, ''))
      const value = text(props, p.tag)
      if (name && value) out[name] = value
    }
    return Object.keys(out).length ? out : undefined
  }
  leftOut.domains = domains.size
  leftOut.views = kids(kid(dict, 'VIEWS'), 'VIEW').length
  leftOut.procedures = kids(kid(dict, 'PROCEDURES')).length
  leftOut.sequences = kids(kid(dict, 'SEQUENCES')).length

  const typeOf = (dt: DezignElement | undefined): string => {
    const name = text(dt, 'DTLISTNAME').toLowerCase()
    const length = text(dt, 'LE')
    const scale = text(dt, 'PR')
    // MySQL's ENUM and SET keep their values next to the type.
    const items = text(dt, 'ITMS')
    return name + (length ? `(${length}${scale ? `,${scale}` : ''})` : items ? `(${items})` : '')
  }
  const idsOf = (constraint: DezignElement | undefined) => kids(kid(constraint, 'ATTRIBUTEIDS'), 'ATTRIBUTEID').map((a) => unescapeXml(a.children.filter((c) => typeof c === 'string').join('')).trim())

  interface Entity {
    table: TableInfo
    /** Attribute id → column name. Old formats number attributes per entity, new ones use global ids. */
    columns: Map<string, string>
  }
  const entities = new Map<string, Entity>()
  const tables: TableInfo[] = []
  // Settings sit in the data dictionary in old files and in the project settings since DeZign 12.
  const projectSettings = kid(version, 'PROJECTSETTINGS')
  const nameTemplates: Record<string, string> = {}
  for (const holder of [kid(dict, 'DDSETTINGS'), kid(projectSettings, 'NAMETEMPLATES')]) for (const s of kids(holder)) if (/NAMETEMPLATE$/.test(s.tag) && text(holder, s.tag)) nameTemplates[s.tag] = text(holder, s.tag)
  // DeZign writes a column's collation into scripts for SQL Server and MySQL only (`enablecolumncollate` in its
  // database definitions; its PostgreSQL template has no place for one). A project for another database may
  // still hold collations, from the database it was made for first: they stay in the file and out of the model.
  const collates = ['mssql', 'mysql', 'mariadb'].includes(dezignDriver(text(dict, 'DBID')) ?? '')
  const convertDomains = text(kid(dict, 'DDSETTINGS'), 'CONVERTDOMAINS') === '1' || text(kid(projectSettings, 'GenDB_Options'), 'CONVERTDOMAINS') === '1'
  const common = kid(projectSettings, 'COMMONSETTINGS')
  // (Line ends as the model has them: a folder project's files end lines with CRLF.)
  const script = (tag: string) => text(common, tag).replace(/\r\n?/g, '\n')
  const around = {
    create: [script('BEGINDATABASESCRIPT'), script('ENDDATABASESCRIPT')] as [string, string],
    alter: [script('BEGINALTERDATABASESCRIPT'), script('ENDALTERDATABASESCRIPT')] as [string, string],
  }
  const anyKey = kids(kid(dict, 'ENTITIES'), 'ENT').map((e) => text(kid(e, 'PKCON'), 'NAMETEMPLATE')).find(Boolean)
  const uniqueConstraints: string[] = []
  const uniqueIndexes: string[] = []
  const primaryKeys: DezignKeyNames = { names: {}, template: nameTemplates.PKCONNAMETEMPLATE || anyKey || undefined }

  for (const ent of kids(kid(dict, 'ENTITIES'), 'ENT')) {
    const pkIds = idsOf(kid(ent, 'PKCON'))
    // (A key without a name is written without one: the database names it.)
    const pkName = text(kid(ent, 'PKCON'), 'NAME')
    if (pkIds.length) primaryKeys.names[`${(text(ent, 'SCHEMA') || text(ent, 'SCHEMANAME')).toLowerCase()}.${text(ent, 'NAME').toLowerCase()}`] = pkName
    const columnNames = new Map<string, string>()
    const checks: CheckInfo[] = []
    const columns: ColumnInfo[] = kids(kid(ent, 'ATTRIBUTES'), 'ATTR').map((attr, i) => {
      const id = text(attr, 'ID')
      const name = text(attr, 'NAME')
      columnNames.set(id, name)
      const domain = domains.get(text(attr, 'DOMAINID'))
      const ownType = kid(attr, 'DT')
      const dt = ownType && text(ownType, 'DTLISTNAME') ? ownType : (kid(domain, 'DT') ?? ownType)
      const isPrimaryKey = pkIds.includes(id)
      const check = text(kid(attr, 'CCON'), 'VALUE')
      // A domain's check says `value` for whichever column follows the domain: such a check stays with its column.
      const ownColumn = /\bvalue\b/i.test(check) && name.toLowerCase() !== 'value'
      if (check) checks.push({ expression: check, ...(text(kid(attr, 'CCON'), 'NAME') ? { name: text(kid(attr, 'CCON'), 'NAME') } : {}), ...(ownColumn ? { column: name } : {}) })
      const dataType = typeOf(dt) || text(domain, 'NAME') || 'text'
      const defaultValue = defaultSql(text(kid(attr, 'DEFCON'), 'VALUE') || text(kid(domain, 'DEFCON'), 'VALUE'), dataType)
      return {
        name,
        ordinal: i + 1,
        dataType,
        nullable: !isPrimaryKey && text(kid(attr, 'NNCON'), 'VALUE') !== '1',
        defaultValue: defaultValue || null,
        isPrimaryKey,
        isIdentity: text(dt, 'AN') === '1',
        comment: text(attr, 'DESC') || null,
        ...(text(attr, 'NOTE') ? { remarks: text(attr, 'NOTE') } : {}),
        ...(dezignPropertyValues(attr, propertyNames) ? { properties: dezignPropertyValues(attr, propertyNames) } : {}),
        ...(labelsOf(attr) ? { labels: labelsOf(attr) } : {}),
        ...(text(attr, 'TODO') ? { todo: text(attr, 'TODO').replace(/\r\n?/g, '\n') } : {}),
        ...(domain && text(domain, 'NAME') ? { domain: text(domain, 'NAME') } : {}),
        ...(collates && text(attr, 'COLLATE') ? { collation: text(attr, 'COLLATE') } : {}),
        ...(text(attr, 'PKGNAME') ? { package: text(attr, 'PKGNAME') } : {}),
      }
    })
    const primaryKey = pkIds.map((id) => columnNames.get(id)).filter((c): c is string => !!c)
    const tableName = text(ent, 'NAME')
    const indexes: IndexInfo[] = []
    for (const con of kids(kid(ent, 'CONSTRAINTS'), 'CONSTRAINT')) {
      // Constraint types: 1 check, 2 unique, 3 primary key, 4 foreign key, 5 not null, 6 default.
      if (text(con, 'CONTYPE') !== '2') {
        if (text(con, 'CONTYPE') === '1' && text(con, 'VALUE')) checks.push({ expression: text(con, 'VALUE'), ...(text(con, 'NAME') ? { name: text(con, 'NAME') } : {}) })
        continue
      }
      const cols = idsOf(con).map((id) => columnNames.get(id)).filter((c): c is string => !!c)
      if (cols.length) indexes.push({ name: text(con, 'NAME') || `${tableName}_${cols.join('_')}_key`, columns: cols, unique: true, primary: false, constraint: true })
      if (cols.length && text(con, 'NAME')) uniqueConstraints.push(text(con, 'NAME').toLowerCase())
    }
    for (const ix of kids(kid(ent, 'INDEXES'), 'INDEX')) {
      const cols = kids(kid(ix, 'IDXCOLS'), 'IDXCOL').map((c) => columnNames.get(text(c, 'IDXCOLATTRID')) ?? text(c, 'NAME')).filter(Boolean)
      // DeZign's automatic index on the primary key is the key itself here.
      if (!cols.length || (text(ix, 'AUTOIDXTYPE') !== '0' && text(ix, 'AUTOIDXTYPE') !== '' && cols.join('\0') === primaryKey.join('\0'))) continue
      indexes.push({ name: text(ix, 'NAME') || `${tableName}_${cols.join('_')}_idx`, columns: cols, unique: /unique/i.test(text(ix, 'INDEXTYPE')), primary: false })
      if (/unique/i.test(text(ix, 'INDEXTYPE')) && text(ix, 'NAME')) uniqueIndexes.push(text(ix, 'NAME').toLowerCase())
    }
    leftOut.triggers += kids(kid(ent, 'TRIGGERS')).length
    const table: TableInfo = {
      schema: text(ent, 'SCHEMA') || text(ent, 'SCHEMANAME') || undefined,
      name: tableName,
      type: 'table',
      comment: text(ent, 'DESC') || null,
      ...(text(ent, 'NOTE') ? { remarks: text(ent, 'NOTE') } : {}),
      ...(dezignPropertyValues(ent, propertyNames) ? { properties: dezignPropertyValues(ent, propertyNames) } : {}),
      ...(labelsOf(ent) ? { labels: labelsOf(ent) } : {}),
      ...(text(ent, 'TODO') ? { todo: text(ent, 'TODO').replace(/\r\n?/g, '\n') } : {}),
      columns,
      primaryKey,
      foreignKeys: [],
      indexes,
      ...(checks.length ? { checks } : {}),
    }
    tables.push(table)
    entities.set(text(ent, 'ID'), { table, columns: columnNames })
  }

  // A relationship from a subtype cluster points at the cluster; the cluster names its supertype entity.
  const subcategories = new Map(kids(kid(dict, 'SUBCATEGORIES'), 'SUBCAT').map((s) => [text(s, 'ID'), text(s, 'AOID')]))
  for (const rel of kids(kid(dict, 'RELATIONSHIPS'), 'REL')) {
    if (text(rel, 'NOTE')) leftOut.objectNotes++
    const parentId = text(rel, 'PARENTOBJECTID')
    const parent = entities.get(parentId) ?? entities.get(subcategories.get(parentId) ?? '')
    const child = entities.get(text(rel, 'CHILDOBJECTID'))
    const pairs = kids(kid(rel, 'PAIRS'), 'PAIR')
    const columns = pairs.map((p) => child?.columns.get(text(p, 'FOREIGNKEYID')))
    const refColumns = pairs.map((p) => parent?.columns.get(text(p, 'KEYID')))
    if (!parent || !child || !pairs.length || columns.includes(undefined) || refColumns.includes(undefined)) {
      leftOut.relationshipsWithoutColumns++
      continue
    }
    const fk: ForeignKeyInfo = {
      name: text(kid(rel, 'CONSTRAINT'), 'NAME') || text(rel, 'NAME'),
      columns: columns as string[],
      refSchema: parent.table.schema,
      refTable: parent.table.name,
      refColumns: refColumns as string[],
    }
    const onUpdate = RULES[Number(text(rel, 'UPDATERULE'))]
    const onDelete = RULES[Number(text(rel, 'DELETERULE'))]
    if (onUpdate) fk.onUpdate = onUpdate
    if (onDelete) fk.onDelete = onDelete
    const cardinality = DEZIGN_CARDINALITIES[Number(text(rel, 'CARDINALITY'))]
    if (cardinality) fk.cardinality = cardinality
    if (text(rel, 'VIRTUALREL') === '1') fk.virtual = true
    if (subcategories.has(parentId)) fk.subtype = true
    child.table.foreignKeys.push(fk)
  }

  // What the model does not hold as structure is kept as the SQL the project has for it. DeZign's code carries
  // placeholders for the object's own name.
  const domainList: ModelDomain[] = [...domains.values()]
    .map((d) => ({ name: text(d, 'NAME'), dataType: typeOf(kid(d, 'DT')), defaultValue: defaultSql(text(kid(d, 'DEFCON'), 'VALUE'), typeOf(kid(d, 'DT'))) || null, check: text(kid(d, 'CCON'), 'VALUE') || null, notNull: text(kid(d, 'NNCON'), 'VALUE') === '1' }))
    .filter((d) => d.name)
  const sqlObjects: DezignSqlObject[] = []
  const code = (el: DezignElement, names: Record<string, string>) =>
    text(el, 'CODE')
      .replace(/%(\w+)%/g, (whole, key: string) => names[key.toLowerCase()] ?? whole)
      .replace(/[;/\s]+$/, '')
  const qualified = (el: DezignElement) => {
    const schema = text(el, 'SCHEMA') || text(el, 'SCHEMANAME')
    return { schema: schema || undefined, name: text(el, 'NAME'), full: (schema ? `${schema}.` : '') + text(el, 'NAME') }
  }
  for (const seq of kids(kid(dict, 'SEQUENCES'))) {
    const q = qualified(seq)
    // CYCLE holds the database's own word (DeZign's definitions: `;cycle`, `nocycle;cycle`, `NO CYCLE;CYCLE`).
    const cycle = /^(1|cycle)$/i.test(text(seq, 'CYCLE').trim())
    const settings: DezignSequenceSettings = { increment: text(seq, 'INCREMENT'), start: text(seq, 'SEED'), min: text(seq, 'MIN'), max: text(seq, 'MAX'), cache: text(seq, 'CACHE'), cycle }
    if (q.name) sqlObjects.push({ kind: 'sequence', name: q.name, schema: q.schema, sql: dezignSequenceSql(q, settings), ...(text(seq, 'ID') ? { id: text(seq, 'ID') } : {}), sequence: settings })
  }
  for (const view of kids(kid(dict, 'VIEWS'), 'VIEW')) {
    const q = qualified(view)
    const sql = dezignViewSql({ name: q.name, schema: q.schema }, text(view, 'CODE'))
    if (sql) sqlObjects.push({ kind: 'view', name: q.name, schema: q.schema, sql, ...(text(view, 'ID') ? { id: text(view, 'ID'), code: text(view, 'CODE').replace(/\r\n?/g, '\n') } : {}) })
  }
  for (const proc of kids(kid(dict, 'PROCEDURES'))) {
    const q = qualified(proc)
    const sql = code(proc, { procname: q.full, procedurename: q.full, name: q.full })
    if (sql) sqlObjects.push({ kind: 'procedure', name: q.name, schema: q.schema, sql, ...(text(proc, 'ID') ? { id: text(proc, 'ID'), code: text(proc, 'CODE').replace(/\r\n?/g, '\n') } : {}) })
  }
  for (const ent of kids(kid(dict, 'ENTITIES'), 'ENT')) {
    const table = qualified(ent)
    for (const trigger of kids(kid(ent, 'TRIGGERS'))) {
      const sql = code(trigger, { triggername: text(trigger, 'NAME'), name: text(trigger, 'NAME'), tablename: table.full, table: table.full })
      if (sql) sqlObjects.push({ kind: 'trigger', name: text(trigger, 'NAME'), schema: table.schema, table: table.name, sql, ...(text(trigger, 'ID') ? { id: text(trigger, 'ID'), code: text(trigger, 'CODE').replace(/\r\n?/g, '\n') } : {}) })
    }
  }

  const diagramsEl = kid(version, 'DIAGRAMS')
  const diagrams = kids(diagramsEl, 'DIAGRAM')
  leftOut.subdiagrams = Math.max(0, diagrams.length - 1)
  const mainId = text(diagrams.find((d) => text(d, 'ISMAINDIAGRAM') === '1') ?? diagrams[0], 'ID')
  const node = options.node
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 1
  const allControls = kids(kid(kid(diagramsEl, 'CONTROLS'), 'ENTITYCONTROLS'), 'ENTC')
    .map((c) => ({ diagram: kid(c, 'DIAGRAMID') ? text(c, 'DIAGRAMID') : mainId, entity: entities.get(text(c, 'ID')), x: Number(text(c, 'L')), y: Number(text(c, 'T')), w: Number(text(c, 'W')), h: Number(text(c, 'H')), fill: text(c, 'BRUSH').split(',')[1]?.trim() ?? '', hidden: text(c, 'HIDDENATTR') }))
    .filter((c): c is { diagram: string; entity: Entity; x: number; y: number; w: number; h: number; fill: string; hidden: string } => !!c.entity && Number.isFinite(c.x) && Number.isFinite(c.y))
  // Delphi colors are 0x00BBGGRR.
  const hex = (color: string) => {
    const n = Number(color)
    return Number.isInteger(n) && n >= 0 ? `#${[n & 255, (n >> 8) & 255, (n >> 16) & 255].map((v) => v.toString(16).padStart(2, '0')).join('')}` : ''
  }
  const defaultFill = text(kid(diagramsEl, 'DisplayPreferences'), 'DEFENTCOLOR')
  const noteTexts = new Map(kids(kid(dict, 'TEXTAREAS')).map((n) => [text(n, 'ID'), text(n, 'TEXT')]))
  const noteControls = kids(kid(kid(diagramsEl, 'CONTROLS'), 'TEXTAREACONTROLS'))
  const boxTitles = new Map(kids(kid(dict, 'GROUPBOXES')).map((b) => [text(b, 'ID'), text(b, 'OBJECTCAPTION') || text(b, 'NAME')]))
  // The single file calls the list GROUPBOXESCONTROLS; a folder project's folder is groupboxcontrols.
  const boxControls = [...kids(kid(kid(diagramsEl, 'CONTROLS'), 'GROUPBOXESCONTROLS')), ...kids(kid(kid(diagramsEl, 'CONTROLS'), 'GROUPBOXCONTROLS'))]
  const diagramOf = (id: string, name: string, main: boolean): DezignDiagram => {
    const controls = allControls.filter((c) => c.diagram === id)
    const element = diagrams.find((d) => text(d, 'ID') === id)
    const out: DezignDiagram = { id, name, main, tables: [], positions: {}, colors: {}, notes: [], boxes: [], layout: { originX: 0, originY: 0, scaleX: 1, scaleY: 1 }, display: element ? dezignDisplayOf(text(element, 'DISPLAYLEVEL'), text(element, 'VISIBLEATTR'), text(element, 'NOTATION')) : { columns: 'all', types: 'type' } }
    // DeZign's tables are smaller than the target's: spread the layout by the typical size ratio. A diagram
    // without tables (only notes or frames so far) keeps DeZign's own coordinates.
    const sx = node && controls.length ? Math.min(3, Math.max(1, median(controls.filter((c) => c.w > 0).map((c) => node.width / c.w)))) : 1
    const sy = node && controls.length ? Math.min(3, Math.max(1, median(controls.filter((c) => c.h > 0).map((c) => (node.header + node.row * c.entity.table.columns.length) / c.h)))) : 1
    const minX = controls.length ? Math.min(...controls.map((c) => c.x)) : 0
    const minY = controls.length ? Math.min(...controls.map((c) => c.y)) : 0
    out.layout = { originX: minX, originY: minY, scaleX: sx, scaleY: sy }
    for (const c of controls) {
      const key = `${c.entity.table.schema ?? ''}.${c.entity.table.name}`
      out.tables.push(key)
      out.positions[key] = { x: Math.round((c.x - minX) * sx), y: Math.round((c.y - minY) * sy) }
      if (c.fill && c.fill !== defaultFill && hex(c.fill)) out.colors[key] = hex(c.fill)
      // (A list of attribute ids, comma separated, over several lines.)
      const hidden = c.hidden.split(/[,\r\n]+/).map((id) => c.entity.columns.get(id.trim())).filter((n): n is string => !!n)
      if (hidden.length) (out.display.hidden ??= {})[key] = hidden
    }
    for (const c of noteControls) {
      // An empty text area is still one: left out, a writer told "these are all the notes" would remove it.
      if ((kid(c, 'DIAGRAMID') ? text(c, 'DIAGRAMID') : mainId) !== id || !noteTexts.has(text(c, 'ID'))) continue
      const [x, y] = [Number(text(c, 'L')), Number(text(c, 'T'))]
      if (Number.isFinite(x) && Number.isFinite(y)) out.notes.push({ id: text(c, 'ID'), text: noteTexts.get(text(c, 'ID')) ?? '', x: Math.round((x - minX) * sx), y: Math.round((y - minY) * sy) })
    }
    for (const c of boxControls) {
      if ((kid(c, 'DIAGRAMID') ? text(c, 'DIAGRAMID') : mainId) !== id) continue
      const [x, y, w, h] = [Number(text(c, 'L')), Number(text(c, 'T')), Number(text(c, 'W')), Number(text(c, 'H'))]
      if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) out.boxes.push({ id: text(c, 'ID'), title: boxTitles.get(text(c, 'ID')) ?? '', x: Math.round((x - minX) * sx), y: Math.round((y - minY) * sy), w: Math.round(w * sx), h: Math.round(h * sy) })
    }
    return out
  }
  // Old single-diagram files have controls without a diagram to belong to.
  const described = diagrams.length ? diagrams.map((d) => diagramOf(text(d, 'ID'), text(d, 'NAME'), text(d, 'ID') === mainId)) : allControls.length || noteControls.length ? [diagramOf(mainId, '', true)] : []
  const main = described.find((d) => d.main)
  const positions = main?.positions ?? {}
  const layout = { diagramId: mainId, ...(main?.layout ?? { originX: 0, originY: 0, scaleX: 1, scaleY: 1 }) }

  return { formatVersion, targetDatabase: text(dict, 'DBID'), encoding, tables, positions, layout, diagrams: described, sqlObjects, userProperties, labels, domains: domainList.map(({ name, dataType }) => ({ name, dataType })), scripting: { primaryKeys, domains: convertDomains ? [] : domainList, uniqueConstraints, uniqueIndexes, ...([...around.create, ...around.alter].some(Boolean) ? { around } : {}) }, nameTemplates, leftOut }
}

const PROJECT_SECTIONS: [folder: string, element: string][] = [
  ['domains', 'DOMAINS'],
  ['entities', 'ENTITIES'],
  ['subcategories', 'SUBCATEGORIES'],
  ['sequences', 'SEQUENCES'],
  ['procedures', 'PROCEDURES'],
  ['views', 'VIEWS'],
  ['textareas', 'TEXTAREAS'],
  ['groupboxes', 'GROUPBOXES'],
  ['relationships', 'RELATIONSHIPS'],
]

/**
 * Puts a folder project (`.dezproj`: settings; `.dds`: data dictionary header; one XML file per object under
 * `data dictionary/` and `diagrams/`) into the shape of a single-file project, for `readDezign`.
 * `files` are the project's files as binary strings with paths relative to the project folder; archived versions
 * are not needed.
 */
export function assembleDezignProject(files: { path: string; text: string }[]): string {
  const body = (text: string) => text.replace(/^﻿?\s*<\?xml[^>]*\?>\s*/, '')
  const norm = files.map((f) => ({ parts: f.path.replaceAll('\\', '/').toLowerCase().split('/'), text: f.text })).sort((a, b) => (a.parts.join('/') < b.parts.join('/') ? -1 : 1))
  const top = (ext: string) => body(norm.find((f) => f.parts.length === 1 && f.parts[0]!.endsWith(ext))?.text ?? '')
  const inDir = (...dir: string[]) =>
    norm
      .filter((f) => f.parts.length === dir.length + 1 && dir.every((d, i) => f.parts[i] === d) && f.parts[dir.length]!.endsWith('.xml'))
      .map((f) => body(f.text))
      .join('\n')
  const settings = top('.dezproj')
  if (!settings) throw new Error('The folder has no .dezproj file')
  const header = top('.dds').replace(/<\/?DATADICT>/g, '')
  const sections = PROJECT_SECTIONS.map(([folder, element]) => `<${element}>${inDir('data dictionary', folder)}</${element}>`).join('\n')
  const controls = `<ENTITYCONTROLS>${inDir('diagrams', 'diagramobjects', 'entitycontrols')}</ENTITYCONTROLS>\n<TEXTAREACONTROLS>${inDir('diagrams', 'diagramobjects', 'textareacontrols')}</TEXTAREACONTROLS>\n<GROUPBOXESCONTROLS>${inDir('diagrams', 'diagramobjects', 'groupboxcontrols')}</GROUPBOXESCONTROLS>\n<RELATIONSHIPCONNECTORS>${inDir('diagrams', 'diagramobjects', 'relationshipconnectors')}</RELATIONSHIPCONNECTORS>`
  return `<?xml version="1.0" encoding="iso-8859-1"?><dezign>\n<VERSION>\n${settings}\n<DATADICT>${header}\n${sections}</DATADICT>\n<DIAGRAMS>${top('.ddp')}\n${inDir('diagrams')}\n<CONTROLS>${controls}</CONTROLS></DIAGRAMS>\n<LABELS>${inDir('labels')}</LABELS>\n</VERSION>\n</dezign>`
}

/**
 * References inside a project that point nowhere, and ids used twice: what would make DeZign lose a relationship
 * or refuse the file. Each problem is one line naming element kinds and ids only (no names from the model), so
 * two runs can be compared. An empty list means every reference resolves.
 */
export function dezignIntegrity(binary: string): string[] {
  const dezign = kid(parseDezignXml(binary), 'dezign')
  const versions = kids(dezign, 'VERSION')
  const version = versions.find((v) => !kid(v, 'VERSIONINFO')) ?? versions[0]
  const dict = kid(version, 'DATADICT')
  if (!dict) return ['no data dictionary']
  const raw = (el: DezignElement | undefined, tag: string) => (kid(el, tag)?.children.filter((c) => typeof c === 'string').join('') ?? '').trim()
  const idsOf = (el: DezignElement | undefined) => kids(kid(el, 'ATTRIBUTEIDS'), 'ATTRIBUTEID').map((a) => a.children.filter((c) => typeof c === 'string').join('').trim())
  const problems: string[] = []
  const seen = new Map<string, string>()
  const claim = (kind: string, id: string) => {
    if (!id) return
    if (seen.has(id)) problems.push(`duplicate id ${id} (${seen.get(id)}, ${kind})`)
    else seen.set(id, kind)
  }
  const domains = new Set(kids(kid(dict, 'DOMAINS'), 'DOMAIN').map((d) => raw(d, 'ID')))
  const entities = new Map<string, Set<string>>()
  for (const ent of kids(kid(dict, 'ENTITIES'), 'ENT')) {
    const id = raw(ent, 'ID')
    claim('entity', id)
    const attrs = new Set<string>()
    for (const attr of kids(kid(ent, 'ATTRIBUTES'), 'ATTR')) {
      const attrId = raw(attr, 'ID')
      if (attrs.has(attrId)) problems.push(`duplicate attribute id ${attrId} in entity ${id}`)
      attrs.add(attrId)
      const domain = raw(attr, 'DOMAINID')
      // (No domain is empty, 0, or -1 in the files of DeZign 4 to 6.)
      if (domain && domain !== '0' && domain !== '-1' && !domains.has(domain)) problems.push(`attribute ${attrId}: unknown domain ${domain}`)
    }
    entities.set(id, attrs)
    for (const con of [kid(ent, 'PKCON'), ...kids(kid(ent, 'CONSTRAINTS'), 'CONSTRAINT')]) {
      for (const ref of idsOf(con)) if (!attrs.has(ref)) problems.push(`entity ${id}: ${con!.tag} lists unknown attribute ${ref}`)
    }
    for (const ix of kids(kid(ent, 'INDEXES'), 'INDEX')) {
      for (const col of kids(kid(ix, 'IDXCOLS'), 'IDXCOL')) if (!attrs.has(raw(col, 'IDXCOLATTRID'))) problems.push(`entity ${id}: index column of unknown attribute ${raw(col, 'IDXCOLATTRID')}`)
    }
  }
  const subcategories = new Map(kids(kid(dict, 'SUBCATEGORIES'), 'SUBCAT').map((x) => [raw(x, 'ID'), raw(x, 'AOID')]))
  const relationships = new Set<string>()
  for (const [id, owner] of subcategories) if (!entities.has(owner)) problems.push(`subtype cluster ${id}: unknown supertype ${owner}`)
  for (const link of kids(kid(dict, 'SUBCATEGORYCONNECTIONS'))) {
    if (!entities.has(raw(link, 'PARENTOBJECTID')) || !subcategories.has(raw(link, 'CHILDOBJECTID'))) problems.push(`subtype link ${raw(link, 'ID')}: unknown end`)
  }
  for (const rel of kids(kid(dict, 'RELATIONSHIPS'), 'REL')) {
    const id = raw(rel, 'ID')
    claim('relationship', id)
    relationships.add(id)
    const parentId = raw(rel, 'PARENTOBJECTID')
    const parent = entities.get(parentId) ?? entities.get(subcategories.get(parentId) ?? '')
    const child = entities.get(raw(rel, 'CHILDOBJECTID'))
    if (!parent) problems.push(`relationship ${id}: unknown parent ${parentId}`)
    if (!child) problems.push(`relationship ${id}: unknown child ${raw(rel, 'CHILDOBJECTID')}`)
    for (const pair of kids(kid(rel, 'PAIRS'), 'PAIR')) {
      if (parent && !parent.has(raw(pair, 'KEYID'))) problems.push(`relationship ${id}: key ${raw(pair, 'KEYID')} is not in the parent`)
      if (child && !child.has(raw(pair, 'FOREIGNKEYID'))) problems.push(`relationship ${id}: foreign key ${raw(pair, 'FOREIGNKEYID')} is not in the child`)
    }
    // (DeZign 14 converting an older project gives columns new ids and leaves the old numbers in this list: the
    // pairs are what it reads. The number is then the n of `ATTR-<table>-<n>-<token>`.)
    const known = (ref: string) => !child || child.has(ref) || (/^\d+$/.test(ref) && [...child].some((attr) => new RegExp(`^ATTR-.+-${ref}-[^-]+$`).test(attr)))
    for (const ref of idsOf(kid(rel, 'CONSTRAINT'))) if (!known(ref)) problems.push(`relationship ${id}: constraint lists unknown attribute ${ref}`)
  }
  const diagramsEl = kid(version, 'DIAGRAMS')
  const diagrams = new Set(kids(diagramsEl, 'DIAGRAM').map((d) => raw(d, 'ID')))
  const views = new Set(kids(kid(dict, 'VIEWS'), 'VIEW').map((x) => raw(x, 'ID')))
  const texts = new Set(kids(kid(dict, 'TEXTAREAS')).map((x) => raw(x, 'ID')))
  const controls = kid(diagramsEl, 'CONTROLS')
  const placed = new Set<string>()
  const check = (list: string, known: (id: string) => boolean, kind: string) => {
    for (const c of kids(kid(controls, list))) {
      const id = raw(c, 'ID')
      const diagram = raw(c, 'DIAGRAMID')
      if (!known(id)) problems.push(`${kind} control of unknown object ${id}`)
      if (diagram && diagrams.size && !diagrams.has(diagram)) problems.push(`${kind} control ${id} on unknown diagram ${diagram}`)
      if (placed.has(`${kind}|${diagram}|${id}`)) problems.push(`${kind} ${id} is twice on diagram ${diagram}`)
      placed.add(`${kind}|${diagram}|${id}`)
    }
  }
  check('ENTITYCONTROLS', (id) => entities.has(id) || views.has(id), 'entity')
  check('RELATIONSHIPCONNECTORS', (id) => relationships.has(id), 'relationship')
  check('TEXTAREACONTROLS', (id) => texts.has(id), 'text area')
  check('SUBCATEGORYCONTROLS', (id) => subcategories.has(id), 'subtype cluster')
  // The lines from a view to the tables it reads (DeZign 14.5 and later).
  const viewLinks = new Set<string>()
  for (const link of kids(kid(dict, 'VIEWCONNECTIONS'))) {
    viewLinks.add(raw(link, 'ID'))
    if (!views.has(raw(link, 'PARENTOBJECTID')) || !(entities.has(raw(link, 'CHILDOBJECTID')) || views.has(raw(link, 'CHILDOBJECTID')))) problems.push(`view connection ${raw(link, 'ID')}: unknown end`)
  }
  check('VIEWCONNECTORS', (id) => viewLinks.has(id), 'view connection')
  return problems
}

/** What DeZign records about a version archived in a project. */
export interface DezignVersionInfo {
  number: string
  label: string
  /** As written by DeZign (a date, or date and time). */
  date: string
  comments: string
}

/**
 * The versions archived in a project file, in file order (`readDezign(…, { archived: index })` reads one). Also
 * reads the head of a folder project's archived version file: only the leading VERSIONINFO has to be there.
 */
export function listDezignVersions(binary: string, options: Pick<ReadDezignOptions, 'encoding' | 'fallbackEncoding'> = {}): DezignVersionInfo[] {
  const decoder = dezignDecoder(options.encoding ?? detectDezignEncoding(binary, options.fallbackEncoding))
  const decode = (s: string) => unescapeXml(/[\x80-\xff]/.test(s) ? decoder.decode(Uint8Array.from(s, (c) => c.charCodeAt(0))) : s).trim()
  return [...binary.matchAll(/<VERSIONINFO>([\s\S]*?)<\/VERSIONINFO>/g)].map((m) => {
    const field = (tag: string) => decode(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(m[1]!)?.[1] ?? '')
    return { number: field('VERSIONNUMBER'), label: field('VERSIONLABEL'), date: field('VERSIONDATE'), comments: field('VERSIONCOMMENTS') }
  })
}

// A DeZign model opens with its domains listed in a note, one `  name: type` line each: that note is the model's
// list of domains (a column follows one with `[domain: 'name']`), so the text stays the one thing holding the model.
const DOMAINS_NOTE = /Note domains \{\r?\n'''\r?\n[^\n]*\n([\s\S]*?)\r?\n'''\r?\n\}/
const DOMAINS_HEADER = "Domains of the DeZign project. A column follows one with [domain: 'name'] and has its type:"

/** The domains a model's domains note lists. */
export function dezignDomainsOfModel(dbml: string): { name: string; dataType: string }[] {
  return (DOMAINS_NOTE.exec(dbml)?.[1] ?? '')
    .split(/\r?\n/)
    .map((line) => /^ {2}(.+?): (.+)$/.exec(line))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ name: m[1]!.trim(), dataType: m[2]!.trim() }))
}

/** The domains note for `domains` ('' for none). */
export function dezignDomainsNote(domains: { name: string; dataType: string }[]): string {
  return domains.length ? `Note domains {\n'''\n${DOMAINS_HEADER}\n${domains.map((d) => `  ${d.name}: ${d.dataType}`).join('\n')}\n'''\n}` : ''
}

/** The model with its domains note saying `domains` (added at the end when it has none). */
export function withDezignDomains(dbml: string, domains: { name: string; dataType: string }[]): string {
  const note = dezignDomainsNote(domains)
  if (DOMAINS_NOTE.test(dbml)) return dbml.replace(DOMAINS_NOTE, note)
  return note ? `${dbml.replace(/\s*$/, '')}\n\n${note}\n` : dbml
}

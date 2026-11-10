import type { CheckInfo, ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo } from './types.js'

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
  /** `x = (L - originX) * scaleX`: lets a writer turn positions back into DeZign's coordinates. */
  layout: { originX: number; originY: number; scaleX: number; scaleY: number }
}

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
  leftOut: DezignLeftOut
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
const RULES = DEZIGN_RULES

export interface ReadDezignOptions {
  /** Overrides the detected code page. */
  encoding?: DezignEncoding
  /** Code page for text whose letters don't tell (default Western); pass Central European for a Czech, Slovak, Polish… user. */
  fallbackEncoding?: Exclude<DezignEncoding, 'utf-8'>
  /** Size of a table in the target diagram: positions are spread so tables of this size don't overlap. */
  node?: { width: number; header: number; row: number }
}

/** The model of a DeZign project given as a binary string (`.dez` content, or `assembleDezignProject`). */
export function readDezign(binary: string, options: ReadDezignOptions = {}): DezignModel {
  const encoding = options.encoding ?? detectDezignEncoding(binary, options.fallbackEncoding)
  const decoder = new TextDecoder(encoding)
  const decode = (s: string) => (/[\x80-\xff]/.test(s) ? decoder.decode(Uint8Array.from(s, (c) => c.charCodeAt(0))) : s)
  const text = (el: DezignElement | undefined, tag: string): string => {
    const k = kid(el, tag)
    if (!k) return ''
    return unescapeXml(decode(k.children.map((c) => (typeof c === 'string' ? (c.startsWith('<![CDATA[') ? c.slice(9, -3) : c) : '')).join(''))).trim()
  }

  const dezign = kid(parseDezignXml(binary), 'dezign')
  const versions = kids(dezign, 'VERSION')
  // Archived versions carry VERSIONINFO; the working model does not.
  const version = versions.find((v) => !kid(v, 'VERSIONINFO')) ?? versions[0]
  const dict = kid(version, 'DATADICT')
  if (!dezign || !dict) throw new Error('This is not a DeZign for Databases model')

  const formatVersion = text(dezign, 'FILEFORMATVERSION') || text(kid(kid(version, 'PROJECTSETTINGS'), 'COMMONSETTINGS'), 'FILEFORMATVERSION')
  const leftOut: DezignLeftOut = { domains: 0, views: 0, procedures: 0, sequences: 0, triggers: 0, checks: 0, relationshipsWithoutColumns: 0, subdiagrams: 0 }

  const domains = new Map(kids(kid(dict, 'DOMAINS'), 'DOMAIN').map((d) => [text(d, 'ID'), d]))
  leftOut.domains = domains.size
  leftOut.views = kids(kid(dict, 'VIEWS'), 'VIEW').length
  leftOut.procedures = kids(kid(dict, 'PROCEDURES')).length
  leftOut.sequences = kids(kid(dict, 'SEQUENCES')).length

  const typeOf = (dt: DezignElement | undefined): string => {
    const name = text(dt, 'DTLISTNAME').toLowerCase()
    const length = text(dt, 'LE')
    const scale = text(dt, 'PR')
    return name + (length ? `(${length}${scale ? `,${scale}` : ''})` : '')
  }
  const idsOf = (constraint: DezignElement | undefined) => kids(kid(constraint, 'ATTRIBUTEIDS'), 'ATTRIBUTEID').map((a) => unescapeXml(a.children.filter((c) => typeof c === 'string').join('')).trim())

  interface Entity {
    table: TableInfo
    /** Attribute id → column name. Old formats number attributes per entity, new ones use global ids. */
    columns: Map<string, string>
  }
  const entities = new Map<string, Entity>()
  const tables: TableInfo[] = []

  for (const ent of kids(kid(dict, 'ENTITIES'), 'ENT')) {
    const pkIds = idsOf(kid(ent, 'PKCON'))
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
      if (check) checks.push({ expression: check, ...(text(kid(attr, 'CCON'), 'NAME') ? { name: text(kid(attr, 'CCON'), 'NAME') } : {}) })
      const defaultValue = text(kid(attr, 'DEFCON'), 'VALUE') || text(kid(domain, 'DEFCON'), 'VALUE')
      return {
        name,
        ordinal: i + 1,
        dataType: typeOf(dt) || text(domain, 'NAME') || 'text',
        nullable: !isPrimaryKey && text(kid(attr, 'NNCON'), 'VALUE') !== '1',
        defaultValue: defaultValue || null,
        isPrimaryKey,
        isIdentity: text(dt, 'AN') === '1',
        comment: text(attr, 'DESC') || null,
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
    }
    for (const ix of kids(kid(ent, 'INDEXES'), 'INDEX')) {
      const cols = kids(kid(ix, 'IDXCOLS'), 'IDXCOL').map((c) => columnNames.get(text(c, 'IDXCOLATTRID')) ?? text(c, 'NAME')).filter(Boolean)
      // DeZign's automatic index on the primary key is the key itself here.
      if (!cols.length || (text(ix, 'AUTOIDXTYPE') !== '0' && text(ix, 'AUTOIDXTYPE') !== '' && cols.join('\0') === primaryKey.join('\0'))) continue
      indexes.push({ name: text(ix, 'NAME') || `${tableName}_${cols.join('_')}_idx`, columns: cols, unique: /unique/i.test(text(ix, 'INDEXTYPE')), primary: false })
    }
    leftOut.triggers += kids(kid(ent, 'TRIGGERS')).length
    const table: TableInfo = {
      schema: text(ent, 'SCHEMA') || text(ent, 'SCHEMANAME') || undefined,
      name: tableName,
      type: 'table',
      comment: text(ent, 'DESC') || null,
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
    if (text(rel, 'VIRTUALREL') === '1') fk.virtual = true
    child.table.foreignKeys.push(fk)
  }

  const diagramsEl = kid(version, 'DIAGRAMS')
  const diagrams = kids(diagramsEl, 'DIAGRAM')
  leftOut.subdiagrams = Math.max(0, diagrams.length - 1)
  const mainId = text(diagrams.find((d) => text(d, 'ISMAINDIAGRAM') === '1') ?? diagrams[0], 'ID')
  const node = options.node
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 1
  const allControls = kids(kid(kid(diagramsEl, 'CONTROLS'), 'ENTITYCONTROLS'), 'ENTC')
    .map((c) => ({ diagram: kid(c, 'DIAGRAMID') ? text(c, 'DIAGRAMID') : mainId, entity: entities.get(text(c, 'ID')), x: Number(text(c, 'L')), y: Number(text(c, 'T')), w: Number(text(c, 'W')), h: Number(text(c, 'H')), fill: text(c, 'BRUSH').split(',')[1]?.trim() ?? '' }))
    .filter((c): c is { diagram: string; entity: Entity; x: number; y: number; w: number; h: number; fill: string } => !!c.entity && Number.isFinite(c.x) && Number.isFinite(c.y))
  // Delphi colors are 0x00BBGGRR.
  const hex = (color: string) => {
    const n = Number(color)
    return Number.isInteger(n) && n >= 0 ? `#${[n & 255, (n >> 8) & 255, (n >> 16) & 255].map((v) => v.toString(16).padStart(2, '0')).join('')}` : ''
  }
  const defaultFill = text(kid(diagramsEl, 'DisplayPreferences'), 'DEFENTCOLOR')
  const noteTexts = new Map(kids(kid(dict, 'TEXTAREAS')).map((n) => [text(n, 'ID'), text(n, 'TEXT')]))
  const noteControls = kids(kid(kid(diagramsEl, 'CONTROLS'), 'TEXTAREACONTROLS'))
  const diagramOf = (id: string, name: string, main: boolean): DezignDiagram => {
    const controls = allControls.filter((c) => c.diagram === id)
    const out: DezignDiagram = { id, name, main, tables: [], positions: {}, colors: {}, notes: [], layout: { originX: 0, originY: 0, scaleX: 1, scaleY: 1 } }
    if (!controls.length) return out
    // DeZign's tables are smaller than the target's: spread the layout by the typical size ratio.
    const sx = node ? Math.min(3, Math.max(1, median(controls.filter((c) => c.w > 0).map((c) => node.width / c.w)))) : 1
    const sy = node ? Math.min(3, Math.max(1, median(controls.filter((c) => c.h > 0).map((c) => (node.header + node.row * c.entity.table.columns.length) / c.h)))) : 1
    const minX = Math.min(...controls.map((c) => c.x))
    const minY = Math.min(...controls.map((c) => c.y))
    out.layout = { originX: minX, originY: minY, scaleX: sx, scaleY: sy }
    for (const c of controls) {
      const key = `${c.entity.table.schema ?? ''}.${c.entity.table.name}`
      out.tables.push(key)
      out.positions[key] = { x: Math.round((c.x - minX) * sx), y: Math.round((c.y - minY) * sy) }
      if (c.fill && c.fill !== defaultFill && hex(c.fill)) out.colors[key] = hex(c.fill)
    }
    for (const c of noteControls) {
      if ((kid(c, 'DIAGRAMID') ? text(c, 'DIAGRAMID') : mainId) !== id || !noteTexts.get(text(c, 'ID'))) continue
      const [x, y] = [Number(text(c, 'L')), Number(text(c, 'T'))]
      if (Number.isFinite(x) && Number.isFinite(y)) out.notes.push({ id: text(c, 'ID'), text: noteTexts.get(text(c, 'ID'))!, x: Math.round((x - minX) * sx), y: Math.round((y - minY) * sy) })
    }
    return out
  }
  // Old single-diagram files have controls without a diagram to belong to.
  const described = diagrams.length ? diagrams.map((d) => diagramOf(text(d, 'ID'), text(d, 'NAME'), text(d, 'ID') === mainId)) : allControls.length ? [diagramOf(mainId, '', true)] : []
  const main = described.find((d) => d.main)
  const positions = main?.positions ?? {}
  const layout = { diagramId: mainId, ...(main?.layout ?? { originX: 0, originY: 0, scaleX: 1, scaleY: 1 }) }

  return { formatVersion, targetDatabase: text(dict, 'DBID'), encoding, tables, positions, layout, diagrams: described, leftOut }
}

const PROJECT_SECTIONS: [folder: string, element: string][] = [
  ['domains', 'DOMAINS'],
  ['entities', 'ENTITIES'],
  ['subcategories', 'SUBCATEGORIES'],
  ['sequences', 'SEQUENCES'],
  ['procedures', 'PROCEDURES'],
  ['views', 'VIEWS'],
  ['textareas', 'TEXTAREAS'],
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
  const controls = `<ENTITYCONTROLS>${inDir('diagrams', 'diagramobjects', 'entitycontrols')}</ENTITYCONTROLS>\n<TEXTAREACONTROLS>${inDir('diagrams', 'diagramobjects', 'textareacontrols')}</TEXTAREACONTROLS>`
  return `<?xml version="1.0" encoding="iso-8859-1"?><dezign>\n<VERSION>\n${settings}\n<DATADICT>${header}\n${sections}</DATADICT>\n<DIAGRAMS>${top('.ddp')}\n${inDir('diagrams')}\n<CONTROLS>${controls}</CONTROLS></DIAGRAMS>\n</VERSION>\n</dezign>`
}

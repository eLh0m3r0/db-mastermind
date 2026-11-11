import { detectDezignEncoding, type DezignEncoding } from './dezign.js'
import { codec, type DezignFile } from './dezign-write.js'

/**
 * A folder project (one XML file per object) as the one `<VERSION>` element a single-file project holds, in
 * DeZign's layout: which folder fills which element, in DeZign's order. This is what DeZign archives as a
 * version of a folder project (`archived versions/<id>.xml`) and what "Save project as → Single file" writes.
 * Checked against the two forms DeZign 14.9.3 saved of one model: the same bytes but for the project's own path.
 */
const DICTIONARY: [folder: string, element: string][] = [
  ['domains', 'DOMAINS'],
  ['entities', 'ENTITIES'],
  ['subcategories', 'SUBCATEGORIES'],
  ['textareas', 'TEXTAREAS'],
  ['groupboxes', 'GROUPBOXES'],
  ['stamps', 'STAMPS'],
  ['sequences', 'SEQUENCES'],
  ['procedures', 'PROCEDURES'],
  ['views', 'VIEWS'],
  ['relationships', 'RELATIONSHIPS'],
  ['subcategoryconnections', 'SUBCATEGORYCONNECTIONS'],
  ['viewconnections', 'VIEWCONNECTIONS'],
  ['user defined properties', 'USERDEFINEDPROPERTIES'],
]
const CONTROLS: [folder: string, element: string][] = [
  ['entitycontrols', 'ENTITYCONTROLS'],
  ['subcategorycontrols', 'SUBCATEGORYCONTROLS'],
  ['textareacontrols', 'TEXTAREACONTROLS'],
  ['stampcontrols', 'STAMPCONTROLS'],
  ['groupboxcontrols', 'GROUPBOXESCONTROLS'],
  ['viewcontrols', 'VIEWCONTROLS'],
  ['relationshipconnectors', 'RELATIONSHIPCONNECTORS'],
  ['subcategoryconnectors', 'SUBCATEGORYCONNECTORS'],
  ['viewconnectors', 'VIEWCONNECTORS'],
]

/**
 * The project's files as one `<VERSION>…</VERSION>` (no XML declaration), with `info` (a `<VERSIONINFO>` element)
 * as its first child when it is an archived version. Throws on a part of the project it does not know where to
 * put: a snapshot that silently leaves something out is worse than none.
 */
export function dezignFolderAsVersion(files: DezignFile[], info = ''): string {
  const project = files.find((f) => /\.dezproj$/i.test(f.path) && !/[\\/]/.test(f.path))
  if (!project) throw new Error('The folder has no .dezproj file')
  const nl = project.text.includes('\r\n') ? '\r\n' : '\n'
  const body = (text: string) => text.replace(/^﻿?\s*<\?xml[^>]*\?>\s*/, '').trimEnd()
  const parts = files.map((f) => ({ dir: f.path.replaceAll('\\', '/').toLowerCase().split('/').slice(0, -1).join('/'), name: f.path.replaceAll('\\', '/').split('/').pop()!, text: f.text }))
  const used = new Set<string>()
  // (In the order of the file names as text, `105.xml` before `8.xml`: the order DeZign itself writes them in.)
  const inDir = (dir: string) => {
    used.add(dir)
    return parts.filter((p) => p.dir === dir && /\.xml$/i.test(p.name)).sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1)).map((p) => body(p.text))
  }
  const top = (ext: string) => body(parts.find((p) => p.dir === '' && p.name.toLowerCase().endsWith(ext))?.text ?? '')
  const element = (tag: string, children: string[]) => [`<${tag}>`, ...children, `</${tag}>`]
  // (The dictionary's own file holds its header, the database the model is for.)
  const header = top('.dds').replace(/^<DATADICT>\s*/, '').replace(/\s*<\/DATADICT>$/, '')
  const lines = [
    '<VERSION>',
    ...(info ? [info.trim()] : []),
    top('.dezproj'),
    ...element('DATADICT', [...(header ? [header] : []), ...DICTIONARY.flatMap(([folder, tag]) => element(tag, inDir(`data dictionary/${folder}`)))]),
    ...element('DIAGRAMS', [...(top('.ddp') ? [top('.ddp')] : []), ...inDir('diagrams'), ...element('CONTROLS', CONTROLS.flatMap(([folder, tag]) => element(tag, inDir(`diagrams/diagramobjects/${folder}`))))]),
    ...element('LABELS', inDir('labels')),
    '</VERSION>',
  ]
  const unknown = [...new Set(parts.filter((p) => /\.xml$/i.test(p.name) && p.dir && !used.has(p.dir) && !p.dir.startsWith('archived versions')).map((p) => p.dir))]
  if (unknown.length) throw new Error(`This DeZign project has parts that are not known here (${unknown.join(', ')}): no version was made of it`)
  return lines.join('\n').replace(/\r?\n/g, nl) + nl
}

export interface DezignArchiveRequest {
  label?: string
  comments?: string
  /** The project's code page (default: told by its text, `fallbackEncoding` when it can't be). */
  encoding?: DezignEncoding
  fallbackEncoding?: Exclude<DezignEncoding, 'utf-8'>
  /** Local time as DeZign writes it, `yyyy-mm-dd hh:mm:ss` (default: now). */
  date?: string
  /** Default: a new GUID, as DeZign 14 makes one. */
  id?: string
}

const localStamp = (d = new Date()) => {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

/**
 * Archives the project as it is now, as DeZign's File → Versions → "Archive current version" does: a copy of
 * the whole model with a `VERSIONINFO` (number one past the highest, label "Version <date>" unless given). A
 * single-file project gets the copy as another `<VERSION>` element right after the current one; a folder project
 * gets `archived versions/<id>.xml`. Both checked against what DeZign 14.9.3 writes. `existing` are the version
 * numbers the project already has (a folder project keeps them in files the caller lists).
 * Returns the files to write.
 */
export function archiveDezignVersion(files: DezignFile[], request: DezignArchiveRequest = {}, existing: number[] = []): { files: DezignFile[]; number: number; id: string } {
  const folder = files.some((f) => /\.dezproj$/i.test(f.path) && !/[\\/]/.test(f.path))
  const single = folder ? undefined : files[0]
  if (!folder && !single) throw new Error('No DeZign project to archive')
  const numbers = [...existing, ...(single ? [...single.text.matchAll(/<VERSIONNUMBER>\s*(\d+)\s*<\/VERSIONNUMBER>/g)].map((m) => Number(m[1])) : [])]
  const number = Math.max(0, ...numbers) + 1
  const date = request.date ?? localStamp()
  const id = request.id ?? globalThis.crypto.randomUUID().toUpperCase()
  const text = folder ? files.find((f) => /\.dezproj$/i.test(f.path))!.text : single!.text
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  // Label and comments in the project's own code page, escaped as DeZign escapes text.
  const { encode } = codec(request.encoding ?? detectDezignEncoding(folder ? files.map((f) => f.text).join('') : text, request.fallbackEncoding), nl)
  const dbid = /<DBID>([^<]*)<\/DBID>/.exec(folder ? (files.find((f) => /\.dds$/i.test(f.path))?.text ?? '') : text)?.[1] ?? ''
  const info = [
    '<VERSIONINFO>',
    `<VERSIONID>${id}</VERSIONID>`,
    `<VERSIONNUMBER>${number}</VERSIONNUMBER>`,
    `<VERSIONLABEL>${encode(request.label?.trim() || `Version ${date}`)}</VERSIONLABEL>`,
    `<VERSIONDATE>${date}</VERSIONDATE>`,
    `<VERSIONCOMMENTS>${encode(request.comments ?? '')}</VERSIONCOMMENTS>`,
    '<VERSIONTYPE></VERSIONTYPE>',
    '<VERSIONTYPEDESC>Diagrams and data dictionary</VERSIONTYPEDESC>',
    `<VERSIONDBID>${dbid}</VERSIONDBID>`,
    '</VERSIONINFO>',
  ].join(nl)
  if (folder) {
    const dir = files.map((f) => f.path.replaceAll('\\', '/')).find((p) => /^archived versions\//i.test(p))?.split('/')[0] ?? 'archived versions'
    // (The declaration and the element on one line: DeZign's own archived files start that way.)
    const body = dezignFolderAsVersion(files.filter((f) => !/^archived versions[\\/]/i.test(f.path)), info)
    return { files: [{ path: `${dir}/${id}.xml`, text: `<?xml version="1.0" encoding="iso-8859-1"?>${body}` }], number, id }
  }
  // The current model is the first VERSION without a VERSIONINFO; its copy goes right after it.
  const start = /<VERSION>(?!\s*<VERSIONINFO>)/.exec(text)
  if (!start) throw new Error('This is not a DeZign for Databases model')
  const end = text.indexOf('</VERSION>', start.index)
  if (end === -1) throw new Error('This DeZign file is cut short')
  const inner = text.slice(start.index + '<VERSION>'.length, end).replace(/^\r?\n/, '')
  const copy = `<VERSION>${nl}${info}${nl}${inner}</VERSION>${nl}`
  const at = end + '</VERSION>'.length
  return { files: [{ path: single!.path, text: text.slice(0, at) + copy + text.slice(at) }], number, id }
}

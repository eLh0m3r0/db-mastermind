import { readFile, stat, writeFile } from 'node:fs/promises'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { detectDezignEncoding, dezignDecoder } from '@dbmastermind/core'
import type { SqlFile, SqlFileFormat } from '@shared/api'

const BOM = '﻿'

/** Central European languages save 8-bit files in Windows-1250, the rest of Europe and America in Windows-1252. */
export const legacyCodePage = (locale = Intl.DateTimeFormat().resolvedOptions().locale): 'windows-1250' | 'windows-1252' =>
  /^(cs|sk|pl|hu|sl|hr|ro|sq|bs|sr-Latn)\b/i.test(locale) ? 'windows-1250' : 'windows-1252'

/**
 * Text of a .sql file: UTF-16 with a byte order mark (SSMS's "Unicode"), UTF-8 with or without one, else the
 * Windows code page whose letters the file uses (the system language decides when the bytes don't tell).
 */
export function decodeSqlFile(buffer: Uint8Array, fallback = legacyCodePage()): { text: string; format: SqlFileFormat } {
  const { raw, encoding, bom } = decodeRaw(buffer, fallback)
  // The editor works with \n; the file keeps its own line endings when written back (see `keepLineEndings`).
  const crlf = raw.match(/\r\n/g)?.length ?? 0
  const lf = (raw.match(/\n/g)?.length ?? 0) - crlf
  const eol = crlf > lf ? '\r\n' : '\n'
  return { text: raw.replace(/\r\n/g, '\n'), format: { encoding, bom, eol } }
}

/** The file's text with its own line endings, without the BOM. */
function decodeRaw(buffer: Uint8Array, fallback: 'windows-1250' | 'windows-1252'): { raw: string; encoding: SqlFileFormat['encoding']; bom: boolean } {
  let text: string
  let encoding: SqlFileFormat['encoding'] = 'utf-8'
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    encoding = 'utf-16le'
    text = new TextDecoder('utf-16le').decode(buffer.subarray(2))
  } else if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    encoding = 'utf-16be'
    text = new TextDecoder('utf-16be').decode(buffer.subarray(2))
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer)
    } catch {
      const detected = detectDezignEncoding(Buffer.from(buffer).toString('latin1'), fallback)
      encoding = detected === 'utf-8' ? fallback : detected
      text = dezignDecoder(encoding).decode(buffer)
    }
  }
  // A UTF-16 file's byte order mark was taken off its bytes above.
  const inText = text.startsWith(BOM)
  if (inText) text = text.slice(1)
  return { raw: text, encoding, bom: inText || encoding.startsWith('utf-16') }
}

/**
 * The file's text for the editor's text: its own line endings and BOM (see `fileBytes` for the encoding). `previous`:
 * the file's text as it is on disk; when its line endings are mixed, lines the editor did not change keep their own.
 */
export function encodeSqlFile(text: string, format: Pick<SqlFileFormat, 'bom' | 'eol'>, previous?: string): string {
  const lines = text.replace(/\r\n/g, '\n')
  const mixed = previous !== undefined && /\r\n/.test(previous) && /(^|[^\r])\n/.test(previous)
  const body = mixed ? keepLineEndings(previous, lines, format.eol) : lines.replace(/\n/g, format.eol)
  return (format.bom ? BOM : '') + body
}

/** Changed regions larger than this (lines × lines) give their lines the file's usual ending instead of matching. */
const MATCH_LIMIT = 4_000_000

/** `text` (\n only) with the endings of `previous`: an unchanged line keeps its own, a new or edited one gets `eol`. */
export function keepLineEndings(previous: string, text: string, eol: string): string {
  const old = previous.split('\n')
  const oldEnds = old.map((l) => (l.endsWith('\r') ? '\r\n' : '\n'))
  const oldLines = old.map((l, i) => (i < old.length - 1 && l.endsWith('\r') ? l.slice(0, -1) : l))
  const lines = text.split('\n')
  // ends[i]: the ending after line i (the last line has none).
  const ends: (string | undefined)[] = new Array(lines.length).fill(undefined)
  const n = lines.length - 1
  const m = oldLines.length - 1
  // Unchanged lines at the start and at the end, then the longest common subsequence of the region between.
  let head = 0
  while (head < n && head < m && lines[head] === oldLines[head]) ends[head] = oldEnds[head++]
  let tail = 0
  while (tail < n - head && tail < m - head && lines[n - 1 - tail] === oldLines[m - 1 - tail]) {
    ends[n - 1 - tail] = oldEnds[m - 1 - tail]
    tail++
  }
  const a = lines.slice(head, n - tail)
  const b = oldLines.slice(head, m - tail)
  if (a.length && b.length && a.length * b.length <= MATCH_LIMIT) {
    const width = b.length + 1
    const lcs = new Uint32Array((a.length + 1) * width)
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!)
    let i = 0
    let j = 0
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) ends[head + i++] = oldEnds[head + j++]
      else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) i++
      else j++
    }
  }
  return lines.map((l, i) => l + (i < n ? (ends[i] ?? eol) : '')).join('')
}

const codePages = new Map<string, Map<string, number>>()
/** Character → byte of a Windows code page, made from its own decoder (Node has no encoder for them). */
function codePage(encoding: 'windows-1250' | 'windows-1252'): Map<string, number> {
  let map = codePages.get(encoding)
  if (!map) {
    map = new Map()
    const decoder = dezignDecoder(encoding)
    for (let b = 0; b < 256; b++) {
      const c = decoder.decode(Uint8Array.of(b))
      if (c !== '\ufffd' && !map.has(c)) map.set(c, b)
    }
    codePages.set(encoding, map)
  }
  return map
}

/**
 * The file's bytes in its own encoding: UTF-16 stays UTF-16 (tools that wrote it expect it), a Windows code page
 * stays that code page, so an unchanged byte is written back as it was even when the detection guessed the wrong
 * code page (ù and ů are both 0xF9). Only text the code page can't hold (an emoji, letters of another script) is
 * written as UTF-8 instead: changing it is still better than losing what was typed.
 */
export function fileBytes(text: string, format: SqlFileFormat, previous?: string): Buffer {
  const encoded = encodeSqlFile(text, { ...format, bom: format.encoding.startsWith('utf-16') || format.bom }, previous)
  if (format.encoding === 'utf-16le') return Buffer.from(encoded, 'utf16le')
  if (format.encoding === 'utf-16be') return Buffer.from(encoded, 'utf16le').swap16()
  if (format.encoding === 'windows-1250' || format.encoding === 'windows-1252') {
    const map = codePage(format.encoding)
    const bytes: number[] = []
    for (const c of encoded) {
      const b = map.get(c)
      if (b === undefined) return Buffer.from(encoded, 'utf8')
      bytes.push(b)
    }
    return Buffer.from(bytes)
  }
  return Buffer.from(encoded, 'utf8')
}

export async function readSqlFile(path: string): Promise<SqlFile> {
  const [buffer, info] = await Promise.all([readFile(path), stat(path)])
  const { text, format } = decodeSqlFile(buffer)
  return { path, name: path.split(/[\\/]/).pop() ?? path, text, format, mtimeMs: info.mtimeMs }
}

/**
 * Above this a .sql file opens only when the person agrees (a 300 MB dump is read, decoded and sent to the window
 * whole), and its tab's text is not saved with the workspace.
 */
export const LARGE_SQL_FILE = 5 * 1024 * 1024

export async function sqlFileSize(path: string): Promise<number> {
  return (await stat(path)).size
}

export async function sqlFileTime(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return null
  }
}

export class SqlFileChangedError extends Error {
  override name = 'SqlFileChangedError'
  readonly code = 'FILE_CHANGED'
  constructor() {
    super('The file was changed on disk since it was opened.')
  }
}

export class SqlFileMissingError extends Error {
  override name = 'SqlFileMissingError'
  readonly code = 'FILE_MISSING'
  constructor() {
    super('The file was moved or deleted.')
  }
}

/**
 * Writes the editor's text back. `expectedMtimeMs`: the file as the tab last read or wrote it; a file changed since
 * (another editor, a Git checkout) is not overwritten unless `force`. Returns the new modification time.
 */
export async function writeSqlFile(path: string, text: string, format: SqlFileFormat, options: { expectedMtimeMs?: number; force?: boolean } = {}): Promise<number> {
  const current = await sqlFileTime(path)
  if (current === null && !options.force) throw new SqlFileMissingError()
  if (!options.force && options.expectedMtimeMs !== undefined && current !== null && Math.abs(current - options.expectedMtimeMs) > 1) throw new SqlFileChangedError()
  // Mixed line endings: each line the editor didn't change is written with its own (Git shows only the edits).
  const previous = current === null ? undefined : decodeRaw(await readFile(path), format.encoding === 'windows-1250' || format.encoding === 'windows-1252' ? format.encoding : legacyCodePage()).raw
  await writeFile(path, fileBytes(text, format, previous))
  return (await stat(path)).mtimeMs
}

/** Files picked in the Open / Save dialogs: any extension ("All files"). Kept in main's data folder for restored tabs. */
const chosenSqlFiles = new Set<string>()
/** The most recent ones are kept: enough for every tab anybody keeps open. */
const CHOSEN_LIMIT = 500
let chosenFile: string | undefined

/** Where the list lives (main's data folder); read once from there. Main sets it, the renderer never can. */
export function keepChosenSqlFilesIn(file: string): void {
  chosenFile = file
  chosenSqlFiles.clear()
  try {
    const list: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(list)) for (const p of list.slice(-CHOSEN_LIMIT)) if (typeof p === 'string') chosenSqlFiles.add(p)
  } catch {
    // None yet, or unreadable: dialogs fill it again.
  }
}

export function rememberChosenSqlFile(path: string): void {
  const full = resolve(path)
  chosenSqlFiles.delete(full)
  chosenSqlFiles.add(full)
  while (chosenSqlFiles.size > CHOSEN_LIMIT) chosenSqlFiles.delete(chosenSqlFiles.values().next().value!)
  if (!chosenFile) return
  try {
    mkdirSync(dirname(chosenFile), { recursive: true })
    const tmp = `${chosenFile}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify([...chosenSqlFiles]), 'utf8')
    renameSync(tmp, chosenFile)
  } catch {
    // Not kept for the next start; this session still knows it.
  }
}

/**
 * A path that came from the renderer: only .sql files, or a file the user picked in a dialog. The renderer must not
 * be able to read or write anything else (~/.zshrc, keys, the app's own data).
 */
export function checkSqlFilePath(path: string): string {
  const full = resolve(path)
  if (/\.sql$/i.test(full) || chosenSqlFiles.has(full)) return full
  throw new Error('Only .sql files can be opened or saved here')
}

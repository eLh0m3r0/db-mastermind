import { readFile, stat, writeFile } from 'node:fs/promises'
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
  const bom = inText || encoding.startsWith('utf-16')
  // The editor works with \n; the file keeps its own line endings when written back.
  const eol = /\r\n/.test(text) ? '\r\n' : '\n'
  return { text: text.replace(/\r\n/g, '\n'), format: { encoding, bom, eol } }
}

/** The file's text for the editor's text: its own line endings and BOM (see `fileBytes` for the encoding). */
export function encodeSqlFile(text: string, format: Pick<SqlFileFormat, 'bom' | 'eol'>): string {
  const body = text.replace(/\r\n/g, '\n').replace(/\n/g, format.eol)
  return (format.bom ? BOM : '') + body
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
export function fileBytes(text: string, format: SqlFileFormat): Buffer {
  const encoded = encodeSqlFile(text, { ...format, bom: format.encoding.startsWith('utf-16') || format.bom })
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
  await writeFile(path, fileBytes(text, format))
  return (await stat(path)).mtimeMs
}

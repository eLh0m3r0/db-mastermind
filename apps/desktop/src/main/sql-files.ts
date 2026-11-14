import { readFile, stat, writeFile } from 'node:fs/promises'
import type { SqlFile, SqlFileFormat } from '@shared/api'

const BOM = '﻿'

/** Text of a .sql file: UTF-8 (with or without a BOM), else Windows-1250 as Czech Windows tools save it. */
export function decodeSqlFile(buffer: Uint8Array): { text: string; format: SqlFileFormat } {
  let text: string
  let encoding: SqlFileFormat['encoding'] = 'utf-8'
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer)
  } catch {
    encoding = 'windows-1250'
    text = new TextDecoder('windows-1250').decode(buffer)
  }
  const bom = text.startsWith(BOM)
  if (bom) text = text.slice(1)
  // The editor works with \n; the file keeps its own line endings when written back.
  const eol = /\r\n/.test(text) ? '\r\n' : '\n'
  return { text: text.replace(/\r\n/g, '\n'), format: { encoding, bom, eol } }
}

/** The file's bytes for the editor's text: its own line endings and BOM, always UTF-8 (see `encoding` note). */
export function encodeSqlFile(text: string, format: Pick<SqlFileFormat, 'bom' | 'eol'>): string {
  const body = text.replace(/\r\n/g, '\n').replace(/\n/g, format.eol)
  return (format.bom ? BOM : '') + body
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
  await writeFile(path, encodeSqlFile(text, format), 'utf8')
  return (await stat(path)).mtimeMs
}

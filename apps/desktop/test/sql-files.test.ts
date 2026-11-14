import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { decodeSqlFile, encodeSqlFile, readSqlFile, writeSqlFile } from '../src/main/sql-files'

const dir = mkdtempSync(join(tmpdir(), 'dbm-sqlfiles-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('decodeSqlFile / encodeSqlFile', () => {
  it('reads UTF-8 with a BOM and CRLF, and writes it back byte for byte', () => {
    const original = '﻿SELECT 1;\r\n-- Žluťoučký kůň\r\nSELECT 2;\r\n'
    const { text, format } = decodeSqlFile(Buffer.from(original, 'utf8'))
    expect(text).toBe('SELECT 1;\n-- Žluťoučký kůň\nSELECT 2;\n')
    expect(format).toEqual({ encoding: 'utf-8', bom: true, eol: '\r\n' })
    expect(encodeSqlFile(text, format)).toBe(original)
  })

  it('reads Windows-1250 (not valid UTF-8) and says so', () => {
    // "Příliš" in Windows-1250.
    const bytes = Uint8Array.from([0x50, 0xf8, 0xed, 0x6c, 0x69, 0x9a, 0x0a])
    const { text, format } = decodeSqlFile(bytes)
    expect(text).toBe('Příliš\n')
    expect(format).toEqual({ encoding: 'windows-1250', bom: false, eol: '\n' })
  })

  it('writes the editor’s \\n line ends as the file’s own', () => {
    expect(encodeSqlFile('a\nb\n', { bom: false, eol: '\r\n' })).toBe('a\r\nb\r\n')
    expect(encodeSqlFile('a\r\nb', { bom: false, eol: '\n' })).toBe('a\nb')
  })
})

describe('writeSqlFile', () => {
  it('writes back a file nobody else changed', async () => {
    const path = join(dir, 'a.sql')
    writeFileSync(path, 'SELECT 1;\r\n')
    const file = await readSqlFile(path)
    const mtime = await writeSqlFile(path, 'SELECT 2;\n', file.format, { expectedMtimeMs: file.mtimeMs })
    expect(readFileSync(path, 'utf8')).toBe('SELECT 2;\r\n')
    expect(mtime).toBeGreaterThan(0)
  })

  it('refuses to overwrite a file changed on disk since it was read, unless forced', async () => {
    const path = join(dir, 'b.sql')
    writeFileSync(path, 'SELECT 1;\n')
    const file = await readSqlFile(path)
    writeFileSync(path, 'SELECT 99;\n')
    const later = new Date(Date.now() + 5000)
    utimesSync(path, later, later)
    await expect(writeSqlFile(path, 'SELECT 2;\n', file.format, { expectedMtimeMs: file.mtimeMs })).rejects.toMatchObject({ code: 'FILE_CHANGED' })
    expect(readFileSync(path, 'utf8')).toBe('SELECT 99;\n')
    await writeSqlFile(path, 'SELECT 2;\n', file.format, { expectedMtimeMs: file.mtimeMs, force: true })
    expect(readFileSync(path, 'utf8')).toBe('SELECT 2;\n')
  })

  it('says when the file is gone instead of creating it again silently', async () => {
    await expect(writeSqlFile(join(dir, 'gone.sql'), 'x', { encoding: 'utf-8', bom: false, eol: '\n' }, { expectedMtimeMs: 1 })).rejects.toMatchObject({ code: 'FILE_MISSING' })
  })
})

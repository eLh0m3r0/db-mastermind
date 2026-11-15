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

  it('reads Windows-1252 by its letters, also on a Czech system, with € and quotes intact', () => {
    // "Café “à la carte” €5" in Windows-1252.
    const bytes = Buffer.from([...Buffer.from('Caf'), 0xe9, 0x20, 0x93, 0xe0, 0x20, 0x6c, 0x61, 0x20, 0x63, 0x61, 0x72, 0x74, 0x65, 0x94, 0x20, 0x80, 0x35])
    const { text, format } = decodeSqlFile(bytes, 'windows-1250')
    expect(text).toBe('Café “à la carte” €5')
    expect(format.encoding).toBe('windows-1252')
  })

  it('falls back to the system language’s code page when the letters don’t tell', () => {
    // "é" alone is the same byte in both code pages.
    expect(decodeSqlFile(Uint8Array.from([0xe9]), 'windows-1250').format.encoding).toBe('windows-1250')
    expect(decodeSqlFile(Uint8Array.from([0xe9]), 'windows-1252').format.encoding).toBe('windows-1252')
  })

  it('reads UTF-16 with a byte order mark (SSMS "Unicode") and writes it back as it was', async () => {
    for (const [encoding, bytes] of [
      ['utf-16le', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('SELECT N\'Žluť\';\r\n', 'utf16le')])],
      ['utf-16be', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('SELECT N\'Žluť\';\r\n', 'utf16le').swap16()])],
    ] as const) {
      const path = join(dir, `${encoding}.sql`)
      writeFileSync(path, bytes)
      const file = await readSqlFile(path)
      expect(file.text).toBe("SELECT N'Žluť';\n")
      expect(file.format).toEqual({ encoding, bom: true, eol: '\r\n' })
      await writeSqlFile(path, file.text, file.format, { expectedMtimeMs: file.mtimeMs })
      expect(readFileSync(path).equals(bytes)).toBe(true)
    }
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

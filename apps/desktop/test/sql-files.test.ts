import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkSqlFilePath, decodeSqlFile, encodeSqlFile, fileBytes, keepLineEndings, readSqlFile, rememberChosenSqlFile, writeSqlFile } from '../src/main/sql-files'

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

  it('writes a code page file back in its code page, byte for byte even when the guess was wrong', async () => {
    // "SELECT 'più'" in Windows-1252: 0xF9 also is ů in Windows-1250, which the letters suggest.
    const bytes = Buffer.from([...Buffer.from("SELECT 'pi"), 0xf9, 0x27, 0x0d, 0x0a])
    const path = join(dir, 'cp.sql')
    writeFileSync(path, bytes)
    const file = await readSqlFile(path)
    await writeSqlFile(path, file.text, file.format, { expectedMtimeMs: file.mtimeMs })
    expect(readFileSync(path).equals(bytes)).toBe(true)
    // An edit stays in the code page too.
    const edited = await readSqlFile(path)
    await writeSqlFile(path, `${edited.text}-- č\n`, edited.format, { expectedMtimeMs: edited.mtimeMs })
    expect(decodeSqlFile(readFileSync(path), edited.format.encoding as 'windows-1250').text).toBe(`${edited.text}-- č\n`)
  })

  it('writes UTF-8 only when the code page cannot hold what was typed', () => {
    const format = { encoding: 'windows-1250', bom: false, eol: '\n' } as const
    expect(fileBytes('Příliš\n', format).equals(Buffer.from([0x50, 0xf8, 0xed, 0x6c, 0x69, 0x9a, 0x0a]))).toBe(true)
    expect(fileBytes('日本\n', format).toString('utf8')).toBe('日本\n')
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

describe('mixed line endings', () => {
  it('a line the editor did not change keeps its own ending', async () => {
    const path = join(dir, 'mixed.sql')
    writeFileSync(path, 'SELECT 1;\nSELECT 2;\r\nSELECT 3;\nSELECT 4;\nSELECT 5;\r\nSELECT 6;\n')
    const file = await readSqlFile(path)
    expect(file.format.eol).toBe('\n')
    await writeSqlFile(path, file.text.replace('SELECT 3;', 'SELECT 33;').replace('SELECT 4;\n', 'SELECT 4;\nSELECT 4b;\n'), file.format, { expectedMtimeMs: file.mtimeMs })
    expect(readFileSync(path, 'utf8')).toBe('SELECT 1;\nSELECT 2;\r\nSELECT 33;\nSELECT 4;\nSELECT 4b;\nSELECT 5;\r\nSELECT 6;\n')
  })

  it('matches unchanged lines between edits and gives new ones the usual ending', () => {
    expect(keepLineEndings('a\r\nb\nc\r\nd\n', 'x\nb\ny\nd\n', '\r\n')).toBe('x\r\nb\ny\r\nd\n')
    expect(keepLineEndings('a\r\nb', 'a\nb\nc', '\n')).toBe('a\r\nb\nc')
  })
})

describe('paths from the window', () => {
  it('only .sql files, or a file the user picked in a dialog', () => {
    expect(checkSqlFilePath(join(dir, 'x.SQL'))).toBe(join(dir, 'x.SQL'))
    expect(() => checkSqlFilePath(join(dir, '.zshrc'))).toThrow(/Only .sql/)
    expect(() => checkSqlFilePath(join(dir, 'notes.txt'))).toThrow(/Only .sql/)
    rememberChosenSqlFile(join(dir, 'notes.txt'))
    expect(checkSqlFilePath(join(dir, 'notes.txt'))).toBe(join(dir, 'notes.txt'))
  })
})

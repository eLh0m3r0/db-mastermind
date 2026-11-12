import { mkdtempSync as makeTemp, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { afterAll, describe, expect, it } from 'vitest'
import { createExportWriter, exportResultSet, sheetNames } from '../src/main/export'

// Folders made here go when the file's tests are done.
const made: string[] = []
const mkdtempSync = (prefix: string) => {
  const dir = makeTemp(prefix)
  made.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

const unzipText = (path: string) => Object.fromEntries(Object.entries(unzipSync(readFileSync(path))).map(([name, data]) => [name, strFromU8(data)]))

describe('Exporting every result of a script', () => {
  const results = [
    { name: 'Result 1', fields: [{ name: 'id' }, { name: 'name' }], rows: [[1, 'Káva'], [2, 'Čaj']] },
    { name: 'Result 2', fields: [{ name: 'total' }], rows: [[10.5]] },
  ]

  it('writes an Excel workbook with a sheet per result', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'dbm-xlsx-')), 'all.xlsx')
    await exportResultSet(path, 'xlsx', results)
    const parts = unzipText(path)
    expect(parts['xl/workbook.xml']).toContain('<sheet name="Result 1" sheetId="1" r:id="rId1"/><sheet name="Result 2" sheetId="2" r:id="rId2"/>')
    expect(parts['xl/workbook.xml']).toContain(`localSheetId="1" hidden="1">'Result 2'!$A$1:$A$2</definedName>`)
    expect(parts['xl/_rels/workbook.xml.rels']).toContain('Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"')
    expect(parts['[Content_Types].xml']).toContain('/xl/worksheets/sheet2.xml')
    expect(parts['xl/worksheets/sheet1.xml']).toContain('tabSelected="1"')
    expect(parts['xl/worksheets/sheet2.xml']).not.toContain('tabSelected')
    expect(parts['xl/worksheets/sheet1.xml']).toContain('<dimension ref="A1:B3"/>')
    expect(parts['xl/worksheets/sheet2.xml']).toContain('<c r="A2"><v>10.5</v></c>')
  })

  it('puts other formats in a ZIP with a file per result', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'dbm-zip-')), 'all.zip')
    await exportResultSet(path, 'csv', results)
    const files = unzipText(path)
    expect(Object.keys(files)).toEqual(['Result 1.csv', 'Result 2.csv'])
    // TextDecoder drops the BOM Excel needs; it is in the bytes.
    expect([...unzipSync(readFileSync(path))['Result 1.csv']!.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(files['Result 1.csv']).toBe('id,name\r\n1,Káva\r\n2,Čaj\r\n')
    expect(files['Result 2.csv']).toBe('total\r\n10.5\r\n')
  })

  it('makes sheet names Excel accepts', () => {
    expect(sheetNames(['a/b:c', 'A/B:C', "'quoted'", '', 'x'.repeat(40), 'x'.repeat(40)])).toEqual(['a b c', 'A B C (2)', 'quoted', 'Sheet4', 'x'.repeat(31), `${'x'.repeat(27)} (2)`])
  })
})

async function exportXlsx(rows: unknown[][]) {
  const path = join(mkdtempSync(join(tmpdir(), 'dbm-xlsx-')), 'out.xlsx')
  const writer = createExportWriter(path, 'xlsx', [{ name: 'name' }, { name: 'total' }, { name: 'paid' }])
  await writer.writeRows(rows as never)
  await writer.close()
  return Object.fromEntries(Object.entries(unzipSync(readFileSync(path))).map(([name, data]) => [name, strFromU8(data)]))
}

describe('Excel export', () => {
  it('has the parts Excel writes itself', async () => {
    const parts = await exportXlsx([['Káva', 10.5, true]])
    expect(Object.keys(parts)).toEqual(expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'docProps/core.xml', 'docProps/app.xml']))
    expect(parts['xl/styles.xml']).toContain('<cellStyle name="Normal" xfId="0" builtinId="0"/>')
    expect(parts['xl/worksheets/sheet1.xml']).toContain('<dimension ref="A1:C2"/>')
    expect(parts['xl/workbook.xml']).toContain('Data!$A$1:$C$2')
    expect(parts['xl/worksheets/sheet1.xml']).toContain('<c r="B2"><v>10.5</v></c>')
    expect(parts['xl/worksheets/sheet1.xml']).toContain('<c r="C2" t="b"><v>1</v></c>')
  })

  it('leaves out characters XML can not hold, so the file stays valid UTF-8', async () => {
    const sheet = (await exportXlsx([['a\u0001b￿c\uD800d😀e', null, false]]))['xl/worksheets/sheet1.xml']
    expect(sheet).toContain('<t xml:space="preserve">abcd😀e</t>')
    expect(sheet).not.toContain('<c r="B2"')
  })
})

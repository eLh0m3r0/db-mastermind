import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { createExportWriter } from '../src/main/export'

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

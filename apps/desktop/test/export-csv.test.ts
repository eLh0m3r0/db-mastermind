import { mkdtempSync as makeTemp, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createExportWriter } from '../src/main/export'

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

const fields = [{ name: 'name' }, { name: 'price', dataType: 'numeric(10,2)' }, { name: 'qty', dataType: 'integer' }, { name: 'version', dataType: 'text' }]
const rows = [['Káva; "dvojitá"', '10.50', 3, '1.5'], ['Čaj', '7.00', 12.25, null]]

async function exportCsv(csvDelimiter?: string) {
  const path = join(mkdtempSync(join(tmpdir(), 'dbm-csv-')), 'out.csv')
  const writer = createExportWriter(path, 'csv', fields, { csvDelimiter })
  await writer.writeRows(rows)
  await writer.close()
  return readFileSync(path, 'utf8')
}

describe('CSV export', () => {
  it('uses commas and decimal points by default', async () => {
    expect(await exportCsv()).toBe('﻿name,price,qty,version\r\n"Káva; ""dvojitá""",10.50,3,1.5\r\nČaj,7.00,12.25,\r\n')
  })

  it('for Excel in Czech: semicolons, decimal commas in numbers only, text untouched', async () => {
    expect(await exportCsv(';')).toBe('﻿name;price;qty;version\r\n"Káva; ""dvojitá""";10,50;3;1.5\r\nČaj;7,00;12,25;\r\n')
  })
})

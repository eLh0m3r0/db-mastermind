import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildBatchInserts, detectDelimiter, mssqlDialect, parseDelimited, parseXlsx, postgresDialect } from '../src/index.js'

describe('delimited text', () => {
  it('detects common delimiters, including Czech Excel semicolons', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',')
    expect(detectDelimiter('jméno;cena;poznámka\n"Káva, 250 g";289,50;x')).toBe(';')
    expect(detectDelimiter('a\tb\n1\t2')).toBe('\t')
  })

  it('parses quotes, doubled quotes, embedded newlines and BOM', () => {
    const text = '﻿name;note\r\n"Smith; John";"said ""hi""\nthen left"\r\nAnn;\r\n\r\n'
    expect(parseDelimited(text, ';')).toEqual([
      ['name', 'note'],
      ['Smith; John', 'said "hi"\nthen left'],
      ['Ann', ''],
    ])
  })
})

describe('xlsx', () => {
  it('reads shared strings, numbers, booleans, dates and sparse cells', () => {
    const file = zipSync({
      'xl/sharedStrings.xml': strToU8('<sst><si><t>Name</t></si><si><t>Born</t></si><si><r><t>Ana</t></r><r><t> &amp; Bo</t></r></si></sst>'),
      'xl/styles.xml': strToU8('<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>'),
      'xl/worksheets/sheet1.xml': strToU8(
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>Active</t></is></c></row>' +
          '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>45000</v></c><c r="C2"><v>3.5</v></c><c r="D2" t="b"><v>1</v></c></row></sheetData></worksheet>',
      ),
    })
    expect(parseXlsx(file)).toEqual([
      ['Name', 'Born', '', 'Active'],
      ['Ana & Bo', '2023-03-15', '3.5', 'true'],
    ])
  })
})

describe('buildBatchInserts', () => {
  it('chunks by the parameter limit and maps empty strings to NULL', () => {
    const rows = Array.from({ length: 1500 }, (_, i) => [String(i), i % 2 ? '' : 'x'])
    const pg = buildBatchInserts({ name: 't' }, ['a', 'b'], rows, postgresDialect, { emptyAsNull: true })
    expect(pg).toHaveLength(3)
    expect(pg[0]!.sql.startsWith('INSERT INTO "t" ("a", "b") VALUES ($1, $2), ($3, NULL)')).toBe(true)
    const ms = buildBatchInserts({ name: 't' }, ['a', 'b', 'c', 'd', 'e'], rows.map((r) => [...r, 'c', 'd', 'e']), mssqlDialect)
    expect(Math.max(...ms.map((q) => q.params.length))).toBeLessThanOrEqual(2000)
  })
})

import { describe, expect, it } from 'vitest'
import { comparableValue, dataSyncScript, getDialect, type DataCompareResult } from '../src/index.js'

describe('data compare', () => {
  it('treats engine-specific representations of the same value as equal', () => {
    expect(comparableValue(true)).toBe(comparableValue(1))
    expect(comparableValue('10.50')).toBe(comparableValue(10.5))
    expect(comparableValue('007')).not.toBe(comparableValue(7))
    expect(comparableValue(null)).not.toBe(comparableValue('NULL'))
    expect(comparableValue('abc')).not.toBe(comparableValue('ABC'))
  })

  it('writes deletes, updates and inserts in one transaction', () => {
    const result: DataCompareResult = {
      columns: ['id', 'name'],
      keyColumns: ['id'],
      skippedColumns: [],
      sourceRows: 2,
      targetRows: 2,
      identical: 0,
      counts: { missing: 1, extra: 1, changed: 1 },
      truncated: false,
      diffs: [
        { kind: 'missing', key: { id: 1 }, source: { id: 1, name: "O'Brien" } },
        { kind: 'extra', key: { id: 9 }, target: { id: 9, name: 'x' } },
        { kind: 'changed', key: { id: 2 }, source: { id: 2, name: 'new' }, target: { id: 2, name: 'old' }, changed: ['name'] },
      ],
    }
    const pg = getDialect('postgres')
    expect(dataSyncScript(result, { schema: 'public', name: 'people' }, pg, { deleteExtra: true }).split('\n')).toEqual([
      'BEGIN;',
      'DELETE FROM "public"."people" WHERE "id" = 9;',
      'UPDATE "public"."people" SET "name" = \'new\' WHERE "id" = 2;',
      'INSERT INTO "public"."people" ("id", "name") VALUES (1, \'O\'\'Brien\');',
      'COMMIT;',
    ])
    expect(dataSyncScript(result, { name: 'people' }, pg, { insertMissing: false, updateChanged: false })).toBe('')
  })
})

describe('cellToText', () => {
  it('hides float noise', async () => {
    const { cellToText } = await import('../src/index.js')
    expect(cellToText(97604.95999999999)).toBe('97604.96')
    expect(cellToText(0.1 + 0.2)).toBe('0.3')
    expect(cellToText(1e21)).toBe('1e+21')
    expect(cellToText(123456789.123456)).toBe('123456789.123456')
  })
})

import { describe, expect, it } from 'vitest'
import { copyResultsAs, copyRowsAs } from '../src/renderer/src/features/results/copy'

describe('Copying query results', () => {
  const one = { name: 'Result 1', sql: 'SELECT id, note FROM t', fields: [{ name: 'id' }, { name: 'note' }], rows: [[1, 'a\tb'], [2, null]] }
  const two = { name: 'Result 2', sql: 'SELECT 1 AS n', fields: [{ name: 'n' }], rows: [[1]] }

  it('copies one result as plain rows', () => {
    expect(copyResultsAs('tsv', [one])).toBe('id\tnote\n1\t"a\tb"\n2\t')
    expect(JSON.parse(copyResultsAs('json', [one]))).toEqual([
      { id: 1, note: 'a\tb' },
      { id: 2, note: null },
    ])
  })

  it('copies every result under its name, without the SQL unless asked', () => {
    expect(copyResultsAs('tsv', [one, two])).toBe('Result 1\nid\tnote\n1\t"a\tb"\n2\t\n\nResult 2\nn\n1')
    expect(JSON.parse(copyResultsAs('json', [one, two]))).toEqual([
      { result: 'Result 1', rows: [{ id: 1, note: 'a\tb' }, { id: 2, note: null }] },
      { result: 'Result 2', rows: [{ n: 1 }] },
    ])
    expect(copyResultsAs('markdown', [one, two])).toContain('## Result 2\n\n| n |\n| --- |\n| 1 |')
    expect(copyResultsAs('markdown', [one, two])).not.toContain('SELECT')
  })

  it('adds each statement on request', () => {
    expect(JSON.parse(copyResultsAs('json', [one, two], { withSql: true }))).toEqual([
      { result: 'Result 1', sql: 'SELECT id, note FROM t', rows: [{ id: 1, note: 'a\tb' }, { id: 2, note: null }] },
      { result: 'Result 2', sql: 'SELECT 1 AS n', rows: [{ n: 1 }] },
    ])
    expect(copyResultsAs('markdown', [one, two], { withSql: true })).toContain('## Result 2\n```sql\nSELECT 1 AS n\n```\n\n| n |\n| --- |\n| 1 |')
    expect(JSON.parse(copyResultsAs('json', [two], { withSql: true }))).toEqual({ sql: 'SELECT 1 AS n', rows: [{ n: 1 }] })
    expect(copyResultsAs('markdown', [two], { withSql: true })).toBe('```sql\nSELECT 1 AS n\n```\n\n| n |\n| --- |\n| 1 |')
    expect(copyResultsAs('tsv', [two], { withSql: true })).toBe('n\n1')
  })
})

describe('Copy rows as SQL INSERT', () => {
  const fields = [{ name: 'id' }, { name: 'note' }]
  it('quotes and qualifies the table name per dialect', () => {
    expect(copyRowsAs('sql', fields, [[1, "it's"]], 'postgres', { schema: 'shop', name: 'Order Items' })).toBe(
      `INSERT INTO "shop"."Order Items" ("id", "note") VALUES (1, 'it''s');`,
    )
    expect(copyRowsAs('sql', fields, [[1, null]], 'mssql', { schema: 'dbo', name: 'orders' })).toBe('INSERT INTO [dbo].[orders] ([id], [note]) VALUES (1, NULL);')
    expect(copyRowsAs('sql', fields, [[1, 'x']], 'mysql', { name: 'orders' })).toBe("INSERT INTO `orders` (`id`, `note`) VALUES (1, 'x');")
  })
})

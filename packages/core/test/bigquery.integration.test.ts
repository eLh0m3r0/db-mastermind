import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DatabaseService } from '../src/index.js'

// BigQuery emulator (docker-compose.test.yml / CI step, port 19050, project dbm-test with dataset shop).
const db = new DatabaseService()
const id = 'bq'

beforeAll(async () => {
  await db.connect({ id, name: 'bq', driver: 'bigquery', host: 'http://127.0.0.1:19050', database: 'dbm-test' })
  const out = await db.runScript(
    id,
    `DROP TABLE IF EXISTS shop.orders;
     CREATE TABLE shop.orders (id INT64 NOT NULL, customer STRING, total NUMERIC, paid BOOL, placed TIMESTAMP, day DATE, tags ARRAY<STRING>, meta STRUCT<channel STRING, score FLOAT64>);
     INSERT INTO shop.orders (id, customer, total, paid, placed, day, tags, meta) VALUES
       (1, 'Ann', 12.50, TRUE, TIMESTAMP '2026-01-01 10:00:00.123456 UTC', DATE '2026-01-01', ['a', 'b'], STRUCT('web', 0.5)),
       (2, 'Bob 50%_off', NULL, FALSE, NULL, DATE '2026-01-02', [], STRUCT('shop', 1.0)),
       (3, 'ann', 99.99, TRUE, TIMESTAMP '2026-02-01 00:00:00 UTC', DATE '2026-02-01', ['c'], NULL),
       (9007199254740993, 'Big', 1, NULL, NULL, NULL, [], NULL);`,
  )
  expect(out.filter((o) => o.error)).toEqual([])
})

afterAll(async () => {
  await db.runScript(id, 'DROP TABLE IF EXISTS shop.orders')
  await db.disconnectAll()
})

const t = { schema: 'shop', name: 'orders' }
const where = (...children: object[]) => ({ kind: 'group', id: 'g', combinator: 'and', children: children.map((c, i) => ({ kind: 'condition', id: `c${i}`, ...c })) }) as never

describe('BigQuery', () => {
  it('reads datasets, tables and columns', async () => {
    expect(db.serverInfo(id)?.product).toBe('BigQuery')
    const snap = await db.schema(id, true)
    expect(snap.schemas).toContain('shop')
    const orders = snap.tables.find((x) => x.name === 'orders')!
    expect(orders.schema).toBe('shop')
    expect(orders.columns.map((c) => `${c.name}:${c.dataType}`).slice(0, 6)).toEqual(['id:INT64', 'customer:STRING', 'total:NUMERIC', 'paid:BOOL', 'placed:TIMESTAMP', 'day:DATE'])
    expect(orders.primaryKey).toEqual([])
  })

  it('filters typed columns with text values, counts and sorts', async () => {
    const page = await db.fetchTable(id, { table: t, filter: where({ column: 'id', operator: 'gt', value: '1' }, { column: 'total', operator: 'lt', value: '50' }), sort: [{ column: 'id', direction: 'asc' }], limit: 10 })
    expect(page.result.rows.map((r) => r[0])).toEqual(['9007199254740993'])
    expect(await db.countTable(id, { table: t, filter: where({ column: 'paid', operator: 'eq', value: 'true' }) })).toBe(2)
    expect(await db.countTable(id, { table: t, filter: where({ column: 'day', operator: 'between', value: '2026-01-01', value2: '2026-01-31' }) })).toBe(2)
    expect(await db.countTable(id, { table: t, filter: where({ column: 'placed', operator: 'gte', value: '2026-01-15' }) })).toBe(1)
    expect(await db.countTable(id, { table: t, filter: where({ column: 'id', operator: 'in', values: ['1', '3'] }) })).toBe(2)
  })

  it('matches text case-insensitively', async () => {
    expect(await db.countTable(id, { table: t, filter: where({ column: 'customer', operator: 'contains', value: 'ANN' }) })).toBe(2)
    expect(await db.countTable(id, { table: t, filter: where({ column: 'customer', operator: 'regex', value: '^a' }) })).toBe(2)
    expect(await db.countTable(id, { table: t, filter: where({ column: 'total', operator: 'is_null' }) })).toBe(1)
  })

  it('converts values exactly', async () => {
    const page = await db.fetchTable(id, { table: t, sort: [{ column: 'id', direction: 'asc' }], limit: 10 })
    const [first] = page.result.rows
    expect(first).toEqual([1, 'Ann', '12.5', true, '2026-01-01 10:00:00.123456 UTC', '2026-01-01', ['a', 'b'], { channel: 'web', score: 0.5 }])
    expect(page.result.fields.map((f) => f.dataType)).toEqual(['INT64', 'STRING', 'NUMERIC', 'BOOL', 'TIMESTAMP', 'DATE', 'ARRAY<STRING>', 'STRUCT'])
    const [r] = await db.runScript(id, 'SELECT o.id AS a, p.id AS b FROM shop.orders o JOIN shop.orders p ON p.id = o.id WHERE o.id = 3')
    expect(r!.error).toBeUndefined()
    expect(r!.results![0]!.rows).toEqual([[3, 3]])
  })

  it('limits, streams and runs DML', async () => {
    const [r] = await db.runScript(id, 'SELECT * FROM shop.orders', { maxRows: 2 })
    expect(r!.results![0]).toMatchObject({ rowCount: 2, truncated: true })
    let streamed = 0
    for await (const batch of db.streamQuery(id, 'SELECT * FROM shop.orders', { batchSize: 3 })) streamed += batch.rows.length
    expect(streamed).toBe(4)
    const [u] = await db.runScript(id, "UPDATE shop.orders SET customer = 'Bobby' WHERE id = 2")
    expect(u!.error).toBeUndefined()
    expect(await db.countTable(id, { table: t, filter: where({ column: 'customer', operator: 'eq', value: 'Bobby' }) })).toBe(1)
  })
})

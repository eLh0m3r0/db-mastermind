import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DatabaseService, explainQuery } from '../src/index.js'

// Trino (docker-compose.test.yml / CI step, port 18080) with its built-in memory and tpch catalogs.
const db = new DatabaseService()
const id = 'trino'

beforeAll(async () => {
  await db.connect({ id, name: 'trino', driver: 'trino', host: '127.0.0.1', port: 18080, user: 'dbm', database: 'memory' })
  const out = await db.runScript(
    id,
    `DROP TABLE IF EXISTS shop.orders;
     CREATE SCHEMA IF NOT EXISTS shop;
     CREATE TABLE shop.orders (id bigint, customer varchar, total decimal(10,2), paid boolean, placed timestamp(3), day date, tags array(varchar), bin varbinary);
     INSERT INTO shop.orders VALUES
       (1, 'Ann', 12.50, true, TIMESTAMP '2026-01-01 10:00:00.123', DATE '2026-01-01', ARRAY['a', 'b'], X'6869'),
       (2, 'Bob 50%_off', NULL, false, NULL, DATE '2026-01-02', ARRAY[], NULL),
       (3, 'ann', 99.99, true, TIMESTAMP '2026-02-01 00:00:00', DATE '2026-02-01', ARRAY['c'], NULL),
       (9007199254740993, 'Big', 1, NULL, NULL, NULL, NULL, NULL);`,
  )
  expect(out.filter((o) => o.error)).toEqual([])
})

afterAll(async () => {
  await db.runScript(id, 'DROP TABLE IF EXISTS shop.orders')
  await db.disconnectAll()
})

const t = { schema: 'shop', name: 'orders' }
const where = (...children: object[]) => ({ kind: 'group', id: 'g', combinator: 'and', children: children.map((c, i) => ({ kind: 'condition', id: `c${i}`, ...c })) }) as never

describe('Trino', () => {
  it('reads schemas, tables and columns of the catalog', async () => {
    expect(db.serverInfo(id)?.product).toBe('Trino')
    const snap = await db.schema(id, true)
    expect(snap.database).toBe('memory')
    expect(snap.schemas).toContain('shop')
    const orders = snap.tables.find((x) => x.schema === 'shop' && x.name === 'orders')!
    expect(orders.columns.map((c) => `${c.name}:${c.dataType}`)).toEqual(['id:bigint', 'customer:varchar', 'total:decimal(10,2)', 'paid:boolean', 'placed:timestamp(3)', 'day:date', 'tags:array(varchar)', 'bin:varbinary'])
    expect(orders.primaryKey).toEqual([])
    const [cats] = await db.runScript(id, 'SHOW CATALOGS')
    expect(cats!.results![0]!.rows.flat()).toEqual(expect.arrayContaining(['memory', 'tpch']))
  })

  it('filters typed columns with text values, counts and pages', async () => {
    const page = await db.fetchTable(id, { table: t, filter: where({ column: 'id', operator: 'gt', value: '1' }, { column: 'total', operator: 'lt', value: '50' }), sort: [{ column: 'id', direction: 'asc' }], limit: 10 })
    expect(page.result.rows.map((r) => r[0])).toEqual(['9007199254740993'])
    expect(await db.countTable(id, { table: t, filter: where({ column: 'paid', operator: 'eq', value: 'true' }) })).toBe(2)
    expect(await db.countTable(id, { table: t, filter: where({ column: 'day', operator: 'between', value: '2026-01-01', value2: '2026-01-31' }) })).toBe(2)
    expect(await db.countTable(id, { table: t, filter: where({ column: 'placed', operator: 'gte', value: '2026-01-15' }) })).toBe(1)
    expect(await db.countTable(id, { table: t, filter: where({ column: 'id', operator: 'in', values: ['1', '3'] }) })).toBe(2)
    const second = await db.fetchTable(id, { table: t, sort: [{ column: 'id', direction: 'asc' }], limit: 2, offset: 2 })
    expect(second.result.rows.map((r) => r[0])).toEqual([3, '9007199254740993'])
  })

  it('matches text case-insensitively, by regex and null', async () => {
    expect(await db.countTable(id, { table: t, filter: where({ column: 'customer', operator: 'contains', value: 'ANN' }) })).toBe(2)
    expect(await db.countTable(id, { table: t, filter: where({ column: 'customer', operator: 'contains', value: '50%_' }) })).toBe(1)
    expect(await db.countTable(id, { table: t, filter: where({ column: 'customer', operator: 'regex', value: '^a' }) })).toBe(2)
    expect(await db.countTable(id, { table: t, filter: where({ column: 'total', operator: 'is_null' }) })).toBe(1)
  })

  it('converts values exactly', async () => {
    const page = await db.fetchTable(id, { table: t, sort: [{ column: 'id', direction: 'asc' }], limit: 10 })
    expect(page.result.rows[0]).toEqual([1, 'Ann', '12.50', true, '2026-01-01 10:00:00.123', '2026-01-01', ['a', 'b'], { $binary: '6869', length: 2 }])
    // Result columns carry the protocol's type names (information_schema writes decimal(10,2) and timestamp(3)).
    expect(page.result.fields.map((f) => f.dataType)).toEqual(['bigint', 'varchar', 'decimal(10, 2)', 'boolean', 'timestamp', 'date', 'array(varchar)', 'varbinary'])
  })

  it('limits, streams, runs DML and reads other catalogs', async () => {
    const [r] = await db.runScript(id, 'SELECT * FROM tpch.tiny.nation', { maxRows: 5 })
    expect(r!.results![0]).toMatchObject({ rowCount: 5, truncated: true })
    let streamed = 0
    for await (const batch of db.streamQuery(id, 'SELECT * FROM tpch.tiny.customer', { batchSize: 400 })) streamed += batch.rows.length
    expect(streamed).toBe(1500)
    // Stopping early cancels the query on the server.
    for await (const batch of db.streamQuery(id, 'SELECT * FROM tpch.tiny.lineitem', { batchSize: 100 })) {
      expect(batch.rows.length).toBeGreaterThan(0)
      break
    }
    const [ins] = await db.runScript(id, "INSERT INTO shop.orders (id, customer) VALUES (10, 'New'), (11, 'Newer')")
    expect(ins!.error).toBeUndefined()
    expect(ins!.results![0]).toMatchObject({ affectedRows: 2 })
    expect(await db.countTable(id, { table: t })).toBe(6)
  })

  it('explains a query as a text plan', async () => {
    const plan = await explainQuery(db, id, 'SELECT n.name, count(*) FROM tpch.tiny.nation n JOIN tpch.tiny.customer c ON c.nationkey = n.nationkey GROUP BY n.name')
    expect(plan.format).toBe('text')
    expect(plan.raw).toMatch(/Fragment 0/)
  })
})

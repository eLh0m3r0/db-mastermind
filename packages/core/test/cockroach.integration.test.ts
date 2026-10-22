import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DatabaseService, diffTables, explainQuery, generateMigration, getDialect, listActivity, migrationScript, toDesignTable } from '../src/index.js'

// CockroachDB through the PostgreSQL driver (docker-compose.test.yml / CI step, port 26257).
const db = new DatabaseService()
const id = 'crdb'

beforeAll(async () => {
  await db.connect({ id, name: 'crdb', driver: 'postgres', host: '127.0.0.1', port: 26257, user: 'root', database: 'defaultdb' })
  const out = await db.runScript(
    id,
    `DROP TABLE IF EXISTS dbm_orders; DROP TABLE IF EXISTS dbm_customers;
     CREATE TABLE dbm_customers (id INT8 PRIMARY KEY, name STRING NOT NULL, email STRING UNIQUE);
     CREATE TABLE dbm_orders (id INT8 PRIMARY KEY DEFAULT unique_rowid(), customer_id INT8 REFERENCES dbm_customers(id), total DECIMAL(10,2));
     CREATE INDEX dbm_orders_customer ON dbm_orders(customer_id);
     INSERT INTO dbm_customers SELECT g, 'c' || g::STRING, 'c' || g::STRING || '@x' FROM generate_series(1, 300) g;
     INSERT INTO dbm_orders (customer_id, total) SELECT (g % 300) + 1, g * 1.5 FROM generate_series(1, 1000) g;`,
  )
  expect(out.filter((o) => o.error)).toEqual([])
})

afterAll(async () => {
  await db.runScript(id, 'DROP TABLE IF EXISTS dbm_orders; DROP TABLE IF EXISTS dbm_customers')
  await db.disconnectAll()
})

describe('CockroachDB', () => {
  it('is recognized and its schema is read', async () => {
    expect(db.serverInfo(id)?.product).toBe('CockroachDB')
    const snap = await db.schema(id, true)
    const orders = snap.tables.find((t) => t.name === 'dbm_orders')!
    expect(orders.foreignKeys).toMatchObject([{ columns: ['customer_id'], refTable: 'dbm_customers' }])
    expect(orders.indexes.map((i) => i.name)).toContain('dbm_orders_customer')
    expect(orders.columns.find((c) => c.name === 'total')!.dataType).toBe('numeric(10,2)')
  })

  it('pages, counts, streams and edits', async () => {
    const page = await db.fetchTable(id, { table: { schema: 'public', name: 'dbm_orders' }, limit: 50, sort: [{ column: 'id', direction: 'asc' }] })
    expect(page.result.rows).toHaveLength(50)
    expect(await db.countTable(id, { table: { schema: 'public', name: 'dbm_orders' } })).toBe(1000)
    let streamed = 0
    for await (const batch of db.streamQuery(id, 'SELECT * FROM dbm_orders')) streamed += batch.rows.length
    expect(streamed).toBe(1000)
    const counts = await db.applyChanges(id, { schema: 'public', name: 'dbm_customers' }, [
      { type: 'update', key: { id: 1 }, values: { name: 'changed' } },
      { type: 'insert', values: { id: 999, name: 'new' } },
      { type: 'delete', key: { id: 999 } },
    ])
    expect(counts).toEqual([1, 1, 1])
  })

  it('explains plans and lists activity', async () => {
    const plan = await explainQuery(db, id, 'SELECT * FROM dbm_orders WHERE customer_id = 5')
    expect(plan.format).toBe('text')
    expect(JSON.stringify(plan.root)).toContain('scan')
    const analyzed = await explainQuery(db, id, 'SELECT * FROM dbm_orders WHERE customer_id = 5', true)
    expect(JSON.stringify(analyzed.root)).toContain('actualRows')
    const sessions = await listActivity(db, id)
    expect(sessions.some((s) => s.own)).toBe(true)
  })

  it('runs designer migrations', async () => {
    const snap = await db.schema(id, true)
    const draft = toDesignTable(snap.tables.find((t) => t.name === 'dbm_customers')!)
    draft.columns.push({ id: 'c1', name: 'deleted_at', dataType: 'timestamptz', nullable: true })
    draft.indexes.push({ id: 'i1', columns: ['name'], unique: false })
    const dialect = getDialect('postgres')
    const out = await db.runScript(id, migrationScript(generateMigration(diffTables(snap.tables, [draft]), dialect, snap.tables), dialect))
    expect(out.filter((o) => o.error)).toEqual([])
    const after = (await db.schema(id, true)).tables.find((t) => t.name === 'dbm_customers')!
    expect(after.columns.map((c) => c.name)).toContain('deleted_at')
  })
})

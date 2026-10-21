import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DatabaseService, findTable, type ConnectionConfig, type DriverId } from '../src/index.js'

/**
 * One behavioural suite, run against every driver. Requires `npm run db:up`.
 * Set DBM_SKIP=mssql,mariadb to skip engines that aren't available.
 */

const skip = new Set((process.env.DBM_SKIP ?? '').split(',').filter(Boolean))
const tmp = mkdtempSync(join(tmpdir(), 'dbm-test-'))

interface Engine {
  id: DriverId
  config: ConnectionConfig
  schema: string
  setup: string[]
  sleep: string
}

const ddl = {
  postgres: [
    'DROP SCHEMA IF EXISTS shop CASCADE',
    'CREATE SCHEMA shop',
    `CREATE TABLE shop.customers (id serial PRIMARY KEY, name text NOT NULL, email varchar(200) UNIQUE, vip boolean DEFAULT false, created_at timestamp DEFAULT now(), meta jsonb)`,
    `COMMENT ON TABLE shop.customers IS 'People who buy things'`,
    `COMMENT ON COLUMN shop.customers.vip IS 'Very important person'`,
    `CREATE TABLE shop.orders (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, customer_id int NOT NULL REFERENCES shop.customers(id) ON DELETE CASCADE, total numeric(12,2) NOT NULL, status text, ordered_on date)`,
    `CREATE INDEX orders_status_idx ON shop.orders (status, ordered_on)`,
    `CREATE VIEW shop.vip_customers AS SELECT * FROM shop.customers WHERE vip`,
    `INSERT INTO shop.customers (name, email, vip, meta) VALUES ('Alice', 'alice@example.com', true, '{"tier":"gold"}'), ('Bob', 'bob@example.com', false, null), ('Čeněk 50%_off', null, false, null)`,
    `INSERT INTO shop.orders (customer_id, total, status, ordered_on) SELECT 1 + (g % 3), g * 10.5, CASE WHEN g % 2 = 0 THEN 'paid' ELSE 'new' END, DATE '2026-01-01' + g FROM generate_series(1, 120) g`,
  ],
  mysql: [
    'DROP TABLE IF EXISTS orders',
    'DROP VIEW IF EXISTS vip_customers',
    'DROP TABLE IF EXISTS customers',
    `CREATE TABLE customers (id int AUTO_INCREMENT PRIMARY KEY, name varchar(100) NOT NULL, email varchar(200) UNIQUE, vip tinyint(1) DEFAULT 0, created_at datetime DEFAULT CURRENT_TIMESTAMP, meta json) COMMENT='People who buy things'`,
    `ALTER TABLE customers MODIFY vip tinyint(1) DEFAULT 0 COMMENT 'Very important person'`,
    `CREATE TABLE orders (id bigint AUTO_INCREMENT PRIMARY KEY, customer_id int NOT NULL, total decimal(12,2) NOT NULL, status varchar(20), ordered_on date, CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE)`,
    `CREATE INDEX orders_status_idx ON orders (status, ordered_on)`,
    `CREATE VIEW vip_customers AS SELECT * FROM customers WHERE vip = 1`,
    `INSERT INTO customers (name, email, vip, meta) VALUES ('Alice', 'alice@example.com', 1, '{"tier":"gold"}'), ('Bob', 'bob@example.com', 0, NULL), ('Čeněk 50%_off', NULL, 0, NULL)`,
    `INSERT INTO orders (customer_id, total, status, ordered_on)
       WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 120)
       SELECT 1 + (n % 3), n * 10.5, IF(n % 2 = 0, 'paid', 'new'), DATE_ADD('2026-01-01', INTERVAL n DAY) FROM g`,
  ],
  mssql: [
    `IF OBJECT_ID('shop.vip_customers', 'V') IS NOT NULL DROP VIEW shop.vip_customers`,
    `IF OBJECT_ID('shop.orders', 'U') IS NOT NULL DROP TABLE shop.orders`,
    `IF OBJECT_ID('shop.customers', 'U') IS NOT NULL DROP TABLE shop.customers`,
    `IF SCHEMA_ID('shop') IS NULL EXEC('CREATE SCHEMA shop')`,
    `CREATE TABLE shop.customers (id int IDENTITY PRIMARY KEY, name nvarchar(100) NOT NULL, email varchar(200) UNIQUE, vip bit DEFAULT 0, created_at datetime2 DEFAULT SYSUTCDATETIME(), meta nvarchar(max))`,
    `EXEC sp_addextendedproperty 'MS_Description', 'People who buy things', 'SCHEMA', 'shop', 'TABLE', 'customers'`,
    `EXEC sp_addextendedproperty 'MS_Description', 'Very important person', 'SCHEMA', 'shop', 'TABLE', 'customers', 'COLUMN', 'vip'`,
    `CREATE TABLE shop.orders (id bigint IDENTITY PRIMARY KEY, customer_id int NOT NULL CONSTRAINT fk_orders_customer REFERENCES shop.customers(id) ON DELETE CASCADE, total decimal(12,2) NOT NULL, status nvarchar(20), ordered_on date)`,
    `CREATE INDEX orders_status_idx ON shop.orders (status, ordered_on)`,
    `EXEC('CREATE VIEW shop.vip_customers AS SELECT * FROM shop.customers WHERE vip = 1')`,
    `INSERT INTO shop.customers (name, email, vip, meta) VALUES (N'Alice', 'alice@example.com', 1, N'{"tier":"gold"}'), (N'Bob', 'bob@example.com', 0, NULL), (N'Čeněk 50%_off', NULL, 0, NULL)`,
    `INSERT INTO shop.orders (customer_id, total, status, ordered_on)
       SELECT 1 + (n % 3), n * 10.5, CASE WHEN n % 2 = 0 THEN 'paid' ELSE 'new' END, DATEADD(day, n, '2026-01-01')
         FROM (SELECT TOP 120 ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects) g`,
  ],
  sqlite: [
    'DROP VIEW IF EXISTS vip_customers',
    'DROP TABLE IF EXISTS orders',
    'DROP TABLE IF EXISTS customers',
    `CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, vip BOOLEAN DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP, meta TEXT)`,
    `CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL REFERENCES customers ON DELETE CASCADE, total NUMERIC NOT NULL, status TEXT, ordered_on DATE)`,
    `CREATE INDEX orders_status_idx ON orders (status, ordered_on)`,
    `CREATE VIEW vip_customers AS SELECT * FROM customers WHERE vip`,
    `INSERT INTO customers (name, email, vip, meta) VALUES ('Alice', 'alice@example.com', 1, '{"tier":"gold"}'), ('Bob', 'bob@example.com', 0, NULL), ('Čeněk 50%_off', NULL, 0, NULL)`,
    `INSERT INTO orders (customer_id, total, status, ordered_on)
       WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 120)
       SELECT 1 + (n % 3), n * 10.5, CASE WHEN n % 2 = 0 THEN 'paid' ELSE 'new' END, date('2026-01-01', '+' || n || ' days') FROM g`,
  ],
}

const engines: Engine[] = [
  {
    id: 'postgres',
    config: { id: 'pg', name: 'pg', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' },
    schema: 'shop',
    setup: ddl.postgres,
    sleep: 'SELECT pg_sleep(30)',
  },
  {
    id: 'mysql',
    config: { id: 'my', name: 'my', driver: 'mysql', host: '127.0.0.1', port: 33069, user: 'root', password: 'mastermind', database: 'mastermind' },
    schema: 'mastermind',
    setup: ddl.mysql,
    sleep: 'SELECT SLEEP(30)',
  },
  {
    id: 'mariadb',
    config: { id: 'maria', name: 'maria', driver: 'mariadb', host: '127.0.0.1', port: 33070, user: 'root', password: 'mastermind', database: 'mastermind' },
    schema: 'mastermind',
    setup: ddl.mysql,
    sleep: 'SELECT SLEEP(30)',
  },
  {
    id: 'mssql',
    config: {
      id: 'ms',
      name: 'ms',
      driver: 'mssql',
      host: '127.0.0.1',
      port: 14339,
      user: 'sa',
      password: 'Mastermind!2026',
      database: 'master',
      options: { trustServerCertificate: true },
    },
    schema: 'shop',
    setup: ddl.mssql,
    sleep: "WAITFOR DELAY '00:00:30'",
  },
  {
    id: 'sqlite',
    config: { id: 'lite', name: 'lite', driver: 'sqlite', filePath: join(tmp, 'test.db') },
    schema: 'main',
    setup: ddl.sqlite,
    sleep: `WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r WHERE i < 1e9) SELECT count(*) FROM r`,
  },
]

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

for (const engine of engines) {
  describe.skipIf(skip.has(engine.id))(engine.id, () => {
    const svc = new DatabaseService()
    let config = engine.config
    const id = config.id
    const customers = { schema: engine.schema, name: 'customers' }
    const orders = { schema: engine.schema, name: 'orders' }

    beforeAll(async () => {
      if (engine.id === 'mssql') {
        await svc.connect(config)
        await svc.runScript(id, `IF DB_ID('mastermind') IS NULL CREATE DATABASE mastermind`)
        config = { ...config, database: 'mastermind' }
      }
      await svc.connect(config)
      for (const sql of engine.setup) {
        const [outcome] = await svc.runScript(id, sql)
        if (outcome?.error) throw new Error(`${sql}\n→ ${outcome.error.message}`)
      }
    })
    afterAll(() => svc.disconnectAll())

    it('reports server info', () => {
      const info = svc.serverInfo(id)
      expect(info?.version).toMatch(/\d/)
    })

    it('introspects tables, columns, keys, indexes and comments', async () => {
      const snapshot = await svc.schema(id, true)
      expect(snapshot.schemas).toContain(engine.schema)
      const c = findTable(snapshot, customers)!
      const o = findTable(snapshot, orders)!
      expect(c.type).toBe('table')
      expect(c.columns.map((x) => x.name)).toEqual(['id', 'name', 'email', 'vip', 'created_at', 'meta'])
      expect(c.primaryKey).toEqual(['id'])
      expect(c.columns[0]!.isIdentity).toBe(true)
      expect(c.columns[0]!.isPrimaryKey).toBe(true)
      expect(c.columns[1]!.nullable).toBe(false)
      expect(c.columns[2]!.nullable).toBe(true)
      if (engine.id !== 'sqlite') {
        expect(c.comment).toBe('People who buy things')
        expect(c.columns.find((x) => x.name === 'vip')!.comment).toBe('Very important person')
      }
      expect(o.foreignKeys).toHaveLength(1)
      expect(o.foreignKeys[0]).toMatchObject({ columns: ['customer_id'], refTable: 'customers', refColumns: ['id'], onDelete: 'CASCADE' })
      const idx = o.indexes.find((i) => i.name === 'orders_status_idx')!
      expect(idx.columns).toEqual(['status', 'ordered_on'])
      expect(idx.unique).toBe(false)
      expect(findTable(snapshot, { schema: engine.schema, name: 'vip_customers' })?.type).toBe('view')
    })

    it('runs multi-statement scripts and reports per-statement outcomes', async () => {
      const script = engine.id === 'mssql' ? 'SELECT 1 AS a\nGO\nSELECT 2 AS b, 3 AS c\nGO\nSELECT * FROM nope' : 'SELECT 1 AS a; SELECT 2 AS b, 3 AS c; SELECT * FROM nope'
      const outcomes = await svc.runScript(id, script, { continueOnError: true })
      expect(outcomes).toHaveLength(3)
      expect(outcomes[0]!.results![0]!.rows).toEqual([[1]])
      expect(outcomes[1]!.results![0]!.fields.map((f) => f.name)).toEqual(['b', 'c'])
      expect(outcomes[2]!.error?.message).toMatch(/nope/i)
    })

    it('truncates large results at maxRows', async () => {
      const [outcome] = await svc.runScript(id, `SELECT * FROM ${svc.qualifiedName(id, orders)}`, { maxRows: 25 })
      const result = outcome!.results![0]!
      expect(result.rows).toHaveLength(25)
      expect(result.truncated).toBe(true)
      // The connection stays usable after stopping early.
      const [again] = await svc.runScript(id, 'SELECT 42 AS answer')
      expect(again!.results![0]!.rows).toEqual([[42]])
    })

    it('reports affected rows for DML', async () => {
      const [outcome] = await svc.runScript(id, `UPDATE ${svc.qualifiedName(id, orders)} SET status = 'paid' WHERE status = 'paid'`)
      expect(outcome!.error).toBeUndefined()
      expect(outcome!.results!.at(-1)!.affectedRows).toBe(60)
    })

    it('fetches a filtered, sorted page and counts it', async () => {
      const filter = {
        kind: 'group' as const,
        id: 'g',
        combinator: 'and' as const,
        children: [
          { kind: 'condition' as const, id: 'a', column: 'status', operator: 'eq' as const, value: 'paid' },
          { kind: 'condition' as const, id: 'b', column: 'total', operator: 'gte' as const, value: '1000' },
        ],
      }
      const page = await svc.fetchTable(id, { table: orders, filter, sort: [{ column: 'total', direction: 'desc' }], limit: 5, offset: 2 })
      expect(page.result.rows).toHaveLength(5)
      const totalIdx = page.result.fields.findIndex((f) => f.name === 'total')
      const totals = page.result.rows.map((r) => Number(r[totalIdx]))
      expect(totals).toEqual([...totals].sort((a, b) => b - a))
      expect(totals[0]).toBe(1218)
      expect(await svc.countTable(id, { table: orders, filter })).toBe(13)
    })

    it('filters with escaped LIKE patterns and unicode', async () => {
      const page = await svc.fetchTable(id, {
        table: customers,
        filter: { kind: 'condition', id: 'x', column: 'name', operator: 'contains', value: '50%_' },
        limit: 10,
      })
      expect(page.result.rows).toHaveLength(1)
      const nameIdx = page.result.fields.findIndex((f) => f.name === 'name')
      expect(page.result.rows[0]![nameIdx]).toBe('Čeněk 50%_off')
    })

    it('applies inserts, updates and deletes atomically', async () => {
      const affected = await svc.applyChanges(id, customers, [
        { type: 'insert', values: { name: 'Dana', email: 'dana@example.com' } },
        { type: 'update', key: { id: 2 }, values: { name: 'Bobby', vip: true } },
      ])
      expect(affected).toEqual([1, 1])
      await expect(
        svc.applyChanges(id, customers, [
          { type: 'update', key: { id: 1 }, values: { name: 'Should roll back' } },
          { type: 'insert', values: { name: 'Dup', email: 'dana@example.com' } },
        ]),
      ).rejects.toThrow()
      const [check] = await svc.runScript(id, `SELECT name FROM ${svc.qualifiedName(id, customers)} WHERE id = 1`)
      expect(check!.results![0]!.rows).toEqual([['Alice']])
      const deleted = await svc.applyChanges(id, customers, [{ type: 'delete', key: { email: 'dana@example.com' } }])
      expect(deleted).toEqual([1])
    })

    it('keeps transactions open across executions within a session', async () => {
      const t = svc.qualifiedName(id, customers)
      const begin = engine.id === 'mssql' ? 'BEGIN TRANSACTION' : 'BEGIN'
      await svc.runScript(id, begin, { session: 's1' })
      await svc.runScript(id, `UPDATE ${t} SET name = 'Temp' WHERE id = 3`, { session: 's1' })
      const [inside] = await svc.runScript(id, `SELECT name FROM ${t} WHERE id = 3`, { session: 's1' })
      expect(inside!.results![0]!.rows).toEqual([['Temp']])
      await svc.runScript(id, 'ROLLBACK', { session: 's1' })
      const [after] = await svc.runScript(id, `SELECT name FROM ${t} WHERE id = 3`, { session: 's1' })
      expect(after!.results![0]!.rows).toEqual([['Čeněk 50%_off']])
      await svc.releaseSession(id, 's1')
    })

    it('cancels a running query', async () => {
      const controller = new AbortController()
      const started = Date.now()
      setTimeout(() => controller.abort(), 700)
      const [outcome] = await svc.runScript(id, engine.sleep, { signal: controller.signal })
      expect(outcome!.error?.message).toMatch(/cancel/i)
      expect(Date.now() - started).toBeLessThan(10_000)
      const [again] = await svc.runScript(id, 'SELECT 1 AS ok')
      expect(again!.results![0]!.rows).toEqual([[1]])
    })

    it('enforces read-only connections', async () => {
      const ro = new DatabaseService()
      await ro.connect({ ...config, id: 'ro', readOnly: true })
      try {
        const [select] = await ro.runScript('ro', `SELECT count(*) FROM ${ro.qualifiedName('ro', customers)}`)
        expect(select!.error).toBeUndefined()
        const [del] = await ro.runScript('ro', `DELETE FROM ${ro.qualifiedName('ro', customers)}`)
        expect(del!.error?.message).toMatch(/read-only/i)
        await expect(ro.applyChanges('ro', customers, [{ type: 'delete', key: { id: 1 } }])).rejects.toThrow(/read-only/i)
      } finally {
        await ro.disconnectAll()
      }
    })

    it('normalizes values for transport', async () => {
      const page = await svc.fetchTable(id, { table: customers, sort: [{ column: 'id', direction: 'asc' }], limit: 1 })
      const row = page.result.rows[0]!
      const get = (name: string) => row[page.result.fields.findIndex((f) => f.name === name)]
      expect(typeof get('created_at')).toBe('string')
      expect(String(get('meta'))).toContain('gold')
      expect(() => structuredClone(page)).not.toThrow()
    })
  })
}

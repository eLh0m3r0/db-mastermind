import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionConfig, DatabaseService, DriverId } from '../src/index.js'

/** Shared database fixtures for integration tests. Requires `npm run db:up`. */
export const skip = new Set((process.env.DBM_SKIP ?? '').split(',').filter(Boolean))
export const tmp = mkdtempSync(join(tmpdir(), 'dbm-test-'))

export interface Engine {
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
    'DROP TABLE IF EXISTS payments',
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
    `IF OBJECT_ID('shop.payments', 'U') IS NOT NULL DROP TABLE shop.payments`,
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
    'DROP TABLE IF EXISTS payments',
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

export const engines: Engine[] = [
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


/** Recreates the shop fixture; returns the config to use afterwards (SQL Server switches database). */
export async function setupEngine(svc: DatabaseService, engine: Engine): Promise<ConnectionConfig> {
  let config = engine.config
  if (engine.id === 'mssql') {
    await svc.connect(config)
    await svc.runScript(config.id, `IF DB_ID('mastermind') IS NULL CREATE DATABASE mastermind`)
    config = { ...config, database: 'mastermind' }
  }
  await svc.connect(config)
  for (const sql of engine.setup) {
    const [outcome] = await svc.runScript(config.id, sql)
    if (outcome?.error) throw new Error(`${sql}\n→ ${outcome.error.message}`)
  }
  return config
}

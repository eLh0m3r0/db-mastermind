import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { copyTables, DatabaseService, type ConnectionConfig, type DriverId } from '../src/index.js'
import { engines, setupEngine, skip, tmp } from './fixtures.js'

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const engine = (id: DriverId) => engines.find((e) => e.id === id)!
const shopSchema = (id: DriverId) => (id === 'postgres' || id === 'mssql' ? 'shop' : undefined)

/** A target with an empty place for the copies: schema copy_test (a database in MySQL), or a fresh file. */
async function emptyTarget(svc: DatabaseService, id: DriverId): Promise<{ config: ConnectionConfig; schema?: string }> {
  if (id === 'sqlite' || id === 'duckdb') {
    const config = { ...engine(id).config, id: `${id}-copy`, filePath: join(tmp, `copy-${Date.now()}.${id === 'sqlite' ? 'db' : 'duckdb'}`) }
    await svc.connect(config)
    return { config }
  }
  const config = await setupEngine(svc, engine(id))
  const drop =
    id === 'postgres'
      ? ['DROP SCHEMA IF EXISTS copy_test CASCADE', 'CREATE SCHEMA copy_test']
      : id === 'mssql'
        ? [`IF OBJECT_ID('copy_test.orders') IS NOT NULL DROP TABLE copy_test.orders`, `IF OBJECT_ID('copy_test.customers') IS NOT NULL DROP TABLE copy_test.customers`, `IF SCHEMA_ID('copy_test') IS NULL EXEC('CREATE SCHEMA copy_test')`]
        : ['DROP DATABASE IF EXISTS copy_test', 'CREATE DATABASE copy_test']
  for (const sql of drop) {
    const [o] = await svc.runScript(config.id, sql)
    if (o?.error) throw new Error(`${sql}: ${o.error.message}`)
  }
  return { config, schema: 'copy_test' }
}

const PAIRS: [DriverId, DriverId][] = [
  ['postgres', 'mysql'],
  ['mysql', 'postgres'],
  ['postgres', 'mssql'],
  ['mssql', 'postgres'],
  ['postgres', 'sqlite'],
  ['sqlite', 'postgres'],
  ['mariadb', 'duckdb'],
  ['postgres', 'postgres'],
]

for (const [from, to] of PAIRS) {
  describe.skipIf(skip.has(from) || skip.has(to))(`copy tables ${from} → ${to}`, () => {
    it('creates the tables, copies every row in foreign-key order, keeps the keys and lets new rows follow', async () => {
      const src = new DatabaseService()
      const dst = new DatabaseService()
      try {
        const source = await setupEngine(src, engine(from))
        const { config: target, schema } = await emptyTarget(dst, to)
        // Two services sharing one: the copy reads from one and writes the other.
        const svc = new DatabaseService()
        await svc.connect(source)
        await svc.connect(target)
        const progress: string[] = []
        const result = await copyTables(svc, source.id, target.id, {
          tables: [{ schema: shopSchema(from), name: 'orders' }, { schema: shopSchema(from), name: 'customers' }],
          targetSchema: schema,
          create: true,
          mode: 'append',
          batchRows: 50,
          onProgress: (p) => p.done && progress.push(`${p.table}:${p.rows}`),
        })
        expect(result.map((r) => [r.table.toLowerCase(), r.rows, r.created])).toEqual([
          ['customers', 3, true],
          ['orders', 120, true],
        ])
        expect(progress.map((p) => p.toLowerCase())).toEqual(['customers:3', 'orders:120'])
        const q = (name: string) => svc.qualifiedName(target.id, { schema, name })
        const one = async (sql: string) => {
          const [o] = await svc.runScript(target.id, sql)
          if (o?.error) throw new Error(`${sql}: ${o.error.message}`)
          return o!.results![0]!.rows[0]![0]
        }
        expect(Number(await one(`SELECT SUM(total) FROM ${q('orders')}`))).toBe(Array.from({ length: 120 }, (_, i) => (i + 1) * 10.5).reduce((a, b) => a + b, 0))
        expect(String(await one(`SELECT name FROM ${q('customers')} WHERE id = 3`))).toBe('Čeněk 50%_off')
        // The keys came along: every order still points at a customer.
        expect(Number(await one(`SELECT COUNT(*) FROM ${q('orders')} o JOIN ${q('customers')} c ON c.id = o.customer_id`))).toBe(120)
        // New rows continue after the copied keys (DuckDB has no auto-generated key from another engine).
        if (to !== 'duckdb') {
          const [ins] = await svc.runScript(target.id, `INSERT INTO ${q('customers')} (name, email) VALUES ('Newcomer', 'new@example.com')`)
          expect(ins?.error?.message).toBeUndefined()
          expect(Number(await one(`SELECT id FROM ${q('customers')} WHERE name = 'Newcomer'`))).toBe(4)
          await svc.runScript(target.id, `DELETE FROM ${q('customers')} WHERE name = 'Newcomer'`)
        }
        // A replace copies again into the same tables.
        const again = await copyTables(svc, source.id, target.id, { tables: [{ schema: shopSchema(from), name: 'customers' }, { schema: shopSchema(from), name: 'orders' }], targetSchema: schema, create: false, mode: 'replace' })
        expect(again.map((r) => r.rows)).toEqual([3, 120])
        expect(Number(await one(`SELECT COUNT(*) FROM ${q('orders')}`))).toBe(120)
        // Leave nothing behind in the shared test databases (the explorer of every later e2e flow shows them).
        const cleanup = to === 'postgres' ? ['DROP SCHEMA copy_test CASCADE'] : to === 'mssql' ? ['DROP TABLE copy_test.orders', 'DROP TABLE copy_test.customers', 'DROP SCHEMA copy_test'] : to === 'mysql' || to === 'mariadb' ? ['DROP DATABASE copy_test'] : []
        for (const sql of cleanup) await svc.runScript(target.id, sql)
        await svc.disconnectAll()
      } finally {
        await src.disconnectAll()
        await dst.disconnectAll()
      }
    })
  })
}

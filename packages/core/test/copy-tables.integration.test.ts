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
        // A copy stopped after it created the tables takes them away again: the message says nothing changed.
        const early = new AbortController()
        await expect(
          copyTables(svc, source.id, target.id, {
            tables: [{ schema: shopSchema(from), name: 'orders' }, { schema: shopSchema(from), name: 'customers' }],
            targetSchema: schema,
            create: true,
            mode: 'append',
            batchRows: 20,
            signal: early.signal,
            onProgress: (p) => p.table.toLowerCase() === 'orders' && p.rows >= 20 && early.abort(),
          }),
        ).rejects.toThrow(/stopped: nothing was changed in the target$/)
        const after = await svc.schema(target.id, true)
        const inTarget = (name: string) => after.tables.some((t) => t.name.toLowerCase() === name && (schema === undefined || t.schema?.toLowerCase() === schema))
        if (to === 'mysql' || to === 'mariadb') {
          const [o] = await svc.runScript(target.id, `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'copy_test'`)
          expect(Number(o!.results![0]!.rows[0]![0])).toBe(0)
        } else {
          expect(inTarget('customers') || inTarget('orders')).toBe(false)
        }
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
        // A replace stopped after its first batch leaves the target exactly as it was (one transaction; on DuckDB the
        // emptied tables are filled again).
        {
          const [mark] = await svc.runScript(target.id, `INSERT INTO ${q('customers')} (id, name, email) VALUES (99, 'Marker', 'marker@example.com')`)
          if (mark?.error && to === 'mssql') await svc.runScript(target.id, `SET IDENTITY_INSERT ${q('customers')} ON; INSERT INTO ${q('customers')} (id, name, email) VALUES (99, 'Marker', 'marker@example.com'); SET IDENTITY_INSERT ${q('customers')} OFF`)
          const stop = new AbortController()
          await expect(
            copyTables(svc, source.id, target.id, {
              tables: [{ schema: shopSchema(from), name: 'customers' }, { schema: shopSchema(from), name: 'orders' }],
              targetSchema: schema,
              create: false,
              mode: 'replace',
              batchRows: 20,
              signal: stop.signal,
              onProgress: (p) => p.table.toLowerCase() === 'orders' && p.rows >= 20 && stop.abort(),
            }),
          ).rejects.toThrow(/stopped: nothing was changed/)
          expect(Number(await one(`SELECT COUNT(*) FROM ${q('orders')}`))).toBe(120)
          expect(Number(await one(`SELECT COUNT(*) FROM ${q('customers')} WHERE name = 'Marker'`))).toBe(1)
        }
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

const run = async (svc: DatabaseService, id: string, sql: string) => {
  const [o] = await svc.runScript(id, sql)
  if (o?.error) throw new Error(`${sql}: ${o.error.message}`)
  return o!.results?.[0]?.rows ?? []
}

describe.skipIf(skip.has('mysql') || skip.has('postgres'))('copy tables: MySQL BIT values', () => {
  it('copies BIT columns as bits instead of NULL', async () => {
    const svc = new DatabaseService()
    try {
      const source = await setupEngine(svc, engine('mysql'))
      const { config: target, schema } = await emptyTarget(svc, 'postgres')
      await run(svc, source.id, 'DROP TABLE IF EXISTS copy_bits')
      await run(svc, source.id, 'CREATE TABLE copy_bits (id int PRIMARY KEY, active bit(1) NOT NULL, flags bit(4))')
      await run(svc, source.id, "INSERT INTO copy_bits VALUES (1, b'1', b'0101'), (2, b'0', NULL)")
      const [r] = await copyTables(svc, source.id, target.id, { tables: [{ name: 'copy_bits' }], targetSchema: schema, create: true, mode: 'append' })
      expect(r!.skippedColumns).toEqual([])
      expect(await run(svc, target.id, 'SELECT id, active::text, flags::text FROM copy_test.copy_bits ORDER BY id')).toEqual([
        [1, '1', '0101'],
        [2, '0', null],
      ])
      await run(svc, source.id, 'DROP TABLE copy_bits')
      await run(svc, target.id, 'DROP SCHEMA copy_test CASCADE')
    } finally {
      await svc.disconnectAll()
    }
  })
})

describe.skipIf(skip.has('mssql') || skip.has('postgres'))('copy tables: SQL Server identity', () => {
  it('appends rows without the identity column into a table that has one (no IDENTITY_INSERT)', async () => {
    const svc = new DatabaseService()
    try {
      const source = await setupEngine(svc, engine('postgres'))
      const { config: target, schema } = await emptyTarget(svc, 'mssql')
      await run(svc, source.id, 'DROP TABLE IF EXISTS shop.copy_names')
      await run(svc, source.id, "CREATE TABLE shop.copy_names (name text); INSERT INTO shop.copy_names VALUES ('a'), ('b')")
      await run(svc, target.id, "IF OBJECT_ID('copy_test.copy_names') IS NOT NULL DROP TABLE copy_test.copy_names")
      await run(svc, target.id, 'CREATE TABLE copy_test.copy_names (id int IDENTITY PRIMARY KEY, name nvarchar(50))')
      const [r] = await copyTables(svc, source.id, target.id, { tables: [{ schema: 'shop', name: 'copy_names' }], targetSchema: schema, create: false, mode: 'append' })
      expect(r!.rows).toBe(2)
      expect(await run(svc, target.id, 'SELECT id, name FROM copy_test.copy_names ORDER BY id')).toEqual([
        [1, 'a'],
        [2, 'b'],
      ])
      await run(svc, source.id, 'DROP TABLE shop.copy_names')
      await run(svc, target.id, 'DROP TABLE copy_test.copy_names')
    } finally {
      await svc.disconnectAll()
    }
  })
})

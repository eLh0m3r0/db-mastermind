import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseService, type ConnectionConfig } from '../src/index.js'
import { engines, skip } from './fixtures.js'

/**
 * Unconfirmed AI queries run with `readOnly`: a SELECT that calls a function with side effects (or, in T-SQL, a
 * SELECT followed by a DELETE without a semicolon) must not change data. Each case first shows the write really
 * happens without the guard. Requires `npm run db:up`.
 */

const svc = new DatabaseService()
afterAll(() => svc.disconnectAll())

const config = (id: string): ConnectionConfig => engines.find((e) => e.id === id)!.config
const value = async (id: string, sql: string) => {
  const [o] = await svc.runScript(id, sql)
  if (o?.error) throw new Error(o.error.message)
  return Number(Object.values(o!.results![0]!.rows[0]!)[0] ?? (o!.results![0]!.rows[0] as unknown[])[0])
}
const exec = async (id: string, sql: string) => {
  await svc.driver(id).execute(sql)
}

describe.skipIf(skip.has('postgres'))('read-only guard: postgres', () => {
  const id = config('postgres').id
  it('blocks a function that writes, keeps plain reads working', async () => {
    await svc.connect(config('postgres'))
    await exec(id, 'DROP TABLE IF EXISTS rg_t')
    await exec(id, 'CREATE TABLE rg_t (v int)')
    await exec(id, 'INSERT INTO rg_t VALUES (1)')
    await exec(id, 'CREATE OR REPLACE FUNCTION rg_bump() RETURNS int LANGUAGE sql AS $$ UPDATE rg_t SET v = v + 1 RETURNING v $$')
    await svc.runScript(id, 'SELECT rg_bump()')
    expect(await value(id, 'SELECT v FROM rg_t')).toBe(2)
    const [blocked] = await svc.runScript(id, 'SELECT rg_bump()', { readOnly: true })
    expect(blocked!.error?.message).toMatch(/read-only transaction/)
    const [seq] = await svc.runScript(id, "SELECT setval(pg_get_serial_sequence('shop.customers', 'id'), 1)", { readOnly: true })
    expect(seq!.error?.message).toMatch(/read-only transaction/)
    expect(await value(id, 'SELECT v FROM rg_t')).toBe(2)
    const [read] = await svc.runScript(id, 'SELECT count(*) AS n FROM rg_t', { readOnly: true })
    expect(Number(read!.results![0]!.rows[0]![0])).toBe(1)
    await expect(svc.runScript(id, 'SELECT 1; COMMIT; DELETE FROM rg_t', { readOnly: true })).rejects.toThrow(/Only reads/)
  })
})

for (const engine of ['mysql', 'mariadb'] as const) {
  describe.skipIf(skip.has(engine))(`read-only guard: ${engine}`, () => {
    const id = config(engine).id
    it('blocks a stored function that writes', async () => {
      await svc.connect(config(engine))
      await exec(id, 'DROP TABLE IF EXISTS rg_t')
      await exec(id, 'CREATE TABLE rg_t (v int)')
      await exec(id, 'INSERT INTO rg_t VALUES (1)')
      await exec(id, 'DROP FUNCTION IF EXISTS rg_bump')
      await exec(id, 'SET GLOBAL log_bin_trust_function_creators = 1').catch(() => undefined)
      await exec(id, 'CREATE FUNCTION rg_bump() RETURNS INT MODIFIES SQL DATA BEGIN UPDATE rg_t SET v = v + 1; RETURN 1; END')
      await svc.runScript(id, 'SELECT rg_bump()')
      expect(await value(id, 'SELECT v FROM rg_t')).toBe(2)
      const [blocked] = await svc.runScript(id, 'SELECT rg_bump()', { readOnly: true })
      expect(blocked!.error?.message).toMatch(/READ ONLY transaction/i)
      expect(await value(id, 'SELECT v FROM rg_t')).toBe(2)
    })
  })
}

describe.skipIf(skip.has('mssql'))('read-only guard: mssql', () => {
  const id = config('mssql').id
  it('refuses a DELETE hidden after a SELECT, also on read-only connections, exports and filters', async () => {
    await svc.connect(config('mssql'))
    await exec(id, "IF OBJECT_ID('dbo.rg_t') IS NOT NULL DROP TABLE dbo.rg_t")
    await exec(id, 'CREATE TABLE dbo.rg_t (v int)')
    await exec(id, 'INSERT INTO dbo.rg_t VALUES (1)')
    // T-SQL needs no semicolon: this is one batch that starts with SELECT.
    const sneaky = 'SELECT 1 AS a DELETE FROM dbo.rg_t'
    await expect(svc.runScript(id, sneaky, { readOnly: true })).rejects.toThrow(/Only reads/)
    await expect(svc.runScript(id, 'SELECT 1 AS a COMMIT DELETE FROM dbo.rg_t', { readOnly: true })).rejects.toThrow(/Only reads/)
    // Reads still run inside the rolled-back transaction.
    const [read] = await svc.runScript(id, 'SELECT count(*) AS n FROM dbo.rg_t', { readOnly: true })
    expect(read!.results![0]!.rows).toEqual([[1]])
    // A read-only connection (ApplicationIntent=ReadOnly doesn't stop writes on a standalone server).
    const ro = { ...config('mssql'), id: 'ms-ro', readOnly: true }
    await svc.connect(ro)
    const [refused] = await svc.runScript(ro.id, sneaky)
    expect(refused!.error?.message).toMatch(/read-only/)
    const drain = async () => {
      for await (const batch of svc.streamQuery(ro.id, sneaky)) void batch
    }
    await expect(drain()).rejects.toThrow(/read-only/)
    await expect(svc.fetchTable(ro.id, { table: { schema: 'dbo', name: 'rg_t' }, filter: { kind: 'raw', id: 'r', sql: '1=1 DELETE FROM dbo.rg_t' }, limit: 10, offset: 0 })).rejects.toThrow(/condition that reads/)
    expect(await value(id, 'SELECT count(*) FROM dbo.rg_t')).toBe(1)
    await svc.runScript(id, sneaky)
    expect(await value(id, 'SELECT count(*) FROM dbo.rg_t')).toBe(0)
  })
})

describe.skipIf(skip.has('oracle'))('read-only guard: oracle', () => {
  it('reads inside SET TRANSACTION READ ONLY', async () => {
    const ora = { id: 'ora-rg', name: 'ora', driver: 'oracle' as const, host: '127.0.0.1', port: 15219, user: 'shop', password: 'mastermind', database: 'FREEPDB1' }
    await svc.connect(ora)
    const [read] = await svc.runScript(ora.id, 'SELECT 1 AS n FROM dual', { readOnly: true })
    expect(read!.error).toBeUndefined()
    expect(Number(read!.results![0]!.rows[0]![0])).toBe(1)
  })
})

for (const engine of ['sqlite', 'duckdb'] as const) {
  describe.skipIf(skip.has(engine))(`read-only guard: ${engine}`, () => {
    it('runs reads and refuses writes (no functions with side effects there)', async () => {
      const c = config(engine)
      await svc.connect(c)
      const [read] = await svc.runScript(c.id, 'SELECT 1 AS n', { readOnly: true })
      expect(read!.results![0]!.rows).toEqual([[1]])
      await expect(svc.runScript(c.id, 'CREATE TABLE rg_x (a int)', { readOnly: true })).rejects.toThrow(/Only reads/)
    })
  })
}

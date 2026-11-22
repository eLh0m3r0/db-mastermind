import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseService } from '../src/index.js'
import { engines, setupEngine, skip } from './fixtures.js'

/**
 * Dashboard tiles may come from a teammate's file: the app runs each with the options of the desktop's `tileRequest`
 * (lib/dashboards.ts): `readOnly: true` and the row cap, the guarded read path of SQL nobody confirmed. Anything that
 * isn't a read is refused with the guard's sentence and nothing changes, even on a connection that allows writes.
 */
const TILE = { readOnly: true, maxRows: 5000 } as const
const svc = new DatabaseService()
afterAll(() => svc.disconnectAll())

describe.skipIf(skip.has('postgres'))('dashboard tiles on PostgreSQL', () => {
  it('a read runs; a write, a hidden second statement and a refused function are refused and change nothing', async () => {
    const base = await setupEngine(svc, engines.find((e) => e.id === 'postgres')!)
    const count = async () => Number((await svc.runScript(base.id, 'SELECT count(*) FROM shop.customers'))[0]!.results![0]!.rows[0]![0])
    const before = await count()
    const [read] = await svc.runScript(base.id, 'SELECT count(*) AS n FROM shop.customers', TILE)
    expect(read!.error).toBeUndefined()
    expect(Number(read!.results![0]!.rows[0]![0])).toBe(before)
    for (const sql of ['DELETE FROM shop.customers', 'SELECT 1; DROP TABLE shop.customers', "SELECT pg_read_file('/etc/passwd')", "SELECT setval('shop.customers_id_seq', 1)"]) {
      await expect(svc.runScript(base.id, sql, TILE), sql).rejects.toThrow(/Only reads are allowed here|read-only/)
    }
    expect(await count()).toBe(before)
    const [exists] = await svc.runScript(base.id, "SELECT to_regclass('shop.customers') IS NOT NULL")
    expect(exists!.results![0]!.rows[0]![0]).toBe(true)
  })
})

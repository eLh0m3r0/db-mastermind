import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseService, type DriverId } from '../src/index.js'
import { engines, setupEngine, skip, tmp } from './fixtures.js'

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/**
 * A grid row's UPDATE / DELETE that would change several rows (its key doesn't identify one) fails and changes nothing,
 * committed at once or in a table tab's transaction (09 finding 6).
 */
for (const id of ['postgres', 'mysql', 'mssql', 'sqlite', 'duckdb'] as DriverId[]) {
  const engine = engines.find((e) => e.id === id)!
  describe.skipIf(skip.has(id))(`one grid row changes one row on ${id}`, () => {
    it('refuses a change its key would make to several rows', async () => {
      const svc = new DatabaseService()
      try {
        const config = await setupEngine(svc, engine)
        const ref = { schema: id === 'postgres' || id === 'mssql' ? 'shop' : undefined, name: 'dbm_twins' }
        const table = svc.qualifiedName(config.id, ref)
        const run = async (sql: string, session?: string) => {
          const [o] = await svc.runScript(config.id, sql, { session })
          if (o?.error) throw new Error(o.error.message)
          return o!.results?.[0]?.rows ?? []
        }
        await run(id === 'mssql' ? `IF OBJECT_ID('shop.dbm_twins') IS NOT NULL DROP TABLE shop.dbm_twins` : `DROP TABLE IF EXISTS ${table}`)
        await run(`CREATE TABLE ${table} (k int, v varchar(10))`)
        await run(`INSERT INTO ${table} (k, v) VALUES (1, 'a')`)
        await run(`INSERT INTO ${table} (k, v) VALUES (1, 'b')`)
        const values = async () => (await run(`SELECT v FROM ${table} ORDER BY v`)).map((r) => String(r[0]))

        await expect(svc.applyChanges(config.id, ref, [{ type: 'update', key: { k: '1' }, values: { v: 'z' } }])).rejects.toThrow(/2 rows/)
        await expect(svc.applyChanges(config.id, ref, [{ type: 'delete', key: { k: '1' } }])).rejects.toThrow(/2 rows/)
        expect(await values()).toEqual(['a', 'b'])

        // In a table tab's transaction (manual commit): the save is undone, the transaction goes on (DuckDB: it can
        // only be rolled back).
        const manual = { ...config, id: `${config.id}-manual`, manualCommit: true }
        await svc.connect(manual)
        const tab = 'table-tab-twins'
        await svc.applyChanges(manual.id, ref, [{ type: 'insert', values: { k: '2', v: 'c' } }], { session: tab })
        await expect(svc.applyChanges(manual.id, ref, [{ type: 'update', key: { k: '1' }, values: { v: 'z' } }], { session: tab })).rejects.toThrow(/2 rows/)
        if (id === 'duckdb') {
          expect(await svc.transactionState(manual.id, tab)).toBe('failed')
          await svc.endTransaction(manual.id, tab, 'rollback')
        } else {
          expect(await svc.transactionState(manual.id, tab)).toBe('open')
          expect(await svc.endTransaction(manual.id, tab, 'commit')).toBe('none')
        }
        await svc.releaseSession(manual.id, tab)
        expect(await values()).toEqual(id === 'duckdb' ? ['a', 'b'] : ['a', 'b', 'c'])
        await run(`DROP TABLE ${table}`)
      } finally {
        await svc.disconnectAll()
      }
    })
  })
}

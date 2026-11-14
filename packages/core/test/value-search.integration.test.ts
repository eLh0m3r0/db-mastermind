import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseService, valueSearchConditions, valueSearchFilter, type ValueSearchMode } from '../src/index.js'
import { engines, setupEngine, skip, tmp } from './fixtures.js'

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/** What the app's Find value tab does: every table, one filtered read each; returns the tables with rows. */
async function findEverywhere(svc: DatabaseService, id: string, text: string, mode: ValueSearchMode) {
  const snapshot = await svc.schema(id, true)
  const driver = svc.config(id).driver
  const hits: string[] = []
  const errors: string[] = []
  for (const table of snapshot.tables.filter((t) => t.type === 'table')) {
    const conditions = valueSearchConditions(table, text, mode, driver)
    if (!conditions.length) continue
    try {
      const page = await svc.fetchTable(id, { table: { schema: table.schema, name: table.name }, filter: valueSearchFilter(conditions), limit: 6 })
      if (page.result.rows.length) hits.push(table.name.toLowerCase())
    } catch (err) {
      errors.push(`${table.name}: ${(err as Error).message}`)
    }
  }
  return { hits, errors }
}

for (const engine of engines) {
  describe.skipIf(skip.has(engine.id))(`find a value on ${engine.id}`, () => {
    it('finds text, numbers and dates in the right tables without an error on any column type', async () => {
      const svc = new DatabaseService()
      try {
        const config = await setupEngine(svc, engine)
        const alice = await findEverywhere(svc, config.id, 'alice@example.com', 'exact')
        expect(alice.errors).toEqual([])
        expect(alice.hits).toContain('customers')
        expect(alice.hits).not.toContain('orders')

        const partial = await findEverywhere(svc, config.id, 'ALICE', 'contains')
        expect(partial.errors).toEqual([])
        expect(partial.hits).toContain('customers')

        // orders.total = g * 10.5: 105.00 for g = 10.
        const amount = await findEverywhere(svc, config.id, '105', 'exact')
        expect(amount.errors).toEqual([])
        expect(amount.hits).toContain('orders')

        if (engine.id !== 'sqlite') {
          // ordered_on = 2026-01-01 + g days.
          const day = await findEverywhere(svc, config.id, '2026-01-11', 'exact')
          expect(day.errors).toEqual([])
          expect(day.hits).toContain('orders')
        }

        const nothing = await findEverywhere(svc, config.id, 'no such value anywhere', 'exact')
        expect(nothing).toEqual({ hits: [], errors: [] })

        // The last instant of a day is that day; the next midnight is not (review finding).
        const ts = { postgres: 'timestamp(6)', mysql: 'datetime(6)', mariadb: 'datetime(6)', mssql: 'datetime2(7)', duckdb: 'timestamp', sqlite: 'datetime' }[engine.id as string]
        const t = svc.qualifiedName(config.id, { schema: engine.id === 'postgres' || engine.id === 'mssql' ? 'shop' : undefined, name: 'vs_times' })
        await svc.runScript(config.id, engine.id === 'mssql' ? `IF OBJECT_ID('shop.vs_times') IS NOT NULL DROP TABLE shop.vs_times` : `DROP TABLE IF EXISTS ${t}`)
        for (const sql of [`CREATE TABLE ${t} (id int, seen ${ts})`, `INSERT INTO ${t} (id, seen) VALUES (1, '2030-05-05 23:59:59.9995'), (2, '2030-05-06 00:00:00')`]) {
          const [o] = await svc.runScript(config.id, sql)
          expect(o?.error?.message, sql).toBeUndefined()
        }
        await svc.schema(config.id, true)
        const snapshot = await svc.schema(config.id)
        const timesTable = snapshot.tables.find((x) => x.name.toLowerCase() === 'vs_times')!
        const page = await svc.fetchTable(config.id, { table: { schema: timesTable.schema, name: timesTable.name }, filter: valueSearchFilter(valueSearchConditions(timesTable, '2030-05-05', 'exact', engine.id)), limit: 10 })
        expect(page.result.rows.map((r) => Number(r[0]))).toEqual([1])
        await svc.runScript(config.id, `DROP TABLE ${t}`)
      } finally {
        await svc.disconnectAll()
      }
    })
  })
}

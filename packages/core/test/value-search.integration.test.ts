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
      } finally {
        await svc.disconnectAll()
      }
    })
  })
}

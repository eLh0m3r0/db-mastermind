import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseService } from '../src/index.js'
import { engines, setupEngine, skip, tmp } from './fixtures.js'

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

for (const engine of engines) {
  describe.skipIf(skip.has(engine.id))(`column profile on ${engine.id}`, () => {
    it('counts rows, NULLs and distinct values, with min / max and the most common values, under the tab’s filter', async () => {
      const svc = new DatabaseService()
      try {
        const config = await setupEngine(svc, engine)
        const schema = engine.id === 'postgres' || engine.id === 'mssql' ? 'shop' : undefined
        const orders = { schema, name: 'orders' }
        const status = await svc.profileColumn(config.id, { table: orders, column: 'status' })
        expect(status).toMatchObject({ total: 120, filled: 120, distinct: 2, min: 'new', max: 'paid' })
        expect(status.top.map((t) => [t.value, t.count]).sort()).toEqual([
          ['new', 60],
          ['paid', 60],
        ])

        const paid = await svc.profileColumn(config.id, { table: orders, column: 'total', filter: { kind: 'group', id: 'g', combinator: 'and', children: [{ kind: 'condition', id: 'c', column: 'status', operator: 'eq', value: 'paid' }] } })
        expect(paid.total).toBe(60)
        expect(paid.top.length).toBe(10)

        // NULLs counted apart; types without MIN/MAX or DISTINCT (PostgreSQL boolean, JSON) still give the rest.
        const email = await svc.profileColumn(config.id, { table: { schema, name: 'customers' }, column: 'email' })
        expect(email).toMatchObject({ total: 3, filled: 2, distinct: 2 })
        for (const column of ['vip', 'meta']) {
          const p = await svc.profileColumn(config.id, { table: { schema, name: 'customers' }, column })
          expect(p.total).toBe(3)
        }
        await expect(svc.profileColumn(config.id, { table: orders, column: 'nope' })).rejects.toThrow(/Unknown column/)
      } finally {
        await svc.disconnectAll()
      }
    })
  })
}

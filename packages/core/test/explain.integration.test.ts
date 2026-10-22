import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseService, explainQuery, type PlanNode } from '../src/index.js'
import { engines, setupEngine, skip, tmp } from './fixtures.js'

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const flatten = (n: PlanNode): PlanNode[] => [n, ...n.children.flatMap(flatten)]

for (const engine of engines) {
  describe.skipIf(skip.has(engine.id))(`explain on ${engine.id}`, () => {
    it('returns a normalized plan tree that mentions the tables', async () => {
      const svc = new DatabaseService()
      try {
        const config = await setupEngine(svc, engine)
        const o = svc.qualifiedName(config.id, { schema: engine.schema, name: 'orders' })
        const c = svc.qualifiedName(config.id, { schema: engine.schema, name: 'customers' })
        const plan = await explainQuery(svc, config.id, `SELECT c.name, COUNT(*) FROM ${o} o JOIN ${c} c ON c.id = o.customer_id WHERE o.status = 'paid' GROUP BY c.name`)
        const nodes = flatten(plan.root)
        expect(nodes.length).toBeGreaterThan(1)
        // MySQL and SQLite report table aliases (o, c), the others table names.
        expect(nodes.filter((n) => n.object).length).toBeGreaterThanOrEqual(2)
        expect(plan.raw.length).toBeGreaterThan(10)
        await expect(explainQuery(svc, config.id, `DELETE FROM ${o}`)).rejects.toThrow(/Only SELECT/)
        if (engine.id === 'postgres') {
          const analyzed = await explainQuery(svc, config.id, `SELECT * FROM ${o} WHERE total > 100`, true)
          expect(analyzed.root.actualMs).toBeGreaterThanOrEqual(0)
        }
      } finally {
        await svc.disconnectAll()
      }
    })
  })
}

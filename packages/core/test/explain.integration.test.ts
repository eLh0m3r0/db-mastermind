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
        // PostgreSQL plans writes too (see below); a second statement is never sent along.
        if (['mssql', 'duckdb'].includes(engine.id)) await expect(explainQuery(svc, config.id, `DELETE FROM ${o}`)).rejects.toThrow(/Only SELECT/)
        else {
          const count = async () => Number((await svc.runScript(config.id, `SELECT COUNT(*) FROM ${o}`))[0]!.results![0]!.rows[0]![0])
          const before = await count()
          const del = await explainQuery(svc, config.id, `DELETE FROM ${o} WHERE status = 'paid'`)
          expect(del.raw.length).toBeGreaterThan(5)
          expect(await count()).toBe(before)
        }
        await expect(explainQuery(svc, config.id, `SELECT 1; DELETE FROM ${o}`)).rejects.toThrow(/one statement/)
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

describe.skipIf(skip.has('postgres'))('explain on postgres: writes and the tab session', () => {
  it('plans UPDATE, undoes EXPLAIN ANALYZE, sees the tab’s temp tables', async () => {
    const svc = new DatabaseService()
    const engine = engines.find((e) => e.id === 'postgres')!
    try {
      const config = await setupEngine(svc, engine)
      const count = async () => Number((await svc.runScript(config.id, 'SELECT count(*) FROM shop.orders'))[0]!.results![0]!.rows[0]![0])
      const before = await count()
      const plan = await explainQuery(svc, config.id, 'UPDATE shop.orders SET total = total + 1 WHERE id = 1')
      expect(flatten(plan.root).some((n) => /Update/.test(n.operation))).toBe(true)
      // ANALYZE runs the DELETE and rolls it back, outside and inside an open transaction of the tab.
      const analyzed = await explainQuery(svc, config.id, 'DELETE FROM shop.orders', true, { session: 'tab-x' })
      expect(analyzed.root.operation).toBe("Delete")
      expect(flatten(analyzed.root).some((n) => n.actualRows === before)).toBe(true)
      expect(await count()).toBe(before)
      await svc.runScript(config.id, 'BEGIN; CREATE TEMP TABLE dbm_tmp (id int); INSERT INTO dbm_tmp VALUES (1)', { session: 'tab-x' })
      await explainQuery(svc, config.id, 'DELETE FROM shop.orders', true, { session: 'tab-x' })
      expect(await svc.transactionState(config.id, 'tab-x')).toBe('open')
      const temp = await explainQuery(svc, config.id, 'SELECT * FROM dbm_tmp', false, { session: 'tab-x' })
      expect(flatten(temp.root).some((n) => n.object?.includes('dbm_tmp'))).toBe(true)
      expect((await svc.runScript(config.id, 'SELECT count(*) FROM dbm_tmp', { session: 'tab-x' }))[0]!.results![0]!.rows[0]![0]).toBe('1')
      await svc.runScript(config.id, 'ROLLBACK', { session: 'tab-x' })
      expect(await count()).toBe(before)
    } finally {
      await svc.disconnectAll()
    }
  })

  it('undoes what ANALYZE of a SELECT wrote, and refuses in a failed transaction without ending it (review findings)', async () => {
    const svc = new DatabaseService()
    const engine = engines.find((e) => e.id === 'postgres')!
    try {
      const config = await setupEngine(svc, engine)
      const run = async (sql: string, session?: string) => (await svc.runScript(config.id, sql, { session }))[0]!
      await run('CREATE TABLE IF NOT EXISTS shop.dbm_explain_log (n int)')
      await run('DELETE FROM shop.dbm_explain_log')
      await run('CREATE OR REPLACE FUNCTION shop.dbm_log() RETURNS int LANGUAGE sql AS $$ INSERT INTO shop.dbm_explain_log VALUES (1) RETURNING n $$')
      await explainQuery(svc, config.id, 'SELECT shop.dbm_log()', true)
      expect(Number((await run('SELECT count(*) FROM shop.dbm_explain_log')).results![0]!.rows[0]![0])).toBe(0)
      await run('BEGIN', 'tab-f')
      await run('SELECT 1/0', 'tab-f')
      expect(await svc.transactionState(config.id, 'tab-f')).toBe('failed')
      await expect(explainQuery(svc, config.id, 'DELETE FROM shop.orders', true, { session: 'tab-f' })).rejects.toThrow(/roll it back first/)
      expect(await svc.transactionState(config.id, 'tab-f')).toBe('failed')
      await run('ROLLBACK', 'tab-f')
      await run('DROP FUNCTION shop.dbm_log()')
      await run('DROP TABLE shop.dbm_explain_log')
    } finally {
      await svc.disconnectAll()
    }
  })
})

describe.skipIf(skip.has('mssql'))('explain on SQL Server: the tab session after a failed plan (review finding)', () => {
  it('turns SHOWPLAN_XML off again when the statement does not compile', async () => {
    const svc = new DatabaseService()
    const engine = engines.find((e) => e.id === 'mssql')!
    try {
      const config = await setupEngine(svc, engine)
      await expect(explainQuery(svc, config.id, 'SELECT * FROM dbo.no_such_table_here', false, { session: 'tab-ms' })).rejects.toThrow()
      const [o] = await svc.runScript(config.id, 'SELECT 1 AS one', { session: 'tab-ms' })
      expect(o!.results![0]!.fields.map((f) => f.name)).toEqual(['one'])
      expect(o!.results![0]!.rows).toEqual([[1]])
    } finally {
      await svc.disconnectAll()
    }
  })
})

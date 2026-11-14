import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseService, inspectSql, sampleDatabaseSql, SAMPLE_KNOWLEDGE } from '../src/index.js'
import { engines, setupEngine, skip } from './fixtures.js'

const dir = mkdtempSync(join(tmpdir(), 'dbm-inspect-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** Valid SQL must never be underlined (a wrong mark teaches people to ignore the marks). */
describe('editor warnings on real SQL', () => {
  it('the demo database’s own script and its knowledge base queries raise no table or column warning', async () => {
    const svc = new DatabaseService()
    try {
      await svc.connect({ id: 'demo', name: 'demo', driver: 'sqlite', filePath: join(dir, 'demo.db') })
      const script = sampleDatabaseSql()
      for (const sql of script) await svc.runScript('demo', sql)
      const snapshot = await svc.schema('demo', true)
      // The knowledge base's AI tools (tools/*.sql) and SQL blocks in its notes.
      const tools = Object.entries(SAMPLE_KNOWLEDGE).filter(([path]) => path.endsWith('.sql')).map(([, sql]) => sql)
      const blocks = Object.values(SAMPLE_KNOWLEDGE).flatMap((md) => [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]!))
      const sources = [...script.filter((s) => !/^\s*CREATE\s+TABLE/i.test(s)), ...tools, ...blocks]
      console.log(`checked ${sources.length} statements (${tools.length} tools, ${blocks.length} note blocks)`)
      expect(sources.length).toBeGreaterThan(5)
      const wrong = sources.flatMap((sql) => inspectSql(sql, 'sqlite', snapshot).filter((w) => w.kind !== 'no-where').map((w) => `${w.kind} in: ${sql.slice(0, 120)}`))
      expect(wrong).toEqual([])
    } finally {
      await svc.disconnectAll()
    }
  })

  for (const engine of engines.filter((e) => e.id !== 'sqlite')) {
    it.skipIf(skip.has(engine.id))(`the ${engine.id} fixture script raises none either`, async () => {
      const svc = new DatabaseService()
      try {
        const config = await setupEngine(svc, engine)
        const snapshot = await svc.schema(config.id, true)
        const wrong = engine.setup.flatMap((sql) => inspectSql(sql, engine.id, snapshot).filter((w) => w.kind !== 'no-where').map((w) => `${w.kind} ${JSON.stringify(w)} in: ${sql.slice(0, 160)}`))
        expect(wrong).toEqual([])
        // Everyday queries: each must run (it is valid) and get no mark.
        const s = engine.id === 'postgres' || engine.id === 'mssql' ? 'shop.' : ''
        const top = (n: number, rest: string) => (engine.id === 'mssql' ? `SELECT TOP ${n} ${rest}` : `SELECT ${rest} LIMIT ${n}`)
        const queries = [
          `SELECT c.name, COUNT(o.id) AS n, SUM(o.total) AS revenue FROM ${s}customers c LEFT JOIN ${s}orders o ON o.customer_id = c.id GROUP BY c.name HAVING COUNT(o.id) > 0 ORDER BY revenue DESC`,
          `WITH paid AS (SELECT customer_id, total FROM ${s}orders WHERE status = 'paid') SELECT p.customer_id, MAX(p.total) AS best FROM paid p GROUP BY p.customer_id`,
          `SELECT o.id, o.total FROM ${s}orders o WHERE EXISTS (SELECT 1 FROM ${s}customers c WHERE c.id = o.customer_id AND c.email IS NOT NULL)`,
          `SELECT o.id, ROW_NUMBER() OVER (PARTITION BY o.customer_id ORDER BY o.total DESC) AS rn FROM ${s}orders o`,
          `SELECT CASE WHEN o.total > 100 THEN 'big' ELSE 'small' END AS size, COUNT(*) AS n FROM ${s}orders o GROUP BY CASE WHEN o.total > 100 THEN 'big' ELSE 'small' END`,
          `SELECT o.id FROM ${s}orders o WHERE o.customer_id IN (SELECT c.id FROM ${s}customers c WHERE c.vip = ${engine.id === 'postgres' || engine.id === 'duckdb' ? 'true' : '1'})`,
          top(3, `o.id, o.ordered_on FROM ${s}orders o ORDER BY o.ordered_on DESC`),
          ...(engine.id === 'mssql' ? [] : [`SELECT EXTRACT(YEAR FROM o.ordered_on) AS y, COUNT(*) AS n FROM ${s}orders o GROUP BY EXTRACT(YEAR FROM o.ordered_on)`]),
          `UPDATE ${s}orders SET status = status WHERE id = -1`,
          `DELETE FROM ${s}orders WHERE id = -1`,
        ]
        for (const sql of queries) {
          const [o] = await svc.runScript(config.id, sql)
          expect(o?.error?.message, sql).toBeUndefined()
          expect(inspectSql(sql, engine.id, snapshot), sql).toEqual([])
        }
      } finally {
        await svc.disconnectAll()
      }
    })
  }
})

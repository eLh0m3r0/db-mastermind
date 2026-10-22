import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseService } from '../src/index.js'
import { engines, setupEngine, skip, tmp } from './fixtures.js'

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

for (const engine of engines) {
  describe.skipIf(skip.has(engine.id))(`streaming on ${engine.id}`, () => {
    it('reads a query in batches with the same rows as a normal run, and survives stopping early', async () => {
      const svc = new DatabaseService()
      try {
        const config = await setupEngine(svc, engine)
        const orders = svc.qualifiedName(config.id, { schema: engine.schema === 'mastermind' || engine.schema === 'main' ? undefined : engine.schema, name: 'orders' })
        const sql = `SELECT id, total, status FROM ${orders} ORDER BY id`
        const batches: number[] = []
        const streamed: unknown[][] = []
        for await (const batch of svc.streamQuery(config.id, sql, { batchSize: 50 })) {
          expect(batch.fields.map((f) => f.name.toLowerCase())).toEqual(['id', 'total', 'status'])
          batches.push(batch.rows.length)
          streamed.push(...batch.rows)
        }
        expect(streamed).toHaveLength(120)
        // DuckDB streams in its own vector size; the others respect batchSize.
        if (engine.id !== 'duckdb') expect(batches).toEqual([50, 50, 20])
        const [plain] = await svc.runScript(config.id, sql)
        expect(streamed).toEqual(plain!.results![0]!.rows)

        // Stop after the first batch: the statement is cancelled and the connection keeps working.
        for await (const batch of svc.streamQuery(config.id, sql, { batchSize: 10 })) {
          expect(batch.rows.length).toBeGreaterThan(0)
          break
        }
        const [after] = await svc.runScript(config.id, `SELECT COUNT(*) FROM ${orders}`)
        expect(Number(after!.results![0]!.rows[0]![0])).toBe(120)
      } finally {
        await svc.disconnectAll()
      }
    })
  })
}

import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseService, type BuiltQuery, type DriverId } from '../src/index.js'
import { engines, setupEngine, skip, tmp } from './fixtures.js'

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/** An import streams its rows: batches run one after another in one transaction (05 finding 2). */
for (const id of ['postgres', 'mysql', 'sqlite'] as DriverId[]) {
  const engine = engines.find((e) => e.id === id)!
  describe.skipIf(skip.has(id))(`transactionBatches on ${id}`, () => {
    const svc = new DatabaseService()
    afterAll(() => svc.disconnectAll())
    const ROWS = 3000
    const PER = 250

    async function* batches(table: string, options: { failAt?: number; onBatch?: (n: number) => void } = {}): AsyncGenerator<BuiltQuery[]> {
      const d = svc.driver(engine.config.id).dialect
      for (let b = 0; b * PER < ROWS; b++) {
        options.onBatch?.(b)
        const values = Array.from({ length: PER }, (_, i) => b * PER + i + 1)
        if (b === options.failAt) values[0] = 1 // a duplicate key in a later batch
        const sql = `INSERT INTO ${table} (id) VALUES ${values.map((_, i) => `(${d.placeholder(i + 1)})`).join(', ')}`
        yield [{ sql, params: values }]
      }
    }

    it('commits every batch together, and leaves the table as it was after an error, an abort or on a read-only connection', async () => {
      const config = await setupEngine(svc, engine)
      const table = svc.qualifiedName(config.id, { schema: id === 'postgres' ? 'shop' : undefined, name: 'dbm_batches' })
      const run = async (sql: string) => {
        const [o] = await svc.runScript(config.id, sql)
        if (o?.error) throw new Error(o.error.message)
        return o!.results?.[0]?.rows ?? []
      }
      const count = async () => Number((await run(`SELECT count(*) FROM ${table}`))[0]![0])
      await run(`DROP TABLE IF EXISTS ${table}`)
      await run(`CREATE TABLE ${table} (id int PRIMARY KEY)`)

      // Pulled one at a time: the next batch is asked for only after the one before ran.
      const pulled: number[] = []
      expect(await svc.transactionBatches(config.id, batches(table, { onBatch: (n) => pulled.push(n) }))).toBe(ROWS)
      expect(pulled).toEqual(Array.from({ length: ROWS / PER }, (_, i) => i))
      expect(await count()).toBe(ROWS)

      await run(`DELETE FROM ${table}`)
      await expect(svc.transactionBatches(config.id, batches(table, { failAt: 5 }))).rejects.toThrow()
      expect(await count()).toBe(0)

      const stop = new AbortController()
      await expect(svc.transactionBatches(config.id, batches(table, { onBatch: (n) => n === 4 && stop.abort() }), { signal: stop.signal })).rejects.toThrow()
      expect(await count()).toBe(0)

      const ro = { ...config, id: `${config.id}-ro`, readOnly: true }
      await svc.connect(ro)
      await expect(svc.transactionBatches(ro.id, batches(table))).rejects.toThrow(/read-only/i)
      expect(await count()).toBe(0)
      await run(`DROP TABLE ${table}`)
    })
  })
}

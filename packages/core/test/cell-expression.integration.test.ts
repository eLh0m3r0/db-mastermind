import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseService } from '../src/index.js'
import { engines, setupEngine, skip, tmp } from './fixtures.js'

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

for (const engine of engines) {
  describe.skipIf(skip.has(engine.id))(`a cell set to an SQL expression on ${engine.id}`, () => {
    it('changes exactly its row, and the review’s escape never reaches the database', async () => {
      const svc = new DatabaseService()
      try {
        const config = await setupEngine(svc, engine)
        const table = { schema: engine.id === 'postgres' || engine.id === 'mssql' ? 'shop' : undefined, name: 'orders' }
        const q = svc.qualifiedName(config.id, table)
        const total = async (id: number) => Number((await svc.runScript(config.id, `SELECT total FROM ${q} WHERE id = ${id}`))[0]!.results![0]!.rows[0]![0])
        const before = [await total(1), await total(2)]
        const affected = await svc.applyChanges(config.id, table, [{ type: 'update', key: { id: 1 }, values: { total: { $sql: 'total * 2' } } }])
        expect(affected).toEqual([1])
        expect([await total(1), await total(2)]).toEqual([before[0]! * 2, before[1]])
        // The MySQL backslash escape from the review: refused before any SQL is sent.
        await expect(svc.applyChanges(config.id, table, [{ type: 'update', key: { id: 1 }, values: { status: { $sql: "'\\'+') WHERE id = ? OR 1=1 # '" } } }])).rejects.toThrow(/backslash/)
        expect(Number((await svc.runScript(config.id, `SELECT COUNT(*) FROM ${q} WHERE status IN ('new', 'paid')`))[0]!.results![0]!.rows[0]![0])).toBe(120)
      } finally {
        await svc.disconnectAll()
      }
    })
  })
}

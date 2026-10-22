import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { buildBatchInserts, DatabaseService, getDialect, parseDelimited } from '../src/index.js'
import { engines, setupEngine, skip, tmp } from './fixtures.js'

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const csv = ['code;amount;day;note', ...Array.from({ length: 1200 }, (_, i) => `${i + 1};${(i * 1.25).toFixed(2)};2026-01-${String((i % 28) + 1).padStart(2, '0')};${i % 3 ? `row ${i}` : ''}`)].join('\n')

for (const engine of engines) {
  describe.skipIf(skip.has(engine.id))(`import on ${engine.id}`, () => {
    it('imports text values into typed columns in one transaction', async () => {
      const svc = new DatabaseService()
      try {
        const config = await setupEngine(svc, engine)
        const d = getDialect(engine.id)
        const table = { schema: engine.schema, name: 'import_test' }
        const t = svc.qualifiedName(config.id, table)
        const text = engine.id === 'mssql' ? 'nvarchar(50)' : engine.id === 'sqlite' ? 'TEXT' : 'varchar(50)'
        await svc.runScript(config.id, `DROP TABLE IF EXISTS ${t}`)
        const [created] = await svc.runScript(config.id, `CREATE TABLE ${t} (code int NOT NULL, amount decimal(10,2), day date, note ${text})`)
        expect(created!.error).toBeUndefined()

        const [header, ...rows] = parseDelimited(csv)
        const statements = buildBatchInserts(table, header!, rows, d, { emptyAsNull: true })
        await svc.transactionRaw(config.id, statements)
        const [count] = await svc.runScript(config.id, `SELECT COUNT(*), SUM(code), COUNT(note) FROM ${t}`)
        expect(count!.results![0]!.rows[0]!.map(Number)).toEqual([1200, 720600, 800])

        // A bad row rolls back the whole import.
        await expect(svc.transactionRaw(config.id, buildBatchInserts(table, ['code'], [['1'], [null]], d))).rejects.toThrow()
        const [again] = await svc.runScript(config.id, `SELECT COUNT(*) FROM ${t}`)
        expect(Number(again!.results![0]!.rows[0]![0])).toBe(1200)
        await svc.runScript(config.id, `DROP TABLE ${t}`)
      } finally {
        await svc.disconnectAll()
      }
    })
  })
}

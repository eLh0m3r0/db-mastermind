import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { compareTableData, dataSyncScript, DatabaseService, getDialect, type TableRef } from '../src/index.js'
import { engines, setupEngine, skip, tmp } from './fixtures.js'

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const copySql: Record<string, string[]> = {
  postgres: ['DROP TABLE IF EXISTS shop.orders_copy', 'CREATE TABLE shop.orders_copy AS SELECT * FROM shop.orders'],
  mysql: ['DROP TABLE IF EXISTS orders_copy', 'CREATE TABLE orders_copy AS SELECT * FROM orders'],
  mariadb: ['DROP TABLE IF EXISTS orders_copy', 'CREATE TABLE orders_copy AS SELECT * FROM orders'],
  // CAST drops the IDENTITY property so the sync script can insert explicit ids.
  mssql: [
    `IF OBJECT_ID('shop.orders_copy', 'U') IS NOT NULL DROP TABLE shop.orders_copy`,
    'SELECT CAST(id AS bigint) AS id, customer_id, total, status, ordered_on INTO shop.orders_copy FROM shop.orders',
  ],
  sqlite: ['DROP TABLE IF EXISTS orders_copy', 'CREATE TABLE orders_copy AS SELECT * FROM orders'],
}

for (const engine of engines) {
  describe.skipIf(skip.has(engine.id))(`data compare on ${engine.id}`, () => {
    it('finds missing, extra and changed rows, and the sync script removes them', async () => {
      const svc = new DatabaseService()
      try {
        const config = await setupEngine(svc, engine)
        const schema = engine.id === 'postgres' || engine.id === 'mssql' ? 'shop' : undefined
        const t = (name: string) => (schema ? `${schema}.${name}` : name)
        for (const sql of [
          ...copySql[engine.id]!,
          `DELETE FROM ${t('orders_copy')} WHERE id <= 3`,
          `UPDATE ${t('orders_copy')} SET status = 'refunded' WHERE id BETWEEN 10 AND 14`,
          `UPDATE ${t('orders_copy')} SET total = total + 1 WHERE id = 20`,
          `INSERT INTO ${t('orders_copy')} (id, customer_id, total, status, ordered_on) SELECT 1000, customer_id, total, status, ordered_on FROM ${t('orders')} WHERE id = 50`,
        ]) {
          const [o] = await svc.runScript(config.id, sql)
          expect(o!.error?.message, sql).toBeUndefined()
        }
        const source: TableRef = { schema, name: 'orders' }
        const target: TableRef = { schema, name: 'orders_copy' }
        const compare = () => compareTableData(svc, { source: { connectionId: config.id, table: source }, target: { connectionId: config.id, table: target }, keyColumns: ['id'] })

        const result = await compare()
        expect(result.counts).toEqual({ missing: 3, extra: 1, changed: 6 })
        expect(result.identical).toBe(120 - 3 - 6)
        expect(result.diffs.find((d) => d.kind === 'changed' && String(d.key.id) === '20')?.changed).toEqual(['total'])

        const script = dataSyncScript(result, target, getDialect(engine.id), { deleteExtra: true })
        const outcomes = await svc.runScript(config.id, script)
        const failed = outcomes.find((o) => o.error)
        expect(failed?.error?.message, failed?.sql).toBeUndefined()

        const after = await compare()
        expect(after.counts).toEqual({ missing: 0, extra: 0, changed: 0 })
        expect(after.identical).toBe(120)
      } finally {
        await svc.disconnectAll()
      }
    })
  })
}

import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseService, storageReport, topQueries, type ConnectionConfig } from '../src/index.js'
import { engines, setupEngine, skip, tmp } from './fixtures.js'

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

for (const engine of engines) {
  describe.skipIf(skip.has(engine.id))(`server health on ${engine.id}`, () => {
    it('lists table sizes (orders largest), unused indexes where tracked, and top queries or why there are none', async () => {
      const svc = new DatabaseService()
      try {
        const config = await setupEngine(svc, engine)
        const storage = await storageReport(svc, config.id)
        const names = storage.tables.map((t) => t.name.toLowerCase())
        expect(names).toEqual(expect.arrayContaining(['orders', 'customers']))
        const orders = storage.tables.find((t) => t.name.toLowerCase() === 'orders')!
        if (engine.id !== 'sqlite' && engine.id !== 'duckdb') expect(orders.totalBytes).toBeGreaterThan(0)
        if (engine.id === 'postgres' || engine.id === 'mssql') {
          // orders_status_idx was never used for a lookup; the primary keys are never listed.
          expect(storage.unusedIndexes?.map((i) => i.index)).toContain('orders_status_idx')
          expect(storage.unusedIndexes?.some((i) => /pkey|^PK__/i.test(i.index))).toBe(false)
          expect(storage.statsSince).toBeTruthy()
        }

        // Something to count right before reading the statistics (a small server's plan cache forgets cheap plans).
        const count = async () => {
          for (let i = 0; i < 3; i++) await svc.runScript(config.id, `SELECT COUNT(*) FROM ${svc.qualifiedName(config.id, { schema: engine.id === 'postgres' || engine.id === 'mssql' ? 'shop' : undefined, name: 'orders' })} WHERE total > ${i}`)
          return topQueries(svc, config.id)
        }
        let top = await count()
        // The test SQL Server has little memory and drops cheap plans from its cache under pressure: try again.
        for (let attempt = 0; engine.id === 'mssql' && attempt < 5 && top.available && !top.queries.some((q) => /orders/i.test(q.query)); attempt++) top = await count()
        if (engine.id === 'sqlite' || engine.id === 'duckdb') expect(top.available).toBe(false)
        else if (engine.id === 'postgres') {
          const [o] = await svc.runScript(config.id, 'SHOW shared_preload_libraries')
          const loaded = String(o!.results![0]!.rows[0]![0]).includes('pg_stat_statements')
          if (!loaded) expect(top).toMatchObject({ available: false, enableSql: 'CREATE EXTENSION pg_stat_statements;' })
          else {
            await svc.runScript(config.id, 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements')
            for (let i = 0; i < 3; i++) await svc.runScript(config.id, `SELECT COUNT(*) FROM shop.orders WHERE total > ${i}`)
            const again = await topQueries(svc, config.id)
            expect(again.available).toBe(true)
            if (again.available) expect(again.queries.some((q) => /shop\.orders/.test(q.query) && q.calls >= 3)).toBe(true)
          }
        } else if (engine.id === 'mariadb' && !top.available) {
          // MariaDB ships with performance_schema off: the reason says how to turn it on.
          expect(top.reason).toMatch(/performance_schema/)
        } else {
          expect(top.available).toBe(true)
          if (top.available) {
            expect(top.queries.length).toBeGreaterThan(0)
            expect(top.queries.some((q) => /orders/i.test(q.query))).toBe(true)
            for (const q of top.queries) expect(q.calls).toBeGreaterThanOrEqual(0)
          }
        }
      } finally {
        await svc.disconnectAll()
      }
    })
  })
}

/** A server that loads pg_stat_statements (CI's postgres does; locally: DBM_PGSS_PORT for a throwaway container). */
const pgssPort = Number(process.env.DBM_PGSS_PORT ?? 0)
describe.skipIf(!pgssPort)('top queries with pg_stat_statements loaded', () => {
  it('reads the statements and their totals', async () => {
    const svc = new DatabaseService()
    const config: ConnectionConfig = { id: 'pgss', name: 'pgss', driver: 'postgres', host: '127.0.0.1', port: pgssPort, user: 'postgres', password: 'mastermind', database: 'postgres' }
    try {
      await svc.connect(config)
      await svc.runScript('pgss', 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements')
      await svc.runScript('pgss', 'CREATE TABLE IF NOT EXISTS pgss_t (id int)')
      for (let i = 0; i < 4; i++) await svc.runScript('pgss', `SELECT count(*) FROM pgss_t WHERE id > ${i}`)
      const top = await topQueries(svc, 'pgss')
      expect(top.available).toBe(true)
      if (top.available) expect(top.queries.find((q) => /pgss_t/.test(q.query) && /count/i.test(q.query))?.calls).toBeGreaterThanOrEqual(4)
    } finally {
      await svc.disconnectAll()
    }
  })
})

import { describe, expect, it } from 'vitest'
import { createScript, DatabaseService, getDialect, rowKey } from '../src/index.js'
import { engines, setupEngine, skip } from './fixtures.js'

describe.skipIf(skip.has('mssql'))('SQL Server indexes in the snapshot (review findings)', () => {
  it('leaves out indexes without key columns and never takes a disabled unique index as a row key', async () => {
    const svc = new DatabaseService()
    try {
      const config = await setupEngine(svc, engines.find((e) => e.id === 'mssql')!)
      const run = async (sql: string) => {
        const [o] = await svc.runScript(config.id, sql)
        if (o?.error) throw new Error(`${sql}: ${o.error.message}`)
      }
      await run(`IF OBJECT_ID('shop.dbm_ix') IS NOT NULL DROP TABLE shop.dbm_ix`)
      await run('CREATE TABLE shop.dbm_ix (code int NOT NULL, amount int NOT NULL)')
      await run('CREATE UNIQUE INDEX ux_dbm_ix_code ON shop.dbm_ix (code)')
      await run('CREATE NONCLUSTERED COLUMNSTORE INDEX cs_dbm_ix ON shop.dbm_ix (amount)')
      await run('ALTER INDEX ux_dbm_ix_code ON shop.dbm_ix DISABLE')
      const table = (await svc.schema(config.id, true)).tables.find((t) => t.schema === 'shop' && t.name === 'dbm_ix')!
      expect(table.indexes.map((i) => i.name)).toEqual(['ux_dbm_ix_code'])
      expect(table.indexes[0]).toMatchObject({ unique: true, notEnforced: true })
      expect(rowKey(table)).toEqual([])
      expect(createScript([table], getDialect('mssql'))).not.toMatch(/\(\s*\)/)
      await run('DROP TABLE shop.dbm_ix')
    } finally {
      await svc.disconnectAll()
    }
  })
})

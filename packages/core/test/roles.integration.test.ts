import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseService, listGrants, listPrincipals } from '../src/index.js'
import { engines, setupEngine, skip, tmp } from './fixtures.js'

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const setup: Record<string, { sql: string[]; principal: string; object: RegExp }> = {
  postgres: {
    sql: ['DROP ROLE IF EXISTS dbm_reader', 'CREATE ROLE dbm_reader', 'GRANT USAGE ON SCHEMA shop TO dbm_reader', 'GRANT SELECT ON shop.customers TO dbm_reader'],
    principal: 'dbm_reader',
    object: /^shop\.customers$/,
  },
  mysql: {
    sql: [`DROP USER IF EXISTS 'dbm_reader'@'%'`, `CREATE USER 'dbm_reader'@'%'`, `GRANT SELECT ON mastermind.customers TO 'dbm_reader'@'%'`],
    principal: `'dbm_reader'@'%'`,
    object: /^mastermind\.customers$/,
  },
  mariadb: {
    sql: [`DROP USER IF EXISTS 'dbm_reader'@'%'`, `CREATE USER 'dbm_reader'@'%'`, `GRANT SELECT ON mastermind.customers TO 'dbm_reader'@'%'`],
    principal: `'dbm_reader'@'%'`,
    object: /^mastermind\.customers$/,
  },
  mssql: {
    sql: [`IF USER_ID('dbm_reader') IS NOT NULL DROP USER dbm_reader`, 'CREATE USER dbm_reader WITHOUT LOGIN', 'GRANT SELECT ON shop.customers TO dbm_reader'],
    principal: 'dbm_reader',
    object: /^shop\.customers$/,
  },
}

for (const engine of engines.filter((e) => setup[e.id])) {
  describe.skipIf(skip.has(engine.id))(`users and roles on ${engine.id}`, () => {
    it('lists principals and their grants', async () => {
      const svc = new DatabaseService()
      try {
        const config = await setupEngine(svc, engine)
        const s = setup[engine.id]!
        for (const sql of s.sql) {
          const [o] = await svc.runScript(config.id, sql)
          expect(o!.error?.message, sql).toBeUndefined()
        }
        const principals = await listPrincipals(svc, config.id)
        expect(principals.map((p) => p.name)).toContain(s.principal)
        const grants = await listGrants(svc, config.id, s.principal)
        const table = grants.find((g) => s.object.test(g.object))
        expect(table?.privileges).toContain('SELECT')
      } finally {
        await svc.disconnectAll()
      }
    })
  })
}

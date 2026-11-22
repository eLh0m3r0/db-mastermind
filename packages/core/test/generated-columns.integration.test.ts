import { afterAll, describe, expect, it } from 'vitest'
import { compareSchemas, DatabaseService, generateMigration, getDialect, migrationScript, type ConnectionConfig, type DriverId, type TableInfo } from '../src/index.js'
import { engines, setupEngine, skip } from './fixtures.js'

/**
 * Generated (computed, virtual) columns, written as GENERATED ALWAYS AS … since wave 6: a model read from the
 * database compares equal to it, a changed expression is found, and the migration for it runs on each database
 * (dropped and added again: most can't change an expression in place) and leaves the two equal again.
 */
const svc = new DatabaseService()
afterAll(() => svc.disconnectAll())
const ORACLE: ConnectionConfig = { id: 'ora-gen', name: 'ora', driver: 'oracle', host: '127.0.0.1', port: 15219, user: 'shop', password: 'mastermind', database: 'FREEPDB1' }

const SETUP: Partial<Record<DriverId, { drop: string; create: string; changed: string }>> = {
  postgres: { drop: 'DROP TABLE IF EXISTS gen_t', create: 'CREATE TABLE gen_t (id int PRIMARY KEY, price int, total int GENERATED ALWAYS AS (price * 2) STORED)', changed: 'price * 3' },
  mysql: { drop: 'DROP TABLE IF EXISTS gen_t', create: 'CREATE TABLE gen_t (id int PRIMARY KEY, price int, total int GENERATED ALWAYS AS (price * 2) VIRTUAL, kept int AS (price + 1) STORED)', changed: '`price` * 3' },
  mssql: { drop: 'DROP TABLE IF EXISTS dbo.gen_t', create: 'CREATE TABLE dbo.gen_t (id int PRIMARY KEY, price int, total AS ([price] * 2), kept AS ([price] + 1) PERSISTED)', changed: '[price] * 3' },
  oracle: { drop: "BEGIN EXECUTE IMMEDIATE 'DROP TABLE gen_t'; EXCEPTION WHEN OTHERS THEN NULL; END;", create: 'CREATE TABLE gen_t (id NUMBER(10) PRIMARY KEY, price NUMBER(10), total NUMBER GENERATED ALWAYS AS (price * 2) VIRTUAL)', changed: '"PRICE"*3' },
}
SETUP.mariadb = SETUP.mysql

for (const driver of ['postgres', 'mysql', 'mariadb', 'mssql', 'oracle'] as DriverId[]) {
  describe.skipIf(skip.has(driver))(`generated columns on ${driver}`, () => {
    it('a model read from the database is the same; a changed expression is found and migrated', { timeout: 120_000 }, async () => {
      let id: string
      if (driver === 'oracle') {
        await svc.connect(ORACLE)
        id = ORACLE.id
      } else id = (await setupEngine(svc, engines.find((e) => e.id === driver)!)).id
      const run = async (sql: string) => (await svc.runScript(id, sql, { readOnly: false })).filter((o) => o.error).map((o) => `${o.error!.message} | ${o.sql.slice(0, 200)}`)
      const s = SETUP[driver]!
      await run(s.drop)
      expect(await run(s.create)).toEqual([])
      const read = async () => (await svc.schema(id, true)).tables.filter((t) => /^gen_t$/i.test(t.name) && t.type === 'table')
      const live = await read()
      expect(live.length).toBe(1)
      const total = live[0]!.columns.find((c) => /^total$/i.test(c.name))!
      expect(total.isGenerated, 'read as generated').toBe(true)
      // The model as read: no difference.
      const model: TableInfo[] = structuredClone(live)
      expect(compareSchemas(model, live, { driver }).map((c) => c.kind)).toEqual([])
      // The expression changed in the model: found, and the migration runs.
      const changedModel: TableInfo[] = structuredClone(live)
      changedModel[0]!.columns.find((c) => /^total$/i.test(c.name))!.defaultValue = s.changed
      const changes = compareSchemas(changedModel, live, { driver })
      expect(changes.map((c) => c.kind)).toEqual(['alter_column'])
      const migration = generateMigration(changes, getDialect(driver), live)
      const script = migrationScript(migration, getDialect(driver))
      expect(script).not.toMatch(/Left out/)
      expect(await run(script), script).toEqual([])
      const after = await read()
      expect(after[0]!.columns.find((c) => /^total$/i.test(c.name))!.isGenerated).toBe(true)
      expect(compareSchemas(changedModel, after, { driver }).map((c) => `${c.kind} ${'column' in c ? String(c.column) : ''}`), script).toEqual([])
      await run(s.drop)
    })
  })
}

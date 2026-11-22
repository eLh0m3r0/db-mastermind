import { afterAll, describe, expect, it } from 'vitest'
import { agentDatabase, DatabaseService, DB_TOOLS, type ToolContext } from '../src/index.js'
import { engines, setupEngine, skip } from './fixtures.js'

/**
 * Wave 10: a view backed by a function that writes, read through the agent tools on a WRITABLE connection
 * (sample_rows, describe_table, explain_query, run_query): nothing is written, and a schema-only context gets no
 * rows. (SQL Server functions can't write by design: there the view is plain, and explain_query must plan without
 * running anything.)
 */
const svc = new DatabaseService()
afterAll(() => svc.disconnectAll())
const config = (id: string) => engines.find((e) => e.id === id)!
const exec = async (id: string, sql: string) => {
  const outcomes = await svc.runScript(id, sql, { readOnly: false })
  const failed = outcomes.find((o) => o.error)
  if (failed) throw new Error(`${sql}: ${failed.error!.message}`)
  return outcomes.at(-1)?.results?.[0]?.rows ?? []
}

const SETUP: Record<string, { drop: string[]; create: string[]; view: string; log: string }> = {
  postgres: {
    drop: ['DROP VIEW IF EXISTS dbm_wv', 'DROP FUNCTION IF EXISTS dbm_w()', 'DROP TABLE IF EXISTS dbm_wlog'],
    create: ['CREATE TABLE dbm_wlog (n int)', 'CREATE FUNCTION dbm_w() RETURNS int LANGUAGE plpgsql AS $$ BEGIN INSERT INTO dbm_wlog VALUES (1); RETURN 1; END $$', 'CREATE VIEW dbm_wv AS SELECT dbm_w() AS x'],
    view: 'dbm_wv',
    log: 'dbm_wlog',
  },
  mysql: {
    drop: ['DROP VIEW IF EXISTS dbm_wv', 'DROP FUNCTION IF EXISTS dbm_w', 'DROP TABLE IF EXISTS dbm_wlog'],
    create: ['SET GLOBAL log_bin_trust_function_creators = 1', 'CREATE TABLE dbm_wlog (n int)', 'DELIMITER $$\nCREATE FUNCTION dbm_w() RETURNS int MODIFIES SQL DATA BEGIN INSERT INTO dbm_wlog VALUES (1); RETURN 1; END$$\nDELIMITER ;', 'CREATE VIEW dbm_wv AS SELECT dbm_w() AS x'],
    view: 'dbm_wv',
    log: 'dbm_wlog',
  },
  mssql: {
    drop: ['DROP VIEW IF EXISTS dbo.dbm_wv', 'DROP TABLE IF EXISTS dbo.dbm_wlog'],
    create: ['CREATE TABLE dbo.dbm_wlog (n int)', 'CREATE VIEW dbo.dbm_wv AS SELECT 1 AS x'],
    view: 'dbm_wv',
    log: 'dbo.dbm_wlog',
  },
}
SETUP.mariadb = SETUP.mysql!

for (const driver of ['postgres', 'mysql', 'mariadb', 'mssql'] as const) {
  describe.skipIf(skip.has(driver))(`agent tools on ${driver}, a writable connection`, () => {
    it('a view whose function writes is read through every tool and nothing is written; schema only gets no rows', { timeout: 120_000 }, async () => {
      const base = await setupEngine(svc, config(driver))
      const s = SETUP[driver]!
      for (const sql of s.drop) await exec(base.id, sql).catch(() => {})
      for (const sql of s.create) await exec(base.id, sql)
      const tool = (name: string) => DB_TOOLS.find((t) => t.name === name)!
      for (const allowData of [true, false]) {
        // (A context that would let writes through after confirmation: the reads must not need it.)
        const ctx: ToolContext = { db: agentDatabase(svc, { allowData }), connectionId: base.id, allowData, confirmWrite: async () => false }
        const answers = {
          sample: await tool('sample_rows').run(ctx, { table: s.view }).catch((e: Error) => `THROWN ${e.message}`),
          describe: await tool('describe_table').run(ctx, { table: s.view }).catch((e: Error) => `THROWN ${e.message}`),
          explain: await tool('explain_query').run(ctx, { sql: `SELECT * FROM ${s.view}` }),
          query: await tool('run_query').run(ctx, { sql: `SELECT * FROM ${s.view}` }),
        }
        // Nothing was written by any of them.
        expect(Number((await exec(base.id, `SELECT count(*) FROM ${s.log}`))[0]![0]), JSON.stringify(answers)).toBe(0)
        if (!allowData) {
          expect(answers.sample).toMatch(/only shares the schema/)
          expect(answers.query).toMatch(/only shares the schema/)
        }
        // An agent's explain is a plan only, of a read only.
        expect(await tool('explain_query').run(ctx, { sql: `EXPLAIN ANALYZE SELECT * FROM ${s.view}` })).toMatch(/ERROR/)
        expect(await tool('explain_query').run(ctx, { sql: `DELETE FROM ${s.log}` })).toMatch(/ERROR/)
      }
      for (const sql of s.drop) await exec(base.id, sql).catch(() => {})
    })
  })
}

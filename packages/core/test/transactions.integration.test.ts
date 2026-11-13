import { afterAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { DatabaseService, DB_TOOLS, listActivity, whoBlocks, type ConnectionConfig, type DriverId } from '../src/index.js'
import { engines, skip, tmp } from './fixtures.js'

/**
 * The SQL editor's transactions: the state each database reports (not what the SQL text suggests), manual commit
 * (a change opens a transaction that waits for Commit / Roll back) and what each engine does on its own (implicit
 * commits, failed transactions). Requires `npm run db:up`.
 */

const svc = new DatabaseService()
afterAll(() => svc.disconnectAll())

interface Case {
  engine: DriverId
  config: ConnectionConfig
  /** Another connection can't see uncommitted rows (SQLite has only one). */
  isolated: boolean
  drop: string
  create: string
  /** Counts committed rows without waiting for another session's locks. */
  count: string
  /** DDL commits an open transaction. */
  implicitCommit?: boolean
}

const fixture = (id: DriverId) => engines.find((e) => e.id === id)!.config
const oracle: ConnectionConfig = { id: 'ora-tx', name: 'ora', driver: 'oracle', host: '127.0.0.1', port: 15219, user: 'shop', password: 'mastermind', database: 'FREEPDB1' }

const cases: Case[] = [
  { engine: 'postgres', config: fixture('postgres'), isolated: true, drop: 'DROP TABLE IF EXISTS tx_t', create: 'CREATE TABLE tx_t (v int)', count: 'SELECT count(*) FROM tx_t' },
  ...(['mysql', 'mariadb'] as const).map((engine) => ({
    engine,
    config: fixture(engine),
    isolated: true,
    drop: 'DROP TABLE IF EXISTS tx_t',
    create: 'CREATE TABLE tx_t (v int) ENGINE=InnoDB',
    count: 'SELECT count(*) FROM tx_t',
    implicitCommit: true,
  })),
  {
    engine: 'mssql',
    config: fixture('mssql'),
    isolated: true,
    drop: "IF OBJECT_ID('dbo.tx_t') IS NOT NULL DROP TABLE dbo.tx_t",
    create: 'CREATE TABLE dbo.tx_t (v int)',
    // Plain READ COMMITTED would wait for the other session's row locks.
    count: 'SELECT count(*) FROM dbo.tx_t WITH (READPAST)',
  },
  {
    engine: 'oracle',
    config: oracle,
    isolated: true,
    drop: "BEGIN EXECUTE IMMEDIATE 'DROP TABLE tx_t'; EXCEPTION WHEN OTHERS THEN NULL; END;",
    create: 'CREATE TABLE tx_t (v NUMBER)',
    count: 'SELECT count(*) FROM tx_t',
    implicitCommit: true,
  },
  { engine: 'duckdb', config: { ...fixture('duckdb'), id: 'duck-tx', filePath: join(tmp, 'tx.duckdb') }, isolated: true, drop: 'DROP TABLE IF EXISTS tx_t', create: 'CREATE TABLE tx_t (v int)', count: 'SELECT count(*) FROM tx_t' },
  { engine: 'sqlite', config: { ...fixture('sqlite'), id: 'lite-tx', filePath: join(tmp, 'tx.db') }, isolated: false, drop: 'DROP TABLE IF EXISTS tx_t', create: 'CREATE TABLE tx_t (v int)', count: 'SELECT count(*) FROM tx_t' },
]

const insert = (c: Case, v: number) => `INSERT INTO ${c.engine === 'mssql' ? 'dbo.' : ''}tx_t (v) VALUES (${v})`

async function ok(id: string, sql: string, session?: string) {
  const outcomes = await svc.runScript(id, sql, session ? { session, editor: true } : {})
  const failed = outcomes.find((o) => o.error)
  if (failed) throw new Error(failed.error!.message)
  return outcomes
}
async function count(c: Case, id: string): Promise<number> {
  const [o] = await ok(id, c.count)
  return Number(o!.results![0]!.rows[0]![0])
}

for (const c of cases) {
  describe.skipIf(skip.has(c.engine))(`transactions: ${c.engine}`, () => {
    const id = c.config.id
    // Same database, manual commit (file databases: one instance per file, so the same connection is reconfigured).
    const manual: ConnectionConfig = { ...c.config, manualCommit: true }

    it('reports BEGIN / COMMIT as the database sees them on an automatic connection', async () => {
      await svc.connect(c.config)
      await ok(id, c.drop)
      await ok(id, c.create)
      const tab = 'auto-tab'
      await ok(id, insert(c, 1), tab)
      expect(await svc.transactionState(id, tab)).toBe('none')
      expect(await count(c, id)).toBe(1)
      await ok(id, svc.driver(id).dialect.begin, tab)
      await ok(id, insert(c, 2), tab)
      expect(await svc.transactionState(id, tab)).toBe('open')
      if (c.isolated) expect(await count(c, id)).toBe(1)
      expect(await svc.endTransaction(id, tab, 'commit')).toBe('none')
      expect(await count(c, id)).toBe(2)
      await svc.releaseSession(id, tab)
    })

    it('with manual commit, a change waits for Commit or Roll back; reads open nothing', async () => {
      await svc.disconnect(id)
      await svc.connect(manual)
      const tab = 'manual-tab'
      await ok(id, c.count, tab)
      expect(await svc.transactionState(id, tab)).toBe('none')
      await ok(id, insert(c, 3), tab)
      expect(await svc.transactionState(id, tab)).toBe('open')
      if (c.isolated) expect(await count(c, id)).toBe(2)
      expect(await svc.endTransaction(id, tab, 'rollback')).toBe('none')
      expect(await count(c, id)).toBe(2)
      // A script: one transaction for all of it.
      await ok(id, `${insert(c, 4)};\n${insert(c, 5)}`, tab)
      expect(await svc.transactionState(id, tab)).toBe('open')
      expect(await svc.endTransaction(id, tab, 'commit')).toBe('none')
      expect(await count(c, id)).toBe(4)
      // Closing the tab rolls back what it left open.
      await ok(id, insert(c, 6), tab)
      await svc.releaseSession(id, tab)
      expect(await count(c, id)).toBe(4)
    })

    it('with manual commit, grid saves wait in the table tab’s transaction; a failed save drops only itself', async () => {
      const ora = c.engine === 'oracle'
      const t = c.engine === 'mssql' ? 'dbo.tx_grid' : 'tx_grid'
      await ok(id, c.engine === 'mssql' ? "IF OBJECT_ID('dbo.tx_grid') IS NOT NULL DROP TABLE dbo.tx_grid" : ora ? "BEGIN EXECUTE IMMEDIATE 'DROP TABLE tx_grid'; EXCEPTION WHEN OTHERS THEN NULL; END;" : 'DROP TABLE IF EXISTS tx_grid')
      await ok(id, `CREATE TABLE ${t} (id int PRIMARY KEY, v int)`)
      const ref = c.engine === 'mssql' ? { schema: 'dbo', name: 'tx_grid' } : { name: ora ? 'TX_GRID' : 'tx_grid' }
      const row = (n: string) => ({ type: 'insert' as const, values: { [ora ? 'ID' : 'id']: n, [ora ? 'V' : 'v']: n } })
      const tab = 'table-tab'
      const rows = async (session?: string) => (await svc.fetchTable(id, { table: ref, limit: 100, session })).result.rows.length
      await svc.applyChanges(id, ref, [row('1')], { session: tab })
      expect(await svc.transactionState(id, tab)).toBe('open')
      expect(await rows(tab)).toBe(1)
      // (SQL Server's READ COMMITTED would wait for the tab's uncommitted row: its count skips locked rows.)
      if (c.isolated) expect(c.engine === 'mssql' ? Number((await ok(id, 'SELECT count(*) FROM dbo.tx_grid WITH (READPAST)'))[0]!.results![0]!.rows[0]![0]) : await rows()).toBe(0)
      // A duplicate key fails: that save is undone, the first row stays in the transaction (DuckDB aborts it all).
      await expect(svc.applyChanges(id, ref, [row('2'), row('1')], { session: tab })).rejects.toThrow()
      if (c.engine === 'duckdb') {
        expect(await svc.transactionState(id, tab)).toBe('failed')
        await svc.endTransaction(id, tab, 'rollback')
        await svc.applyChanges(id, ref, [row('1')], { session: tab })
      } else {
        expect(await svc.transactionState(id, tab)).toBe('open')
        expect(await rows(tab)).toBe(1)
      }
      expect(await svc.endTransaction(id, tab, 'commit')).toBe('none')
      expect(await rows()).toBe(1)
      await svc.releaseSession(id, tab)
    })

    if (c.implicitCommit) {
      it('says when DDL committed the open transaction', async () => {
        const tab = 'ddl-tab'
        await ok(id, insert(c, 7), tab)
        expect(await svc.transactionState(id, tab)).toBe('open')
        const create = c.engine === 'oracle' ? 'CREATE TABLE tx_ddl (v NUMBER)' : 'CREATE TABLE tx_ddl (v int)'
        await ok(id, c.engine === 'oracle' ? "BEGIN EXECUTE IMMEDIATE 'DROP TABLE tx_ddl'; EXCEPTION WHEN OTHERS THEN NULL; END;" : 'DROP TABLE IF EXISTS tx_ddl')
        const [o] = await ok(id, create, tab)
        expect(o!.note).toMatch(/committed the open transaction/)
        expect(await svc.transactionState(id, tab)).toBe('none')
        expect(await count(c, id)).toBe(5)
        await svc.releaseSession(id, tab)
      })
    }

    // DuckDB and SQLite don't wait for row locks.
    if (['postgres', 'mysql', 'mariadb', 'mssql', 'oracle'].includes(c.engine)) {
      it("a grid save doesn't hang on a row a query tab locked", async () => {
        const t = c.engine === 'mssql' ? 'dbo.tx_lock' : 'tx_lock'
        await ok(id, c.engine === 'mssql' ? "IF OBJECT_ID('dbo.tx_lock') IS NOT NULL DROP TABLE dbo.tx_lock" : 'DROP TABLE IF EXISTS tx_lock')
        await ok(id, `CREATE TABLE ${t} (id int PRIMARY KEY, v int)`)
        await ok(id, `INSERT INTO ${t} (id, v) VALUES (1, 1)`)
        const tab = 'lock-tab'
        await ok(id, `UPDATE ${t} SET v = 2 WHERE id = 1`, tab)
        // (Oracle folds unquoted names to upper case.)
        const ora = c.engine === 'oracle'
        const ref = c.engine === 'mssql' ? { schema: 'dbo', name: 'tx_lock' } : { name: ora ? 'TX_LOCK' : 'tx_lock' }
        const change = (v: string) => [{ type: 'update' as const, key: { [ora ? 'ID' : 'id']: '1' }, values: { [ora ? 'V' : 'v']: v } }]
        const started = Date.now()
        await expect(svc.applyChanges(id, ref, change('3'))).rejects.toMatchObject({ code: 'ROW_LOCKED', message: expect.stringMatching(/query tab/) })
        expect(Date.now() - started).toBeLessThan(15000)
        await svc.endTransaction(id, tab, 'commit')
        // The pool's connections wait as usual again (the timeout was set back), and the save goes through now.
        await svc.applyChanges(id, ref, change('4'))
        const [o] = await ok(id, `SELECT v FROM ${t} WHERE id = 1`)
        expect(Number(o!.results![0]!.rows[0]![0])).toBe(4)
        await svc.releaseSession(id, tab)
      }, 30000)

      // (Oracle's v$session needs privileges the test user doesn't have.)
      it.skipIf(c.engine === 'oracle')('tells which tab a waiting query waits for', async () => {
        const t = c.engine === 'mssql' ? 'dbo.tx_lock' : 'tx_lock'
        await ok(id, `UPDATE ${t} SET v = 5 WHERE id = 1`, 'holder-tab')
        await ok(id, 'SELECT 1', 'waiter-tab')
        const waiting = svc.runScript(id, `UPDATE ${t} SET v = 6 WHERE id = 1`, { session: 'waiter-tab', editor: true })
        await new Promise((r) => setTimeout(r, 1500))
        const blocked = await whoBlocks(svc, id, 'waiter-tab')
        expect(blocked.sessions).toEqual(['holder-tab'])
        await svc.endTransaction(id, 'holder-tab', 'rollback')
        const [o] = await waiting
        expect(o!.error).toBeUndefined()
        await svc.endTransaction(id, 'waiter-tab', 'rollback')
        // InnoDB's lock tables lag up to 0.1 s.
        await new Promise((r) => setTimeout(r, 300))
        expect(await whoBlocks(svc, id, 'waiter-tab')).toEqual({ ids: [], sessions: [] })
        await svc.releaseSession(id, 'holder-tab')
        await svc.releaseSession(id, 'waiter-tab')
      }, 30000)
    }

    // Oracle's v$ views need privileges the test user doesn't have.
    if (!['duckdb', 'sqlite', 'oracle'].includes(c.engine)) {
      it('server activity names the tab of a session and shows it idle in a transaction', async () => {
        const tab = 'activity-tab'
        await ok(id, insert(c, 20), tab)
        await new Promise((r) => setTimeout(r, 300))
        const sessions = await listActivity(svc, id)
        const mine = sessions.find((s) => s.session === tab)
        expect(mine, JSON.stringify(sessions.map((s) => [s.id, s.state]))).toBeTruthy()
        expect(mine!.idleInTransaction).toBe(true)
        await svc.endTransaction(id, tab, 'rollback')
        // InnoDB refreshes INNODB_TRX at most every 0.1 s.
        await new Promise((r) => setTimeout(r, 300))
        const after = (await listActivity(svc, id)).find((s) => s.session === tab)
        expect(after?.idleInTransaction).toBeFalsy()
        await svc.releaseSession(id, tab)
      })
    }

    if (c.engine === 'postgres' || c.engine === 'duckdb') {
      it('an error leaves a failed transaction that only Roll back ends', async () => {
        const tab = 'failed-tab'
        await ok(id, insert(c, 8), tab)
        const outcomes = await svc.runScript(id, 'SELECT no_such_column FROM tx_t', { session: tab, editor: true })
        expect(outcomes[0]!.error).toBeTruthy()
        // A binder error doesn't abort a DuckDB transaction; a failed statement that ran does.
        if (c.engine === 'duckdb') await svc.runScript(id, `INSERT INTO tx_t (v) VALUES ('x')`, { session: tab, editor: true })
        expect(await svc.transactionState(id, tab)).toBe('failed')
        expect(await svc.endTransaction(id, tab, 'rollback')).toBe('none')
        await ok(id, 'SELECT 1', tab)
        await svc.releaseSession(id, tab)
      })
    }

    if (c.engine === 'postgres') {
      it("the assistant's confirmed writes wait in the chat's transaction", async () => {
        const runQuery = DB_TOOLS.find((tool) => tool.name === 'run_query')!
        const session = 'ai-chat1'
        const ctx = { db: svc, connectionId: id, allowData: true, confirmWrite: async () => true, writeSession: session }
        const answer = await runQuery.run(ctx, { sql: insert(c, 30) })
        expect(answer).toMatch(/open transaction/)
        expect(await svc.transactionState(id, session)).toBe('open')
        expect(await count(c, id)).toBe(4)
        expect(await svc.endTransaction(id, session, 'rollback')).toBe('none')
        expect(await count(c, id)).toBe(4)
        // Reads still run on their own, read-only.
        expect(await runQuery.run(ctx, { sql: c.count })).toMatch(/4/)
        await svc.releaseSession(id, session)
      })

      it('runs statements that refuse a transaction block outside one', async () => {
        const tab = 'vacuum-tab'
        await ok(id, 'VACUUM tx_t', tab)
        expect(await svc.transactionState(id, tab)).toBe('none')
        await svc.releaseSession(id, tab)
      })
    }

    if (c.engine === 'mssql') {
      it('follows XACT_ABORT rollbacks and batches with their own BEGIN TRAN', async () => {
        const tab = 'xact-tab'
        await ok(id, 'SET XACT_ABORT ON', tab)
        await ok(id, insert(c, 9), tab)
        expect(await svc.transactionState(id, tab)).toBe('open')
        await svc.runScript(id, 'SELECT 1/0', { session: tab, editor: true })
        expect(await svc.transactionState(id, tab)).toBe('none')
        // Not mistaken for a lost connection.
        await ok(id, 'SELECT 1', tab)
        await ok(id, `BEGIN TRAN; ${insert(c, 10)}; COMMIT`, tab)
        expect(await svc.transactionState(id, tab)).toBe('none')
        await svc.releaseSession(id, tab)
      })
    }

    if (c.engine === 'sqlite') {
      it("another tab can't write into the transaction a tab opened (one connection)", async () => {
        await ok(id, insert(c, 11), 'tab-a')
        expect(await svc.transactionState(id, 'tab-a')).toBe('open')
        expect(await svc.transactionState(id, 'tab-b')).toBe('none')
        await expect(ok(id, insert(c, 12), 'tab-b')).rejects.toThrow(/open transaction/)
        await expect(ok(id, 'COMMIT', 'tab-b')).rejects.toThrow(/open transaction/)
        await expect(svc.applyChanges(id, { name: 'tx_t' }, [{ type: 'insert', values: { v: 13 } }])).rejects.toThrow(/open transaction/)
        // Reading is fine.
        await ok(id, c.count, 'tab-b')
        expect(await svc.endTransaction(id, 'tab-a', 'commit')).toBe('none')
        await ok(id, insert(c, 12), 'tab-b')
        await svc.releaseSession(id, 'tab-b')
      })
    }
  })
}

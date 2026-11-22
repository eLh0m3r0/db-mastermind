import { execFileSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseService, type ConnectionConfig } from '../src/index.js'
import { engines, setupEngine, skip } from './fixtures.js'

/**
 * Review round 3 on the real servers: MariaDB's /*M! … *\/ can't write a file, SQL Server batches are planned whole
 * (also for a login without SHOWPLAN permission), the user's own SQL on a read-only connection keeps its harmless
 * session statements, and a guarded run leaves no lock or setting behind on a pooled session.
 */
const svc = new DatabaseService()
afterAll(() => svc.disconnectAll())
const config = (id: string) => engines.find((e) => e.id === id)!
const exec = async (id: string, sql: string, options = {}) => {
  const [o] = await svc.runScript(id, sql, { readOnly: false, ...options })
  if (o?.error) throw new Error(`${sql}: ${o.error.message}`)
  return (o?.results?.[0]?.rows ?? []) as unknown[][]
}
const container = (name: string) => execFileSync('docker', ['ps', '--filter', `name=${name}`, '--format', '{{.Names}}'], { encoding: 'utf8' }).trim().split('\n')[0]

for (const driver of ['mysql', 'mariadb'] as const) {
  describe.skipIf(skip.has(driver))(`${driver}: executable comments and files`, () => {
    it('/*M! … */ and /*! … */ write no file, for SQL nobody confirmed and on a read-only connection', async () => {
      const base = await setupEngine(svc, config(driver))
      const readOnly: ConnectionConfig = { ...base, id: `${base.id}-ro3`, readOnly: true }
      await svc.connect(readOnly)
      const dir = driver === 'mysql' ? '/var/lib/mysql-files' : '/tmp'
      for (const sql of [`SELECT 'x' /*M! INTO OUTFILE '${dir}/dbm_r3_a' */`, `SELECT 'x' /*M!100000 INTO OUTFILE '${dir}/dbm_r3_b' */`, `SELECT 'x' /*! INTO OUTFILE '${dir}/dbm_r3_c' */`, `SELECT 'x' INTO OUTFILE '${dir}/dbm_r3_d'`]) {
        await expect(svc.runScript(base.id, sql, { readOnly: true }), sql).rejects.toThrow(/read-only|OUTFILE/)
        const [outcome] = await svc.runScript(readOnly.id, sql)
        expect(outcome?.error?.message, sql).toMatch(/This connection is read-only/)
      }
      const files = execFileSync('docker', ['exec', container(`db-mastermind-${driver}-1`)!, 'ls', dir], { encoding: 'utf8' })
      expect(files).not.toMatch(/dbm_r3_/)
    })

    it('a named lock taken through a function is gone after the run, and a time limit is set', async () => {
      const base = await setupEngine(svc, config(driver))
      await exec(base.id, 'DROP FUNCTION IF EXISTS dbm_lock')
      await exec(base.id, "CREATE FUNCTION dbm_lock() RETURNS int DETERMINISTIC RETURN GET_LOCK('dbm_r3_lock', 0)")
      const outcomes = await svc.runScript(base.id, 'SELECT dbm_lock()', { readOnly: true })
      expect(outcomes[0]?.error).toBeUndefined()
      expect(Number((await exec(base.id, "SELECT IS_FREE_LOCK('dbm_r3_lock')"))[0]![0])).toBe(1)
      const [limit] = await svc.runScript(base.id, driver === 'mysql' ? 'SELECT @@SESSION.max_execution_time' : 'SELECT @@SESSION.max_statement_time', { readOnly: true })
      expect(Number(limit!.results![0]!.rows[0]![0])).toBe(driver === 'mysql' ? 60000 : 60)
      await exec(base.id, 'DROP FUNCTION IF EXISTS dbm_lock')
    })

    it("the user's own SQL on a read-only connection: USE, SET @var, SELECT … INTO @var; never sql_mode", async () => {
      const base = await setupEngine(svc, config(driver))
      const readOnly: ConnectionConfig = { ...base, id: `${base.id}-ro3u`, readOnly: true }
      await svc.connect(readOnly)
      const tab = { session: 'tab-r3' }
      const ok = await svc.runScript(readOnly.id, 'USE mastermind; SET @n = 0; SELECT count(*) INTO @n FROM customers; SELECT @n', tab)
      expect(ok.filter((o) => o.error).map((o) => o.error!.message)).toEqual([])
      expect(Number(ok.at(-1)!.results![0]!.rows[0]![0])).toBeGreaterThan(0)
      const [refused] = await svc.runScript(readOnly.id, "SET sql_mode = 'ANSI_QUOTES'", tab)
      expect(refused!.error?.message).toMatch(/This connection is read-only/)
      await svc.releaseSession(readOnly.id, tab.session)
    })
  })
}

describe.skipIf(skip.has('postgres'))('postgres: what a guarded run leaves behind, and the user profile', () => {
  it('an advisory lock taken through a function is released, and a time limit is set', async () => {
    const base = await setupEngine(svc, config('postgres'))
    await exec(base.id, 'CREATE OR REPLACE FUNCTION dbm_lock() RETURNS void LANGUAGE sql AS $$ SELECT pg_advisory_lock(4242) $$')
    const outcomes = await svc.runScript(base.id, 'SELECT dbm_lock()', { readOnly: true })
    expect(outcomes[0]?.error).toBeUndefined()
    expect(Number((await exec(base.id, "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = 4242"))[0]![0])).toBe(0)
    const [limit] = await svc.runScript(base.id, 'SHOW statement_timeout', { readOnly: true })
    expect(limit!.results![0]!.rows[0]![0]).toBe('1min')
    await exec(base.id, 'DROP FUNCTION dbm_lock()')
  })

  it("the user's own SET lasts on the tab; nothing that weakens the guard is taken", async () => {
    const base = await setupEngine(svc, config('postgres'))
    const readOnly: ConnectionConfig = { ...base, id: `${base.id}-ro3`, readOnly: true }
    await svc.connect(readOnly)
    const tab = { session: 'tab-r3' }
    expect((await svc.runScript(readOnly.id, 'SET search_path TO shop', tab))[0]!.error).toBeUndefined()
    const [count] = await svc.runScript(readOnly.id, 'SELECT count(*) FROM customers', tab)
    expect(count!.error).toBeUndefined()
    for (const sql of ['SET default_transaction_read_only = off', 'SET ROLE postgres', 'RESET ALL', 'SET SESSION AUTHORIZATION postgres']) {
      const [o] = await svc.runScript(readOnly.id, sql, tab)
      expect(o!.error?.message, sql).toMatch(/This connection is read-only/)
    }
    const [still] = await svc.runScript(readOnly.id, 'SHOW default_transaction_read_only', tab)
    expect(still!.results![0]!.rows[0]![0]).toBe('on')
    await svc.releaseSession(readOnly.id, tab.session)
  })
})

describe.skipIf(skip.has('mssql'))('mssql: batches planned whole, a least-privilege login, the user profile', () => {
  it('a batch with variables runs, as SQL Server runs it', async () => {
    const base = await setupEngine(svc, config('mssql'))
    const [o] = await svc.runScript(base.id, 'DECLARE @x int; SET @x = 41; SELECT @x + 1', { readOnly: true })
    expect(o!.error).toBeUndefined()
    expect(Number(o!.results!.at(-1)!.rows[0]![0])).toBe(42)
  })

  it('a login with db_datareader only (no SHOWPLAN) can read, and only plain batches', async () => {
    const base = await setupEngine(svc, config('mssql'))
    // (A name of its own, made again each run: a user of the same name from elsewhere would have another SID.)
    for (const sql of [
      "USE mastermind; IF USER_ID('dbm_r3_reader') IS NOT NULL DROP USER dbm_r3_reader",
      "IF SUSER_ID('dbm_r3_reader') IS NOT NULL DROP LOGIN dbm_r3_reader",
      "CREATE LOGIN dbm_r3_reader WITH PASSWORD = 'Reader-12345!', CHECK_POLICY = OFF",
      'USE mastermind; CREATE USER dbm_r3_reader FOR LOGIN dbm_r3_reader; ALTER ROLE db_datareader ADD MEMBER dbm_r3_reader',
    ]) await exec(base.id, sql)
    const reader: ConnectionConfig = { ...base, id: 'ms-reader', user: 'dbm_r3_reader', password: 'Reader-12345!', database: 'mastermind' }
    await svc.connect(reader)
    const [read] = await svc.runScript(reader.id, 'SELECT count(*) FROM shop.customers', { readOnly: true }).catch((err: Error) => [{ error: { message: err.message } } as never])
    expect(read!.error).toBeUndefined()
    // (A batch that touches no table plans without the permission; one that reads a table needs it.)
    await expect(svc.runScript(reader.id, 'SELECT count(*) FROM shop.customers /* a note */', { readOnly: true })).rejects.toThrow(/SHOWPLAN permission/)
  })

  it("the user's own batches on a read-only connection: SET options, USE, #temp tables; no other writes", async () => {
    const base = await setupEngine(svc, config('mssql'))
    const readOnly: ConnectionConfig = { ...base, id: `${base.id}-ro3`, readOnly: true }
    await svc.connect(readOnly)
    for (const sql of ['SET NOCOUNT ON; SELECT 1', 'USE mastermind; SELECT 1', 'SELECT id INTO #t FROM shop.customers; SELECT count(*) FROM #t']) {
      const outcomes = await svc.runScript(readOnly.id, sql)
      expect(outcomes.filter((o) => o.error).map((o) => o.error!.message), sql).toEqual([])
    }
    for (const sql of ["INSERT INTO shop.customers (name, email) VALUES ('x', 'x@x')", 'SELECT * INTO shop.copy FROM shop.customers', 'SET IMPLICIT_TRANSACTIONS ON']) {
      const [o] = await svc.runScript(readOnly.id, sql)
      expect(o!.error?.message, sql).toMatch(/This connection is read-only/)
    }
  })

  it('how long a guarded SELECT 1 takes (20 in a row)', async () => {
    const base = await setupEngine(svc, config('mssql'))
    let start = performance.now()
    for (let i = 0; i < 20; i++) await svc.runScript(base.id, 'SELECT 1', { readOnly: false })
    const plain = performance.now() - start
    start = performance.now()
    for (let i = 0; i < 20; i++) await svc.runScript(base.id, 'SELECT 1', { readOnly: true })
    const guarded = performance.now() - start
    console.log(`SQL Server: 20 SELECT 1 plain ${Math.round(plain)} ms, guarded ${Math.round(guarded)} ms`)
    expect(guarded).toBeLessThan(plain * 20 + 2000)
  })
})

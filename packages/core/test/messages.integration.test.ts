import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseService, type ConnectionConfig } from '../src/index.js'
import { engines, skip } from './fixtures.js'

/**
 * What the server says besides results reaches the statement's outcome (Messages): SQL Server PRINT, MySQL /
 * MariaDB warnings, Oracle DBMS_OUTPUT (PostgreSQL's NOTICE: postgres-sessions.integration.test.ts).
 * Requires `npm run db:up`.
 */
const svc = new DatabaseService()
afterAll(() => svc.disconnectAll())
const config = (id: string) => engines.find((e) => e.id === id)!.config
const oracle: ConnectionConfig = { id: 'ora-msg', name: 'ora', driver: 'oracle', host: '127.0.0.1', port: 15219, user: 'shop', password: 'mastermind', database: 'FREEPDB1' }

describe.skipIf(skip.has('mssql'))('SQL Server PRINT', () => {
  it('a batch that only prints, one that prints and selects, one that prints and fails', async () => {
    const c = { ...config('mssql'), id: 'ms-msg' }
    await svc.connect(c)
    const [only] = await svc.runScript(c.id, "PRINT 'hello'; PRINT 'world'", { session: 't' })
    expect(only?.messages).toEqual(['hello', 'world'])
    expect(only?.results).toEqual([])
    const [both] = await svc.runScript(c.id, "PRINT 'before'; SELECT 1 AS one", { session: 't' })
    expect(both?.messages).toEqual(['before'])
    expect(both?.results?.[0]?.rows).toEqual([[1]])
    const [failed] = await svc.runScript(c.id, "PRINT 'about to fail'; RAISERROR('boom', 16, 1)", { session: 't' })
    expect(failed?.error?.message).toMatch(/boom/)
    expect(failed?.messages).toEqual(['about to fail'])
    const [quiet] = await svc.runScript(c.id, 'SELECT 1')
    expect(quiet?.messages).toBeUndefined()
    await svc.releaseSession(c.id, 't')
  })
})

for (const id of ['mysql', 'mariadb']) {
  describe.skipIf(skip.has(id))(`${id} warnings`, () => {
    it('INSERT IGNORE of an out-of-range value says why', async () => {
      const c = { ...config(id), id: `${id}-msg` }
      await svc.connect(c)
      const out = await svc.runScript(c.id, 'CREATE TEMPORARY TABLE dbm_w (x tinyint); INSERT IGNORE INTO dbm_w VALUES (1000); SELECT x FROM dbm_w', { session: 't' })
      expect(out[1]?.messages?.[0]).toMatch(/^WARNING 1264: Out of range value/)
      expect(out[2]?.messages).toBeUndefined()
      expect(out[2]?.results?.[0]?.rows).toEqual([[127]])
      await svc.releaseSession(c.id, 't')
    })
  })
}

describe.skipIf(skip.has('oracle') || skip.has('ora'))('Oracle DBMS_OUTPUT', () => {
  it('PUT_LINE in a tab shows in Messages, also before an error', async () => {
    await svc.connect(oracle)
    const [ok] = await svc.runScript(oracle.id, "BEGIN DBMS_OUTPUT.PUT_LINE('hello'); DBMS_OUTPUT.PUT_LINE('line 2'); END;", { session: 't' })
    expect(ok?.error).toBeUndefined()
    expect(ok?.messages).toEqual(['hello', 'line 2'])
    const [failed] = await svc.runScript(oracle.id, "BEGIN DBMS_OUTPUT.PUT_LINE('about to fail'); RAISE_APPLICATION_ERROR(-20001, 'boom'); END;", { session: 't' })
    expect(failed?.error?.message).toMatch(/boom/)
    expect(failed?.messages).toEqual(['about to fail'])
    const [quiet] = await svc.runScript(oracle.id, 'SELECT 1 FROM dual', { session: 't' })
    expect(quiet?.messages).toBeUndefined()
    await svc.releaseSession(oracle.id, 't')
  })
})

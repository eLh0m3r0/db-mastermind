import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseService, type ConnectionConfig } from '../src/index.js'
import { engines, skip } from './fixtures.js'

/**
 * The server drops a connection (restart, VPN, idle kill), killed here from a second connection. Without an open
 * transaction the app carries on as if nothing happened; with one, the next statement says the transaction is gone
 * (instead of silently continuing in autocommit), then the session works again. Nothing may crash the process.
 * Requires `npm run db:up`.
 */

interface Case {
  id: string
  config: ConnectionConfig
  admin: ConnectionConfig
  pid: string
  kill: (pid: string) => string
  begin: string
}

const config = (id: string) => engines.find((e) => e.id === id)!.config
const oracle: ConnectionConfig = { id: 'ora-loss', name: 'ora', driver: 'oracle', host: '127.0.0.1', port: 15219, user: 'shop', password: 'mastermind', database: 'FREEPDB1' }

const cases: Case[] = [
  {
    id: 'postgres',
    config: { ...config('postgres'), id: 'pg-loss' },
    admin: { ...config('postgres'), id: 'pg-admin' },
    pid: 'SELECT pg_backend_pid()',
    kill: (pid) => `SELECT pg_terminate_backend(${Number(pid)})`,
    begin: 'BEGIN',
  },
  {
    id: 'mysql',
    config: { ...config('mysql'), id: 'my-loss' },
    admin: { ...config('mysql'), id: 'my-admin' },
    pid: 'SELECT CONNECTION_ID()',
    kill: (pid) => `KILL ${Number(pid)}`,
    begin: 'START TRANSACTION',
  },
  {
    id: 'mssql',
    config: { ...config('mssql'), id: 'ms-loss' },
    admin: { ...config('mssql'), id: 'ms-admin' },
    pid: 'SELECT @@SPID',
    kill: (pid) => `KILL ${Number(pid)}`,
    begin: 'BEGIN TRANSACTION',
  },
  {
    id: 'oracle',
    config: oracle,
    admin: { ...oracle, id: 'ora-admin', user: 'system', password: 'Mastermind2026' },
    pid: "SELECT SYS_CONTEXT('USERENV','SID') FROM dual",
    // The app user can't read v$session; the admin looks up the serial number.
    kill: (pid) =>
      `BEGIN FOR s IN (SELECT sid, serial# AS serial FROM v$session WHERE sid = ${Number(pid)}) LOOP EXECUTE IMMEDIATE 'ALTER SYSTEM KILL SESSION ''' || s.sid || ',' || s.serial || ''' IMMEDIATE'; END LOOP; END;`,
    begin: 'SET TRANSACTION READ WRITE',
  },
]

const crashes: unknown[] = []
const onCrash = (err: unknown) => crashes.push(err)
process.on('uncaughtException', onCrash)
const svc = new DatabaseService()
afterAll(async () => {
  await svc.disconnectAll()
  process.off('uncaughtException', onCrash)
})

for (const c of cases) {
  describe.skipIf(skip.has(c.id))(`connection loss: ${c.id}`, () => {
    const run = async (sql: string, session?: string) => {
      const [o] = await svc.runScript(c.config.id, sql, { session })
      return o!
    }
    const killSession = async (session: string) => {
      const pid = String((await run(c.pid, session)).results![0]!.rows[0]![0])
      const [o] = await svc.runScript(c.admin.id, c.kill(pid))
      expect(o!.error).toBeUndefined()
      await new Promise((r) => setTimeout(r, 1000))
    }

    it('recovers silently without a transaction, reports a lost one once', async () => {
      await svc.connect(c.config)
      await svc.connect(c.admin)
      const ok = (o: Awaited<ReturnType<typeof run>>) => expect(o.error?.message).toBeUndefined()

      await killSession('idle')
      ok(await run('SELECT 1 AS n' + (c.id === 'oracle' ? ' FROM dual' : ''), 'idle'))

      ok(await run(c.begin, 'tx'))
      await killSession('tx')
      const lost = await run('SELECT 1 AS n' + (c.id === 'oracle' ? ' FROM dual' : ''), 'tx')
      expect(lost.error?.message).toMatch(/transaction/i)
      ok(await run('SELECT 1 AS n' + (c.id === 'oracle' ? ' FROM dual' : ''), 'tx'))

      // The pool (no session) keeps working too.
      ok(await run('SELECT 1 AS n' + (c.id === 'oracle' ? ' FROM dual' : '')))
      expect(crashes).toEqual([])
    })

    it('a transaction state asked after the loss neither hides it nor outlives it', async () => {
      await svc.connect(c.config)
      await svc.connect(c.admin)
      const select = 'SELECT 1 AS n' + (c.id === 'oracle' ? ' FROM dual' : '')
      const ok = (o: Awaited<ReturnType<typeof run>>) => expect(o.error?.message).toBeUndefined()

      ok(await run(c.begin, 'state'))
      ok(await run(select, 'state'))
      await killSession('state')
      // The engine asks for the state before a manual-commit write; the loss must still be reported next.
      await svc.transactionState(c.config.id, 'state')
      const lost = await run(select, 'state')
      expect(lost.error?.message).toMatch(/transaction/i)
      // Afterwards the fresh connection has no transaction (a read sends no status that would correct it).
      ok(await run(select, 'state'))
      expect(await svc.transactionState(c.config.id, 'state')).toBe('none')
      expect(crashes).toEqual([])
    })
  })
}

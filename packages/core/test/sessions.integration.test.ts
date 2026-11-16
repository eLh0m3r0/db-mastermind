import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseService, getDialect, type ConnectionConfig } from '../src/index.js'
import { engines, setupEngine, skip } from './fixtures.js'

/**
 * Every editor tab keeps a connection of its own until it closes. With nine tabs holding open transactions, the
 * grid / explorer (no session) must still answer at once, and Cancel must still reach a tab's statement: tab sessions
 * that came from the driver's 6-connection pool starved both. Requires `npm run db:up`.
 */
const oracle: ConnectionConfig = { id: 'ora-sessions', name: 'ora', driver: 'oracle', host: '127.0.0.1', port: 15219, user: 'shop', password: 'mastermind', database: 'FREEPDB1' }

interface Case {
  id: string
  config: () => Promise<ConnectionConfig>
  sleep: string
  /** Opens a transaction that stays open in the tab (none: the engine has no editor transactions here). */
  begin?: string
  /** What a plain query returns. */
  one: string
}

const svc = new DatabaseService()
afterAll(() => svc.disconnectAll())

const cases: Case[] = [
  ...engines
    .filter((e) => e.id !== 'sqlite' && e.id !== 'duckdb')
    .map((e) => ({
      id: e.id,
      config: () => setupEngine(svc, e),
      sleep: e.sleep,
      begin: getDialect(e.config.driver).begin,
      one: 'SELECT 42',
    })),
  { id: 'oracle', config: async () => (await svc.connect(oracle), oracle), sleep: 'SELECT COUNT(*) FROM all_objects a, all_objects b, all_objects c', begin: undefined, one: 'SELECT 42 FROM dual' },
  {
    id: 'duckdb',
    config: () => setupEngine(svc, engines.find((e) => e.id === 'duckdb')!),
    sleep: engines.find((e) => e.id === 'duckdb')!.sleep,
    begin: 'BEGIN TRANSACTION',
    one: 'SELECT 42',
  },
]

for (const c of cases) {
  describe.skipIf(skip.has(c.id) || (c.id === 'oracle' && skip.has('ora')))(`tab sessions on ${c.id}`, () => {
    it('nine tabs with open transactions leave room for everything else, and Cancel works', async () => {
      const config = await c.config()
      const tabs = Array.from({ length: 9 }, (_, i) => `${c.id}-tab-${i}`)
      try {
        for (const session of tabs) {
          const script = c.begin ? `${c.begin};\n${c.one}` : c.one
          const out = await svc.runScript(config.id, script, { session })
          expect(out.filter((o) => o.error).map((o) => o.error?.message)).toEqual([])
        }
        const t = Date.now()
        const [plain] = await svc.runScript(config.id, c.one)
        expect(plain?.error?.message).toBeUndefined()
        expect(Number(plain?.results?.[0]?.rows[0]?.[0])).toBe(42)
        expect(Date.now() - t).toBeLessThan(3000)
        const controller = new AbortController()
        const started = Date.now()
        const running = svc.runScript(config.id, c.sleep, { session: tabs[0], signal: controller.signal })
        await new Promise((r) => setTimeout(r, 500))
        controller.abort()
        const [cancelled] = await running
        expect(cancelled?.error).toBeDefined()
        expect(Date.now() - started).toBeLessThan(8000)
      } finally {
        for (const session of tabs) await svc.releaseSession(config.id, session).catch(() => {})
      }
    }, 60_000)
  })
}

/**
 * A cancelled statement's KILL QUERY must not stop the statement queued after it on the tab's connection (01 finding
 * 7). The KILL is made to arrive late, after the cancelled SELECT finished on its own.
 */
describe.skipIf(skip.has('mysql'))('session statements on mysql', () => {
  it('starts the next statement of a session only after the cancelled one’s KILL QUERY landed', async () => {
    const svc = new DatabaseService()
    try {
      const config = await setupEngine(svc, engines.find((e) => e.id === 'mysql')!)
      const driver = svc.driver(config.id) as unknown as { killQuery: (id: number) => Promise<void> }
      const kill = driver.killQuery.bind(driver)
      driver.killQuery = async (id) => {
        await new Promise((r) => setTimeout(r, 400))
        return kill(id)
      }
      const abort = new AbortController()
      const first = svc.driver(config.id).execute('SELECT SLEEP(0.2)', { session: 'tab-kill', signal: abort.signal })
      const second = svc.driver(config.id).execute('SELECT SLEEP(0.6) AS interrupted, 42 AS answer', { session: 'tab-kill' })
      setTimeout(() => abort.abort(), 50)
      await expect(first).rejects.toThrow()
      const [r] = await second
      // SLEEP answers 1 when a KILL QUERY stopped it.
      expect(r!.rows[0]).toEqual([0, 42])
      await svc.releaseSession(config.id, 'tab-kill')
    } finally {
      await svc.disconnectAll()
    }
  })
})

/** Two first statements of a session at once open one connection, not two with one left behind (09 finding 5). */
describe.skipIf(skip.has('postgres'))('session connections on postgres', () => {
  it('shares the connection being opened between concurrent first statements', async () => {
    const svc = new DatabaseService()
    const admin = new DatabaseService()
    const engine = engines.find((e) => e.id === 'postgres')!
    try {
      const config = await setupEngine(svc, engine)
      await admin.connect({ ...config, id: 'pg-admin-sessions' })
      const pids = await Promise.all([1, 2, 3].map(() => svc.driver(config.id).execute('SELECT pg_backend_pid()', { session: 'tab-race' })))
      expect(new Set(pids.map((r) => String(r[0]!.rows[0]![0]))).size).toBe(1)
      const pid = String(pids[0]![0]!.rows[0]![0])
      const before = await admin.runScript('pg-admin-sessions', `SELECT count(*) FROM pg_stat_activity WHERE application_name = 'DB Mastermind' AND pid <> pg_backend_pid() AND pid = ${Number(pid)}`)
      expect(Number(before[0]!.results![0]!.rows[0]![0])).toBe(1)
      await svc.releaseSession(config.id, 'tab-race')
      await new Promise((r) => setTimeout(r, 300))
      // Nothing of that session is left on the server.
      const left = await admin.runScript('pg-admin-sessions', `SELECT count(*) FROM pg_stat_activity WHERE pid = ${Number(pid)}`)
      expect(Number(left[0]!.results![0]!.rows[0]![0])).toBe(0)
    } finally {
      await svc.disconnectAll()
      await admin.disconnectAll()
    }
  })
})

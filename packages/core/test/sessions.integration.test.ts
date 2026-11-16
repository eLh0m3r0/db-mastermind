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

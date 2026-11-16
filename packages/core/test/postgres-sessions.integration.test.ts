import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DatabaseService } from '../src/index.js'
import { engines, skip } from './fixtures.js'

/**
 * PostgreSQL editor tabs each keep a connection. They used to come from the 6-client pool, so the seventh tab and
 * every grid / explorer / cancel after it timed out. Requires `npm run db:up`.
 */
const pg = engines.find((e) => e.id === 'postgres')!
const db = new DatabaseService()
const id = 'pg-sessions'
const tabs = Array.from({ length: 9 }, (_, i) => `tab-${i}`)

describe.skipIf(skip.has('postgres'))('PostgreSQL sessions', () => {
  beforeAll(async () => {
    await db.connect({ ...pg.config, id })
  })
  afterAll(async () => {
    await db.runScript(id, 'DROP TYPE IF EXISTS dbm_mood_later').catch(() => {})
    await db.disconnect(id).catch(() => {})
  })

  it('nine tabs with open transactions leave the pool free', async () => {
    for (const session of tabs) {
      const [o] = await db.runScript(id, 'BEGIN; SELECT 1', { session })
      expect(o?.error).toBeUndefined()
    }
    const pids = new Set<string>()
    for (const session of tabs) pids.add(String((await db.runScript(id, 'SELECT pg_backend_pid()', { session }))[0]!.results![0]!.rows[0]![0]))
    expect(pids.size).toBe(tabs.length)
    // Work that doesn't belong to a tab still runs at once.
    const t = Date.now()
    const [plain] = await db.runScript(id, 'SELECT 42')
    expect(plain?.results?.[0]?.rows).toEqual([[42]])
    expect(Date.now() - t).toBeLessThan(3000)
    // A cancel reaches a tab's statement while all of that is open.
    const controller = new AbortController()
    const started = Date.now()
    const running = db.runScript(id, 'SELECT pg_sleep(20)', { session: tabs[0], signal: controller.signal })
    await new Promise((r) => setTimeout(r, 300))
    controller.abort()
    const [cancelled] = await running
    expect(cancelled?.error).toBeDefined()
    expect(Date.now() - started).toBeLessThan(5000)
    for (const session of tabs) await db.releaseSession(id, session)
  }, 30_000)

  it('NOTICE / RAISE messages reach the outcome, also when the statement then fails', async () => {
    const [ok, failed, quiet] = await db.runScript(
      id,
      `DO $$BEGIN RAISE NOTICE 'hello %', 42; RAISE WARNING 'careful' USING HINT = 'look here'; END$$;
       DO $$BEGIN RAISE NOTICE 'before'; RAISE EXCEPTION 'boom'; END$$;
       SELECT 1`,
      { continueOnError: true, session: 'notice-tab' },
    )
    expect(ok?.messages).toEqual(['NOTICE: hello 42', 'WARNING: careful\nHINT: look here'])
    expect(failed?.error?.message).toMatch(/boom/)
    expect(failed?.messages).toEqual(['NOTICE: before'])
    expect(quiet?.messages).toBeUndefined()
    // Server notices of DDL, as psql shows them.
    const [skip] = await db.runScript(id, 'DROP TABLE IF EXISTS dbm_no_such_table')
    expect(skip?.messages?.[0]).toMatch(/^NOTICE: .*does not exist, skipping/)
    await db.releaseSession(id, 'notice-tab')
  })

  it('a type created after connecting has its name in results', async () => {
    await db.runScript(id, "DROP TYPE IF EXISTS dbm_mood_later; CREATE TYPE dbm_mood_later AS ENUM ('ok', 'meh')")
    const [o] = await db.runScript(id, "SELECT 'ok'::dbm_mood_later AS mood")
    expect(o?.results?.[0]?.fields[0]?.dataType).toBe('dbm_mood_later')
  })
})

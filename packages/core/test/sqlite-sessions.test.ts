import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseService } from '../src/index.js'

/**
 * SQLite has one connection, so one transaction is shared by every tab. Closing another tab, a multi-statement
 * script or an AI query must not roll back the transaction a tab opened.
 */
const svc = new DatabaseService()
afterAll(() => svc.disconnectAll())

const count = async (id: string) => {
  const [o] = await svc.runScript(id, 'SELECT count(*) AS n FROM t')
  return Number(o!.results![0]!.rows[0]![0])
}

describe('SQLite sessions', () => {
  it('only the tab that opened a transaction rolls it back', async () => {
    const id = 'lite-sessions'
    await svc.connect({ id, name: id, driver: 'sqlite', filePath: join(mkdtempSync(join(tmpdir(), 'dbm-lite-')), 'db.sqlite') })
    await svc.runScript(id, 'CREATE TABLE t (v int)')

    // Tab A opens a transaction and leaves it open.
    await svc.runScript(id, 'BEGIN; INSERT INTO t VALUES (1)', { session: 'tab-a' })
    // Meanwhile: a multi-statement script (temporary session), a read-only AI query, another tab closing.
    await svc.runScript(id, 'SELECT 1; SELECT 2')
    await svc.runScript(id, 'SELECT count(*) FROM t', { readOnly: true })
    await svc.releaseSession(id, 'tab-b')
    await svc.runScript(id, 'INSERT INTO t VALUES (2)', { session: 'tab-a' })
    await svc.runScript(id, 'COMMIT', { session: 'tab-a' })
    expect(await count(id)).toBe(2)

    // Closing tab A itself discards what it left uncommitted.
    await svc.runScript(id, 'BEGIN; INSERT INTO t VALUES (3)', { session: 'tab-a' })
    await svc.releaseSession(id, 'tab-a')
    expect(await count(id)).toBe(2)

    // A failed script still rolls back the transaction it opened itself.
    const outcomes = await svc.runScript(id, 'BEGIN; INSERT INTO t VALUES (4); INSERT INTO missing VALUES (1)')
    expect(outcomes.at(-1)?.note).toMatch(/rolled back/)
    expect(await count(id)).toBe(2)
  })
})

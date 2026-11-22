import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseService, sqlValue, type ConnectionConfig } from '../src/index.js'
import { engines, skip } from './fixtures.js'

/**
 * PostgreSQL's old string mode (standard_conforming_strings = off, still set for whole databases or roles by legacy
 * applications) makes a backslash an escape, so the server would read a text differently from the app's tokenizer:
 * what the app takes for one string could hold a call it refuses by name. The guard's transaction turns the standard
 * mode on for itself, and values are written so that either mode reads them the same.
 */
const svc = new DatabaseService()
const pg = engines.find((e) => e.id === 'postgres')!.config
const ROLE = 'dbm_old_strings'
const old: ConnectionConfig = { ...pg, id: 'pg-old-strings', name: 'old strings', user: ROLE, password: 'old-strings' }

afterAll(async () => {
  await svc.runScript(pg.id, `DROP OWNED BY ${ROLE}; DROP ROLE IF EXISTS ${ROLE}`).catch(() => {})
  await svc.disconnectAll()
})

describe.skipIf(skip.has('postgres'))('postgres with standard_conforming_strings = off', () => {
  it('the guard reads strings as the server does, and values come back as they were written', { timeout: 60_000 }, async () => {
    await svc.connect(pg)
    await svc.runScript(pg.id, `DROP ROLE IF EXISTS ${ROLE}; CREATE ROLE ${ROLE} LOGIN PASSWORD 'old-strings'; ALTER ROLE ${ROLE} SET standard_conforming_strings = off; ALTER ROLE ${ROLE} SET escape_string_warning = off`)
    await svc.connect(old)
    // The session really is in the old mode.
    const [mode] = await svc.runScript(old.id, 'SHOW standard_conforming_strings')
    expect(mode!.results![0]!.rows[0]![0]).toBe('off')

    // In the old mode this is a string, a call of a refused function and a comment; the tokenizer sees one string.
    const hidden = "SELECT '\\'', pg_sleep(0) --'"
    for (const run of [
      () => svc.runScript(old.id, hidden, { readOnly: true }),
      async () => {
        const rows: unknown[][] = []
        let fields = 0
        for await (const batch of svc.streamQuery(old.id, hidden, { readOnly: true })) {
          fields = batch.fields?.length ?? fields
          rows.push(...batch.rows)
        }
        return [{ results: [{ fields: new Array(fields).fill(0), rows }] }]
      },
    ]) {
      const [o] = (await run()) as { error?: { message: string }; results?: { fields: unknown[]; rows: unknown[][] }[] }[]
      // One column, the text itself: the server read it as the app did, and pg_sleep was never called.
      expect(o!.error).toBeUndefined()
      expect(o!.results![0]!.fields).toHaveLength(1)
      expect(o!.results![0]!.rows[0]![0]).toBe("\\', pg_sleep(0) --")
    }

    // A value with backslashes and quotes, written as SQL, is that value in the old mode and in the standard one.
    for (const value of ["a\\'; DROP TABLE x; --", 'C:\\temp\\new', "it's \\\\ fine", '\\']) {
      for (const id of [old.id, pg.id]) {
        const [o] = await svc.runScript(id, `SELECT ${sqlValue(value, 'postgres')} AS v`)
        expect(o!.error, value).toBeUndefined()
        expect(o!.results![0]!.rows[0]![0], `${value} on ${id}`).toBe(value)
      }
    }
  })
})

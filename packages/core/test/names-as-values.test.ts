import { describe, expect, it } from 'vitest'
import { collationName, getDialect, listGrants, stopSession, type DatabaseService } from '../src/index.js'

// Wave 10 (audit F): names reach SQL as parameters or through the quoting of the database, never pasted in.
function fakeDb(driver: string, calls: { sql: string; params?: unknown[] }[]): DatabaseService {
  return {
    config: () => ({ id: 'x', name: 'x', driver }),
    serverInfo: () => ({ product: driver, version: '' }),
    runScript: async (_id: string, sql: string, options: { params?: unknown[] } = {}) => {
      calls.push({ sql, params: options.params })
      return [{ sql, start: 0, end: sql.length, durationMs: 0, results: [{ fields: [], rows: [], rowCount: 0 }] }]
    },
  } as unknown as DatabaseService
}

describe('names as values', () => {
  it('a principal name is a parameter in every grant query', async () => {
    const evil = "x' OR '1'='1"
    for (const driver of ['postgres', 'mysql', 'mariadb', 'mssql', 'oracle']) {
      const calls: { sql: string; params?: unknown[] }[] = []
      await listGrants(fakeDb(driver, calls), 'x', evil)
      expect(calls.length, driver).toBe(1)
      expect(calls[0]!.sql, driver).not.toContain('OR')
      expect(calls[0]!.params, driver).toContain(evil)
    }
  })

  it('a session id that is not one the server gives is refused before any SQL', async () => {
    for (const [driver, id] of [['postgres', '1); SELECT pg_sleep(9'], ['postgres', '1,2'], ['mysql', '1 OR 1'], ['mssql', '1;DROP'], ['oracle', "1,2' IMMEDIATE --"], ['oracle', '12']] as const) {
      const calls: { sql: string }[] = []
      await expect(stopSession(fakeDb(driver, calls), 'x', id, 'terminate'), `${driver} ${id}`).rejects.toThrow(/Invalid session id/)
      expect(calls).toEqual([])
    }
    const calls: { sql: string }[] = []
    await stopSession(fakeDb('oracle', calls), 'x', '12,345', 'cancel')
    expect(calls[0]!.sql).toBe("ALTER SYSTEM CANCEL SQL '12,345'")
  })

  it('a collation is a collation name or quoted', () => {
    const pg = getDialect('postgres')
    for (const ok of ['C', 'en_US.utf8', '"de-x-icu"', 'pg_catalog."C"', 'Latin1_General_CI_AS', 'utf8mb4_0900_ai_ci']) expect(collationName(ok, pg)).toBe(ok)
    expect(collationName('C; DROP TABLE t', pg)).toBe('"C; DROP TABLE t"')
    expect(collationName("x' --", getDialect('mysql'))).toBe("`x' --`")
  })
})

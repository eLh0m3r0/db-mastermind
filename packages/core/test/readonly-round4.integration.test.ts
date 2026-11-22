import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { DatabaseService, type ConnectionConfig, type DriverId } from '../src/index.js'
import { engines, setupEngine, skip } from './fixtures.js'

/**
 * Review round 4 on the real servers: SQL that runs SQL text the tokenizer never sees is refused by SQL Server's own
 * plan as well (sp_executesql, EXEC(@s), OPENQUERY) and by the guard on MySQL (PREPARE); SQL Server's guarded runs
 * have a lock timeout and a time limit, also on the shared session; the user profile takes #temp but not ##global
 * tables, and SET NAMES only of the listed character sets.
 */
const svc = new DatabaseService()
afterAll(() => svc.disconnectAll())
afterEach(() => {
  delete process.env.DBM_UNCONFIRMED_TIMEOUT_MS
})
const config = (id: string) => engines.find((e) => e.id === id)!

describe.skipIf(skip.has('mssql'))('mssql', () => {
  it("SQL text run from inside a batch is refused by the server's plan on its own", async () => {
    const base = await setupEngine(svc, config('mssql'))
    const entry = (svc as unknown as { get(id: string): unknown }).get(base.id)
    const plan = (svc as unknown as { mssqlReadsOnly: (e: unknown, s: string, b: string, p: unknown, profile: string) => Promise<void> }).mssqlReadsOnly
    for (const batch of ["EXEC sp_executesql N'SELECT 1'", "DECLARE @s nvarchar(99) = N'SELECT 1'; EXEC(@s)", "SELECT * FROM OPENQUERY(nosuchserver, 'SELECT 1')"]) {
      const session = `r4-${Math.random().toString(36).slice(2)}`
      try {
        await expect(plan.call(svc, entry, session, batch, undefined, 'agent'), batch).rejects.toThrow(/plans this batch with|could not plan/)
      } finally {
        await svc.releaseSession(base.id, session).catch(() => {})
      }
      await expect(svc.runScript(base.id, batch, { readOnly: true }), batch).rejects.toThrow(/read-only/)
    }
  })

  it('guarded runs have a lock timeout and a time limit, also on the shared session', { timeout: 60_000 }, async () => {
    const base = await setupEngine(svc, config('mssql'))
    const [lock] = await svc.runScript(base.id, 'SELECT @@LOCK_TIMEOUT AS t', { readOnly: true })
    expect(Number(lock!.results![0]!.rows[0]![0])).toBe(10000)
    process.env.DBM_UNCONFIRMED_TIMEOUT_MS = '1500'
    const started = Date.now()
    const [slow] = await svc.runScript(base.id, 'SELECT count_big(*) FROM sys.all_objects a CROSS JOIN sys.all_objects b CROSS JOIN sys.all_objects c CROSS JOIN sys.all_objects d', { readOnly: true })
    expect(slow!.error?.message).toMatch(/Stopped after 2 s/)
    expect(Date.now() - started).toBeLessThan(20_000)
    // The shared session is still good for the next run.
    const [next] = await svc.runScript(base.id, 'SELECT 1 AS one', { readOnly: true })
    expect(next!.error).toBeUndefined()
  })

  it('the user profile: #temp tables, never ##global ones', async () => {
    const base = await setupEngine(svc, config('mssql'))
    const readOnly: ConnectionConfig = { ...base, id: `${base.id}-ro4`, readOnly: true }
    await svc.connect(readOnly)
    expect((await svc.runScript(readOnly.id, 'SELECT 1 AS a INTO #dbm_l; SELECT a FROM #dbm_l')).filter((o) => o.error)).toEqual([])
    for (const sql of ['SELECT 1 AS a INTO ##dbm_g', 'SELECT 1 AS a INTO ##dbm_g; SELECT a FROM ##dbm_g']) {
      const [o] = await svc.runScript(readOnly.id, sql)
      expect(o!.error?.message, sql).toMatch(/This connection is read-only/)
    }
  })
})

for (const driver of ['mysql', 'mariadb'] as const) {
  describe.skipIf(skip.has(driver))(driver, () => {
    it('PREPARE is refused; SET NAMES only of the listed character sets', async () => {
      const base = await setupEngine(svc, config(driver))
      await expect(svc.runScript(base.id, "PREPARE s FROM 'SELECT 1'", { readOnly: true })).rejects.toThrow(/read-only/)
      const readOnly: ConnectionConfig = { ...base, id: `${base.id}-ro4`, readOnly: true }
      await svc.connect(readOnly)
      const tab = { session: 'tab-r4' }
      expect((await svc.runScript(readOnly.id, 'SET NAMES utf8mb4; SELECT 1', tab)).filter((o) => o.error)).toEqual([])
      for (const sql of ['SET NAMES gbk', "SET NAMES 'big5'", 'SET NAMES sjis']) {
        const [o] = await svc.runScript(readOnly.id, sql, tab)
        expect(o!.error?.message, sql).toMatch(/This connection is read-only/)
      }
      await svc.releaseSession(readOnly.id, tab.session)
    })
  })
}

describe.skipIf(skip.has('postgres'))('postgres', () => {
  it("the reviewer's U& spellings are refused, and nothing ran", async () => {
    const base = await setupEngine(svc, config('postgres'))
    const readOnly: ConnectionConfig = { ...base, id: `${base.id}-ro4`, readOnly: true }
    await svc.connect(readOnly)
    for (const sql of [`SELECT U&"pg\\005fread\\005ffile"('/etc/passwd')`, `SELECT pg_catalog.U&"pg\\005fread\\005ffile"('/etc/passwd')`, `SELECT U&"pg\\005fterminate\\005fbackend"(0)`, `SELECT U&"pg\\005fadvisory\\005flock"(4343)`, `SELECT U&"query\\005fto\\005fxml"('select 1', true, false, '')`]) {
      await expect(svc.runScript(base.id, sql, { readOnly: true }), sql).rejects.toThrow(/Unicode escapes/)
      const [o] = await svc.runScript(readOnly.id, sql)
      expect(o!.error?.message, sql).toMatch(/Unicode escapes/)
    }
    const [locks] = await svc.runScript(base.id, "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = 4343", { readOnly: false })
    expect(Number(locks!.results![0]!.rows[0]![0])).toBe(0)
  })
})

/** A read nobody confirmed, streamed: the same guard as runScript (streamGuarded), on every engine. */
const ORACLE: ConnectionConfig = { id: 'ora-r4', name: 'ora', driver: 'oracle', host: '127.0.0.1', port: 15219, user: 'shop', password: 'mastermind', database: 'FREEPDB1' }
const CLICKHOUSE: ConnectionConfig = { id: 'ch-r4', name: 'ch', driver: 'clickhouse', host: '127.0.0.1', port: 18123, user: 'default', password: 'mastermind', database: 'default' }
const STREAM: Partial<Record<DriverId, { read: string; inTransaction?: [sql: string, expected: string]; refused: string[] }>> = {
  postgres: { read: 'SELECT g FROM generate_series(1, 12000) g', inTransaction: ["SELECT current_setting('transaction_read_only')", 'on'], refused: ['SELECT pg_sleep(0)', 'SELECT 1; SELECT 2', "SELECT U&\"pg\\005fsleep\"(0)", 'DELETE FROM shop.customers RETURNING id', 'SET search_path TO shop'] },
  mysql: { read: 'SELECT 1 AS a UNION ALL SELECT 2', refused: ['SELECT SLEEP(0)', "SELECT 'x' INTO OUTFILE '/tmp/dbm_r4s'", 'SELECT 1; SELECT 2'] },
  mariadb: { read: 'SELECT 1 AS a UNION ALL SELECT 2', refused: ['SELECT SLEEP(0)', 'SELECT 1; SELECT 2'] },
  mssql: { read: 'SELECT TOP (12000) a.object_id FROM sys.all_columns a CROSS JOIN sys.all_columns b', inTransaction: ['SELECT @@TRANCOUNT', '1'], refused: ["SELECT * FROM sys.fn_get_audit_file('/x*.sqlaudit', default, default)", 'SELECT 1 DELETE FROM shop.customers', "EXEC sp_executesql N'SELECT 1'"] },
  oracle: { read: 'SELECT level FROM dual CONNECT BY level <= 12000', refused: ['SELECT dbms_random.value FROM dual', 'SELECT 1 FROM dual FOR UPDATE'] },
  sqlite: { read: 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 12000) SELECT i FROM n', refused: ["SELECT load_extension('x')", 'DELETE FROM customers RETURNING id', 'PRAGMA query_only = 0'] },
  duckdb: { read: 'SELECT * FROM range(12000)', refused: ["SELECT * FROM read_text('/etc/hosts')", 'SELECT 1; SELECT 2', 'CREATE TABLE x AS SELECT 1'] },
  clickhouse: { read: 'SELECT number FROM numbers(12000)', refused: ["SELECT * FROM file('x')", 'SELECT sleep(0)', 'SELECT 1; SELECT 2'] },
}
for (const [driver, spec] of Object.entries(STREAM) as [DriverId, NonNullable<(typeof STREAM)[DriverId]>][]) {
  describe.skipIf(skip.has(driver))(`${driver}: a read nobody confirmed streams through the guard`, () => {
    it('rows come in batches, inside the read-only transaction; everything else is refused', { timeout: 120_000 }, async () => {
      let id: string
      if (driver === 'oracle' || driver === 'clickhouse') {
        const c = driver === 'oracle' ? ORACLE : CLICKHOUSE
        await svc.connect(c)
        id = c.id
      } else id = (await setupEngine(svc, config(driver))).id
      let rows = 0
      let batches = 0
      for await (const b of svc.streamQuery(id, spec.read, { readOnly: true, batchSize: 1000 })) {
        rows += b.rows.length
        batches++
      }
      expect(rows).toBe(spec.read.includes('12000') ? 12000 : 2)
      if (rows > 2) expect(batches).toBeGreaterThan(1)
      if (spec.inTransaction) {
        const seen: string[] = []
        for await (const b of svc.streamQuery(id, spec.inTransaction[0], { readOnly: true })) seen.push(...b.rows.map((r) => String(r[0])))
        expect(seen).toEqual([spec.inTransaction[1]])
      }
      for (const sql of spec.refused) {
        const take = async () => {
          for await (const _ of svc.streamQuery(id, sql, { readOnly: true })) void _
        }
        await expect(take(), sql).rejects.toThrow()
      }
      // A read-only connection (the desktop app's export) streams through the same guard, with the user's profile.
      if (driver !== 'oracle' && driver !== 'clickhouse') {
        const base = config(driver).config
        const readOnly: ConnectionConfig = { ...base, id: `${base.id}-ro4s`, readOnly: true }
        await svc.connect(readOnly)
        let n = 0
        for await (const b of svc.streamQuery(readOnly.id, spec.read)) n += b.rows.length
        expect(n).toBe(rows)
        const take = async () => {
          for await (const _ of svc.streamQuery(readOnly.id, spec.refused[0]!)) void _
        }
        // (DuckDB's guarded instance refuses the file itself.)
        await expect(take()).rejects.toThrow(/read-only|can.t be read here/i)
      }
    })
  })
}

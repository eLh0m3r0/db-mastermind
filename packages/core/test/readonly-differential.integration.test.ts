import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseService, lex, readVerdict, tokenStatements, type ConnectionConfig, type DriverId } from '../src/index.js'
import { engines, setupEngine, skip, tmp } from './fixtures.js'
import { rng } from './orm-fuzz.js'

/**
 * Review round 2 (C1, E): SQL nobody confirmed, on the real servers.
 * - Each review input is stopped, and each layer stops it on its own (the others switched off in the test):
 *   the tokenizer + allowlist (readVerdict), the server's truth (one statement per call, SHOWPLAN, query_only,
 *   DuckDB's statement type), and the check after every statement that the read-only transaction is still there.
 * - Differential fuzz: thousands of inputs from each dialect's lexical alphabet, a write to `dbm_canary` buried
 *   where a wrong lexer would think it is text. Whatever the guarded path lets through leaves the canary as it was
 *   (property 1); where our tokenizer says "one statement", PostgreSQL's extended protocol agrees, and SQL Server's
 *   plan of every batch we accept lists only reads (property 2).
 */
const N = Number(process.env.DBM_DIFF_N ?? 1500)
const svc = new DatabaseService()
afterAll(async () => {
  await svc.disconnectAll()
  rmSync(tmp, { recursive: true, force: true })
})

const ORACLE: ConnectionConfig = { id: 'ora-diff', name: 'ora', driver: 'oracle', host: '127.0.0.1', port: 15219, user: 'shop', password: 'mastermind', database: 'FREEPDB1' }

const C1: Partial<Record<DriverId, string[]>> = {
  postgres: ["SELECT $é$ ' $é$; COMMIT; DELETE FROM dbm_canary; --'", "SELECT $é$ ' $é$; COMMIT; SET default_transaction_read_only = off; COMMIT; DELETE FROM dbm_canary; --'", "SELECT 1 /* /* */ ' */; DELETE FROM dbm_canary --'"],
  mssql: ["SELECT 1 /* /* */ ' */ COMMIT DELETE FROM dbm_canary --'"],
  mysql: ["SELECT 'x' /*! INTO OUTFILE '/var/lib/mysql-files/dbm_c1' */", "SELECT 'x' /*! ; DELETE FROM dbm_canary */"],
  mariadb: ["SELECT 'x' /*! INTO OUTFILE '/tmp/dbm_c1' */"],
  oracle: ["SELECT q'[ ' ]' FROM dual; DELETE FROM dbm_canary; SELECT ' ' FROM dual"],
  sqlite: ["SELECT 1; DELETE FROM dbm_canary"],
  duckdb: ["SELECT 1; DELETE FROM dbm_canary"],
}

/** The canary as a fingerprint: rows and their values. */
async function fingerprint(id: string): Promise<string> {
  const [o] = await svc.runScript(id, 'SELECT id, v FROM dbm_canary ORDER BY id', { readOnly: false })
  if (o?.error) throw new Error(o.error.message)
  return JSON.stringify(o?.results?.[0]?.rows)
}

async function canary(id: string, driver: DriverId) {
  const text = driver === 'oracle' ? 'VARCHAR2(20)' : 'varchar(20)'
  const drop = driver === 'oracle' ? "BEGIN EXECUTE IMMEDIATE 'DROP TABLE dbm_canary'; EXCEPTION WHEN OTHERS THEN NULL; END;" : 'DROP TABLE IF EXISTS dbm_canary'
  for (const sql of [drop, `CREATE TABLE dbm_canary (id int, v ${text})`, "INSERT INTO dbm_canary VALUES (1, 'a')", "INSERT INTO dbm_canary VALUES (2, 'b''c')", "INSERT INTO dbm_canary VALUES (3, NULL)"]) {
    const [o] = await svc.runScript(id, sql, { readOnly: false })
    if (o?.error && !/does not exist/.test(o.error.message)) throw new Error(`${sql}: ${o.error.message}`)
  }
}

const ALPHABET: Record<string, string[]> = {
  common: ["'", '"', '(', ')', ';', '--', '-- ', '/*', '*/', '\n', ' ', ',', '\\', "''", '1'],
  postgres: ['$$', '$é$', '$a$', "E'", "U&'", '/* /*', '$1', 'END', 'COMMIT'],
  mysql: ['`', '#', '/*!', '/*!50000 ', '*/', "\\'", '\\"', "_utf8mb4'", "X'", 'INTO OUTFILE '],
  mssql: ['[', ']', ']]', "N'", '/* /*', '\nGO\n', 'COMMIT'],
  oracle: ["q'[", "]'", "q'{", "}'", "nq'<", ">'", '/'],
  sqlite: ['`', '[', ']', '$x'],
}
const PAYLOADS = ['; DELETE FROM dbm_canary; ', ' DELETE FROM dbm_canary ', "; UPDATE dbm_canary SET v = 'x'; ", ' COMMIT DELETE FROM dbm_canary ', '; COMMIT; DELETE FROM dbm_canary; ']

/** An input: a read, then pieces of the alphabet around a buried write, maybe closing what was opened. */
function input(seed: number, driver: DriverId): string {
  const r = rng(seed)
  const family = driver === 'mariadb' || driver === 'mysql' ? 'mysql' : driver === 'duckdb' ? 'postgres' : driver
  const alphabet = [...ALPHABET.common!, ...(ALPHABET[family] ?? [])]
  const pick = () => alphabet[Math.floor(r() * alphabet.length)]!
  const around = (n: number) => Array.from({ length: n }, pick).join(r() < 0.5 ? '' : ' ')
  const from = driver === 'oracle' ? ' FROM dual' : ''
  const open = around(1 + Math.floor(r() * 4))
  return `SELECT 1 ${open}${PAYLOADS[Math.floor(r() * PAYLOADS.length)]}${r() < 0.5 ? open.split('').reverse().join('') : around(Math.floor(r() * 4))}${from}`
}

const READS = new Set(['SELECT', 'SELECT WITHOUT QUERY', 'ASSIGN', 'COND', 'COND WITH QUERY', 'PRINT'])

for (const driver of ['postgres', 'mysql', 'mariadb', 'mssql', 'oracle', 'sqlite', 'duckdb'] as DriverId[]) {
  const engine = engines.find((e) => e.id === driver)
  describe.skipIf(skip.has(driver))(`SQL nobody confirmed on ${driver}`, () => {
    let id = ''
    const connect = async () => {
      if (id) return id
      if (driver === 'oracle') {
        await svc.connect(ORACLE)
        id = ORACLE.id
      } else id = (await setupEngine(svc, engine!)).id
      await canary(id, driver)
      return id
    }

    it('the review inputs are refused, and each layer stops them on its own', { timeout: 300_000 }, async () => {
      await connect()
      const before = await fingerprint(id)
      const db = svc as unknown as { get(id: string): { driver: { execute: Function; transactionState?: Function; dialect: { beginReadOnly?: string; rollback: string } } } }
      const entry = db.get(id)
      for (const sql of C1[driver] ?? []) {
        // All layers: refused before anything runs.
        await expect(svc.runScript(id, sql, { readOnly: true }), sql).rejects.toThrow(/read-only|could not be read|MySQL runs/i)
        // The tokenizer and allowlist alone.
        expect(readVerdict(sql, driver).ok, sql).toBe(false)
        // The server alone, past an old lexer that read the input as one statement.
        const session = `layer-a-${Math.random().toString(36).slice(2)}`
        try {
          // (SQL Server plans before its transaction begins, as the engine does.)
          if (entry.driver.dialect.beginReadOnly && driver !== 'mssql') await entry.driver.execute(entry.driver.dialect.beginReadOnly, { session })
          if (driver === 'mssql') {
            await expect((svc as unknown as { mssqlReadsOnly: Function }).mssqlReadsOnly(entry, session, sql), sql).rejects.toThrow(/plans this batch with (COMMIT|DELETE)/)
          } else if (driver === 'mysql' || driver === 'mariadb') {
            // MySQL's read-only transaction does not stop INTO OUTFILE: only the tokenizer and allowlist do, and the
            // server's one-statement rule stops a second statement.
            if (!/OUTFILE/.test(sql)) await expect(entry.driver.execute(sql, { session, unconfirmed: true }), sql).rejects.toThrow()
          } else if (driver === 'sqlite') {
            // SQLite runs the first statement only (the rest is never run), and query_only refuses a write.
            await entry.driver.execute(sql, { session, unconfirmed: true })
            await expect(entry.driver.execute('DELETE FROM dbm_canary', { session, unconfirmed: true })).rejects.toThrow(/readonly/)
          } else {
            await expect(entry.driver.execute(sql, { session, unconfirmed: true }), sql).rejects.toThrow()
          }
        } finally {
          await entry.driver.execute(entry.driver.dialect.rollback, { session }).catch(() => {})
          await svc.releaseSession(id, session).catch(() => {})
        }
        expect(await fingerprint(id), sql).toBe(before)
      }
      // The check after each statement on its own: a transaction ended inside a statement is seen.
      if (driver === 'postgres' || driver === 'mssql') {
        const session = `layer-3-${Math.random().toString(36).slice(2)}`
        try {
          await entry.driver.execute(entry.driver.dialect.beginReadOnly!, { session })
          expect(await entry.driver.transactionState!(session)).toBe('open')
          await entry.driver.execute(driver === 'postgres' ? 'SELECT 1; COMMIT; SELECT 2' : 'SELECT 1 COMMIT SELECT 2', { session })
          expect(await entry.driver.transactionState!(session)).toBe('none')
        } finally {
          await svc.releaseSession(id, session).catch(() => {})
        }
      }
      if (driver === 'mysql') {
        // No file was written by any of it.
        const files = execFileSync('docker', ['exec', 'db-mastermind-mysql-1', 'ls', '/var/lib/mysql-files'], { encoding: 'utf8' })
        expect(files).not.toMatch(/dbm_/)
      }
    })

    it(`differential fuzz: ${N} inputs leave the canary as it was`, { timeout: 1_800_000 }, async () => {
      await connect()
      const before = await fingerprint(id)
      const entry = (svc as unknown as { get(id: string): { driver: { execute: Function; dialect: { beginReadOnly?: string; rollback: string } } } }).get(id)
      let accepted = 0
      let oneStatement = 0
      const disagreements: string[] = []
      const start = performance.now()
      for (let seed = 1; seed <= N; seed++) {
        const sql = input(seed, driver)
        // Property 1: whatever runs, runs guarded, and the canary is as it was.
        const ran = await svc.runScript(id, sql, { readOnly: true }).then(
          () => true,
          () => false,
        )
        if (ran) accepted++
        // Property 2: our tokenizer's statement count is the server's.
        const lexed = lex(sql, driver)
        const count = lexed.ok ? tokenStatements(sql, lexed.tokens, driver).length : -1
        if (driver === 'postgres' && count === 1) {
          oneStatement++
          const session = `diff-${seed}`
          try {
            await entry.driver.execute('BEGIN TRANSACTION READ ONLY', { session })
            await entry.driver.execute(sql, { session, unconfirmed: true }).catch((err: Error) => {
              if (/cannot insert multiple commands/i.test(err.message)) disagreements.push(`seed ${seed}: the server sees more than one statement: ${JSON.stringify(sql)}`)
            })
          } finally {
            await svc.releaseSession(id, session).catch(() => {})
          }
        }
        if (driver === 'mssql' && readVerdict(sql, 'mssql').ok) {
          oneStatement++
          const session = `diff-${seed}`
          try {
            await entry.driver.execute('SET SHOWPLAN_XML ON', { session })
            const plans = await entry.driver.execute(sql, { session }).catch(() => [])
            await entry.driver.execute('SET SHOWPLAN_XML OFF', { session })
            const types = [...(plans as { rows: unknown[][] }[]).map((r) => String(r.rows[0]?.[0] ?? '')).join('\n').matchAll(/<Stmt\w+[^>]*?StatementType="([^"]+)"/g)].map((m) => m[1]!)
            const other = types.find((t) => !READS.has(t))
            if (other) disagreements.push(`seed ${seed}: we read it as reads only, SQL Server plans ${other}: ${JSON.stringify(sql)}`)
          } finally {
            await svc.releaseSession(id, session).catch(() => {})
          }
        }
        if (seed % 100 === 0 || seed === N) {
          const now = await fingerprint(id)
          if (now !== before) disagreements.push(`seed ${Math.max(1, seed - 99)}–${seed}: the canary changed`)
          if (now !== before) break
        }
      }
      console.log(`${driver}: ${N} inputs in ${Math.round((performance.now() - start) / 1000)} s, ${accepted} run (guarded), ${oneStatement} checked against the server`)
      expect(disagreements.slice(0, 10)).toEqual([])
      expect(await fingerprint(id)).toBe(before)
    })
  })
}

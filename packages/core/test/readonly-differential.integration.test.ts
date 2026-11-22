import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseService, lex, readVerdict, tokenStatements, type ConnectionConfig, type DriverId } from '../src/index.js'
import { engines, serverFiles, setupEngine, skip, tmp } from './fixtures.js'
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

const CLICKHOUSE: ConnectionConfig = { id: 'ch-diff', name: 'ch', driver: 'clickhouse', host: '127.0.0.1', port: 18123, user: 'default', password: 'mastermind', database: 'default' }
const ORACLE: ConnectionConfig = { id: 'ora-diff', name: 'ora', driver: 'oracle', host: '127.0.0.1', port: 15219, user: 'shop', password: 'mastermind', database: 'FREEPDB1' }

const C1: Partial<Record<DriverId, string[]>> = {
  postgres: ["SELECT $é$ ' $é$; COMMIT; DELETE FROM dbm_canary; --'", "SELECT $é$ ' $é$; COMMIT; SET default_transaction_read_only = off; COMMIT; DELETE FROM dbm_canary; --'", "SELECT 1 /* /* */ ' */; DELETE FROM dbm_canary --'"],
  mssql: ["SELECT 1 /* /* */ ' */ COMMIT DELETE FROM dbm_canary --'"],
  mysql: ["SELECT 'x' /*! INTO OUTFILE '/var/lib/mysql-files/dbm_c1' */", "SELECT 'x' /*! ; DELETE FROM dbm_canary */"],
  mariadb: ["SELECT 'x' /*! INTO OUTFILE '/tmp/dbm_c1' */", "SELECT 'x' /*M! INTO OUTFILE '/tmp/dbm_c1m' */", "SELECT 'x' /*M!100000 INTO OUTFILE '/tmp/dbm_c1n' */"],
  clickhouse: ["SELECT * FROM file('dbm_c1.csv')", 'SELECT 1; DROP TABLE dbm_canary', "SELECT 1 /* /* */ ' */; DROP TABLE dbm_canary --'"],
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
  const text = driver === 'oracle' ? 'VARCHAR2(20)' : driver === 'clickhouse' ? 'Nullable(String)' : 'varchar(20)'
  const drop = driver === 'oracle' ? "BEGIN EXECUTE IMMEDIATE 'DROP TABLE dbm_canary'; EXCEPTION WHEN OTHERS THEN NULL; END;" : 'DROP TABLE IF EXISTS dbm_canary'
  for (const sql of [drop, `CREATE TABLE dbm_canary (id int, v ${text})${driver === 'clickhouse' ? ' ENGINE = MergeTree ORDER BY id' : ''}`, "INSERT INTO dbm_canary VALUES (1, 'a')", "INSERT INTO dbm_canary VALUES (2, 'b''c')", "INSERT INTO dbm_canary VALUES (3, NULL)"]) {
    const [o] = await svc.runScript(id, sql, { readOnly: false })
    if (o?.error && !/does not exist/.test(o.error.message)) throw new Error(`${sql}: ${o.error.message}`)
  }
}

const ALPHABET: Record<string, string[]> = {
  common: ["'", '"', '(', ')', ';', '--', '-- ', '/*', '*/', '\n', ' ', ',', '\\', "''", '1'],
  postgres: ['$$', '$é$', '$a$', "E'", "U&'", 'U&"', '\\005f', " UESCAPE '!'", '/* /*', '$1', 'END', 'COMMIT'],
  mysql: ['`', '#', '/*!', '/*!50000 ', '/*M!', '/*M!100000 ', '/*+', '*/', "\\'", '\\"', "_utf8mb4'", "X'", 'INTO OUTFILE ', 'INTO @v '],
  clickhouse: ['`', '#', '\\\'', '$$', '$h$', '/* /*', "file('x')", '\\x5f', '`fil\\x65`('],
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

/**
 * Review round 4: spellings of refused functions, as each server spells names. Every combination of a name's
 * spelling, a qualification and what stands before `(` is first run as it is (unguarded): where the server calls the
 * function (it runs, or fails for any reason other than not finding it), the guarded path must refuse it. The
 * functions are harmless ones of the refused list (sleep 0, unlock all, a missing file).
 */
const uEscape = (name: string, how: 'u4' | 'u6' | 'bang') => (how === 'bang' ? `U&"${name.replaceAll('_', '!005f')}" UESCAPE '!'` : `U&"${name.replaceAll('_', how === 'u4' ? '\\005f' : '\\+00005f')}"`)
const SPELL: Partial<Record<DriverId, { calls: [name: string, args: string][]; names: (n: string) => string[]; qualifiers: string[]; tail?: string }>> = {
  postgres: {
    calls: [['pg_sleep', '(0)'], ['pg_terminate_backend', '(0)'], ['pg_advisory_unlock_all', '()'], ['query_to_xml', "('select 1', true, false, '')"], ['pg_read_file', "('/etc/hostname')"]],
    names: (n) => [n, n.toUpperCase(), `"${n}"`, `"${n.toUpperCase()}"`, uEscape(n, 'u4'), uEscape(n, 'u6'), uEscape(n, 'bang'), `U&"\\0070${n.slice(1)}"`],
    qualifiers: ['', 'pg_catalog.', '"pg_catalog".', 'PG_CATALOG . ', 'pg_catalog/* c */.', 'mastermind.pg_catalog.', 'U&"pg\\005fcatalog".'],
  },
  duckdb: {
    calls: [['query', "('SELECT 1')"]],
    names: (n) => [n, n.toUpperCase(), `"${n}"`, `"${n.toUpperCase()}"`, uEscape(n, 'u4'), `U&"\\0071uery"`],
    qualifiers: ['', 'main.', '"main".', 'system.main.'],
    tail: '',
  },
  mysql: {
    calls: [['sleep', '(0)'], ['release_lock', "('dbm_x')"], ['benchmark', '(1, 1)']],
    names: (n) => [n, n.toUpperCase(), `\`${n}\``, `\`${n.toUpperCase()}\``, `"${n}"`],
    qualifiers: ['', 'mastermind.', '`mastermind`.', 'mastermind . '],
  },
  mssql: {
    calls: [['fn_get_audit_file', "('/var/opt/mssql/dbm_nothing*.sqlaudit', default, default)"], ['fn_trace_gettable', "('/nothing.trc', default)"]],
    names: (n) => [n, n.toUpperCase(), `[${n}]`, `[${n.toUpperCase()}]`, `"${n}"`],
    qualifiers: ['', 'sys.', '[sys].', '"sys".', 'master.sys.', '[master].[sys].', 'master..', 'SYS . '],
  },
  oracle: {
    calls: [['dbms_random', '.value'], ['dbms_random', '.value()'], ['dbms_utility', '.get_time']],
    names: (n) => [n, n.toUpperCase(), `"${n.toUpperCase()}"`, `"${n}"`],
    qualifiers: ['', 'sys.', '"SYS".', 'SYS . '],
    tail: ' FROM dual',
  },
  sqlite: {
    calls: [['load_extension', "('dbm_nothing')"]],
    names: (n) => [n, n.toUpperCase(), `"${n}"`, `\`${n}\``, `[${n}]`],
    qualifiers: ['', 'main.'],
  },
  clickhouse: {
    calls: [['sleep', '(0)'], ['file', "('dbm_nothing.csv', 'CSV', 'a String')"]],
    names: (n) => [n, n.toUpperCase(), `\`${n}\``, `"${n}"`, `\`${n.slice(0, -1)}\\x${n.charCodeAt(n.length - 1).toString(16)}\``, `"\\x${n.charCodeAt(0).toString(16)}${n.slice(1)}"`],
    qualifiers: ['', 'default.', 'system.'],
  },
}
SPELL.mariadb = SPELL.mysql
const GAPS = ['', ' ', '/* c */', '\n']
const NOT_FOUND = /(function|schema|database) .*does not exist|Function with name .* does not exist|does not exist in the database|no such function|not a recognized|Invalid object name|Unknown (table )?function|UNKNOWN_FUNCTION|ORA-00904|ORA-00942|ORA-00923|ORA-00936|ORA-06553|ORA-00972|syntax error|Syntax error|Could not find|invalid identifier|Incorrect syntax|error in your SQL syntax|Catalog Error|Parser Error|cross-database references|Cannot find either column/i

function spellings(driver: DriverId): string[] {
  const spec = SPELL[driver]
  if (!spec) return []
  const out: string[] = []
  let g = 0
  for (const [name, args] of spec.calls)
    for (const n of spec.names(name))
      for (const q of spec.qualifiers) {
        const call = `${q}${n}${GAPS[g++ % GAPS.length]}${args}`
        const table = (driver === 'clickhouse' && name === 'file') || driver === 'mssql'
        out.push(table ? `SELECT * FROM ${call}` : `SELECT ${call}${spec.tail ?? ''}`)
      }
  return out
}

for (const driver of ['postgres', 'mysql', 'mariadb', 'mssql', 'oracle', 'sqlite', 'duckdb', 'clickhouse'] as DriverId[]) {
  const engine = engines.find((e) => e.id === driver)
  describe.skipIf(skip.has(driver))(`SQL nobody confirmed on ${driver}`, () => {
    const files = driver === 'mysql' || driver === 'mariadb' ? serverFiles(driver) : undefined
    const filesBefore = files?.list()
    let id = ''
    const connect = async () => {
      if (id) return id
      if (driver === 'oracle' || driver === 'clickhouse') {
        const c = driver === 'oracle' ? ORACLE : CLICKHOUSE
        await svc.connect(c)
        id = c.id
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
    })

    it('every spelling the server resolves to a refused function is refused', { timeout: 600_000 }, async () => {
      await connect()
      let reached = 0
      const missed: string[] = []
      const all = spellings(driver)
      for (const sql of all) {
        const [plain] = await svc.runScript(id, sql, { readOnly: false }).catch((err: Error) => [{ error: { message: err.message } }] as never)
        if (plain?.error && NOT_FOUND.test(plain.error.message)) continue
        reached++
        const refused = await svc.runScript(id, sql, { readOnly: true }).then(() => false, () => true)
        if (!refused) missed.push(sql)
      }
      console.log(`${driver}: ${all.length} spellings, ${reached} reach the function on the server, ${missed.length} not refused`)
      expect(missed.slice(0, 10)).toEqual([])
      if (all.length) expect(reached).toBeGreaterThan(0)
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

    // MySQL and MariaDB: no file appeared in the server's file folder during any of the above (INTO OUTFILE has no
    // server-side stop in a read-only transaction). Needs the server's container to list the folder.
    it.skipIf(!files)("no file appeared in the server's file folder", () => {
      expect(files!.list()).toBe(filesBefore)
      expect(files!.list()).not.toMatch(/dbm_/)
    })
  })
}

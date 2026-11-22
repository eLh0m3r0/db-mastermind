import { describe, expect, it } from 'vitest'
import { conditionVerdict, isReadOnlyCondition, isReadOnlyScript, lex, readVerdict, tokenStatements, type DriverId } from '../src/index.js'

// Review round 2 (C1): SQL nobody confirmed that the old lexer read as one harmless SELECT.
export const C1: [DriverId, string][] = [
  ['postgres', "SELECT $é$ ' $é$; COMMIT; DELETE FROM t; --'"],
  ['postgres', "SELECT $é$ ' $é$; COMMIT; SET default_transaction_read_only = off; COMMIT; DELETE FROM t; --'"],
  ['mssql', "SELECT 1 /* /* */ ' */ COMMIT DELETE FROM t --'"],
  ['postgres', "SELECT 1 /* /* */ ' */; DELETE FROM t --'"],
  ['mysql', "SELECT 'x' /*! INTO OUTFILE '/var/lib/mysql-files/x' */"],
  ['mariadb', "SELECT 'x' /*!50000 INTO OUTFILE '/tmp/y' */"],
  ['oracle', "SELECT q'[ ' ]' FROM dual; DELETE FROM t; SELECT ' ' FROM dual"],
]

describe('the tokenizer reads quotes and comments as each server does', () => {
  it('the review inputs split where the server splits them', () => {
    const counts = C1.map(([d, s]) => {
      const r = lex(s, d)
      return r.ok ? tokenStatements(s, r.tokens, d).length : -1
    })
    expect(counts).toEqual([3, 5, 1, 2, 1, 1, 3])
  })

  it('refuses what it cannot read completely', () => {
    for (const [d, s] of [['postgres', "SELECT 'a"], ['postgres', 'SELECT /* /* */ 1'], ['mssql', 'SELECT [a'], ['mysql', "SELECT 'a\\'"], ['postgres', 'SELECT $x$ a'], ['mysql', 'SELECT /*! 1'], ['bigquery', 'SELECT /* /* */ 1'], ['postgres', "SELECT '\u0000'"]] as [DriverId, string][]) {
      expect(lex(s, d).ok, `${d}: ${s}`).toBe(false)
    }
  })

  it('MySQL: -- is a comment only before a space; # is one; /*! is code', () => {
    const kinds = (s: string) => {
      const r = lex(s, 'mysql')
      return r.ok ? r.tokens.filter((t) => t.kind !== 'space').map((t) => t.kind) : r.reason
    }
    expect(kinds('1--1')).toEqual(['number', 'op', 'op', 'number'])
    expect(kinds('1 -- c')).toEqual(['number', 'comment'])
    expect(kinds('1 # c')).toEqual(['number', 'comment'])
    expect(kinds('/*!40101 SET x = 1 */')).toEqual(['code-open', 'word', 'word', 'op', 'number', 'code-close'])
  })
})

describe('SQL nobody confirmed', () => {
  it('the review inputs are refused, each with a reason', () => {
    for (const [d, s] of C1) {
      const v = readVerdict(s, d)
      expect(v.ok, `${d}: ${s}`).toBe(false)
      expect(v.reason).toBeTruthy()
    }
    expect(isReadOnlyCondition("$é$ ) ' $é$ = '' ) ; COMMIT ; DELETE FROM t ; --'", 'postgres')).toBe(false)
    expect(isReadOnlyCondition("1=1 /* /* */ ' */ ) DELETE FROM t --'", 'mssql')).toBe(false)
  })

  it('only what reads may start a statement; transaction control, SET, COPY, CALL and the like never pass', () => {
    const refused: [DriverId, string][] = [
      ['postgres', 'COMMIT'], ['postgres', 'END'], ['postgres', 'SET default_transaction_read_only = off'], ['postgres', 'RESET ALL'], ['postgres', "COPY t TO '/tmp/x'"], ['postgres', 'CALL p()'], ['postgres', 'DO $$ BEGIN END $$'],
      ['postgres', 'PREPARE p AS SELECT 1'], ['postgres', 'EXECUTE p'], ['postgres', 'LOCK t'], ['postgres', 'SELECT * FROM t FOR UPDATE'], ['postgres', 'SELECT 1 INTO x'], ['postgres', 'EXPLAIN ANALYZE DELETE FROM t'],
      ['postgres', 'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d'], ['mysql', "SELECT 1 INTO OUTFILE '/tmp/x'"], ['mysql', "LOAD DATA INFILE 'x' INTO TABLE t"], ['mysql', 'HANDLER t OPEN'], ['mysql', 'REPLACE INTO t VALUES (1)'],
      ['mssql', 'SELECT 1 DELETE FROM t'], ['mssql', 'SET NOCOUNT ON'], ['mssql', 'BEGIN TRAN SELECT 1'], ['mssql', 'sp_who'], ['mssql', "EXEC('DELETE FROM t')"], ['mssql', 'WAITFOR DELAY \'00:10\''],
      ['sqlite', 'PRAGMA journal_mode = DELETE'], ['sqlite', 'PRAGMA optimize'], ['sqlite', "ATTACH 'x.db' AS x"], ['oracle', 'BEGIN NULL; END;'], ['duckdb', "COPY t TO 'x.csv'"],
    ]
    for (const [d, s] of refused) expect(isReadOnlyScript(s, d), `${d}: ${s}`).toBe(false)
  })

  it('reads stay allowed', () => {
    const allowed: [DriverId, string][] = [
      ['postgres', 'SELECT 1'], ['postgres', 'WITH a AS (SELECT 1) SELECT * FROM a'], ['postgres', 'TABLE t'], ['postgres', 'VALUES (1)'], ['postgres', 'SHOW search_path'], ['postgres', 'EXPLAIN SELECT 1'], ['postgres', 'EXPLAIN ANALYZE SELECT 1'],
      ['postgres', "SELECT CASE WHEN a THEN 'x' END, replace(name, 'a', 'b') FROM t"], ['postgres', '(SELECT 1) UNION (SELECT 2)'], ['postgres', "SELECT $é$ ' $é$"], ['mysql', 'SHOW TABLES'], ['mysql', 'DESCRIBE t'], ['mysql', "SELECT 'a\\'b'"],
      ['mssql', 'DECLARE @x int = 1; SELECT @x'], ['mssql', 'SET @x = 2 SELECT @x'], ['mssql', 'IF EXISTS (SELECT 1) SELECT 2'], ['sqlite', 'PRAGMA table_info(t)'], ['sqlite', 'PRAGMA main.table_info(t)'], ['duckdb', 'FROM t'], ['oracle', "SELECT q'[it's]' FROM dual"],
    ]
    for (const [d, s] of allowed) expect(readVerdict(s, d), `${d}: ${s}`).toMatchObject({ ok: true })
  })

  it('a filter is one condition', () => {
    expect(conditionVerdict("name = 'x' AND (a > 1)", 'postgres')).toEqual({ ok: true })
    for (const c of ['1=1) OR (1=1', "1=1; DELETE FROM t", "a = 'x", '1=1 /*! OR 1 */']) expect(conditionVerdict(c, c.includes('/*!') ? 'mysql' : 'postgres').ok, c).toBe(false)
  })
})

describe('review round 3', () => {
  it("MariaDB's /*M! … */ is code, and any /*x comment is refused on the guarded path", () => {
    const k = lex("SELECT 'x' /*M! INTO OUTFILE '/tmp/a' */", 'mariadb')
    expect(k.ok && k.tokens.some((t) => t.kind === 'code-open')).toBe(true)
    for (const s of ["SELECT 'x' /*M! INTO @v */", "SELECT 'x' /*M!100000 FOR UPDATE */", 'SELECT 1 /*M!*/', 'SELECT 1 /*!*/']) expect(readVerdict(s, 'mariadb').ok, s).toBe(false)
    for (const d of ['postgres', 'mssql', 'oracle', 'sqlite', 'duckdb', 'mysql'] as DriverId[]) expect(readVerdict('SELECT 1 /*x anything */', d).ok, d).toBe(false)
    expect(readVerdict('SELECT 1 /* a note */', 'postgres').ok).toBe(true)
    expect(readVerdict('SELECT 1 /** a note */', 'postgres').ok).toBe(true)
  })

  it('MySQL and MariaDB: OUTFILE, DUMPFILE and LOAD_FILE are refused anywhere, also in strings and comments', () => {
    for (const s of ["SELECT 'outfile'", 'SELECT 1 -- dumpfile', "SELECT LOAD_FILE('/etc/passwd')", 'SELECT `OutFile` FROM t']) {
      expect(readVerdict(s, 'mysql').reason, s).toMatch(/OUTFILE, DUMPFILE and LOAD_FILE/)
      expect(readVerdict(s, 'mariadb', { profile: 'user' }).reason, s).toMatch(/This connection is read-only/)
    }
  })

  it('functions with effects a read-only transaction does not stop are refused by name, qualified and quoted too', () => {
    const refused: [DriverId, string][] = [
      ['postgres', 'SELECT pg_terminate_backend(123)'], ['postgres', 'SELECT pg_catalog.pg_cancel_backend(1)'], ['postgres', `SELECT "pg_read_file"('/etc/passwd')`], ['postgres', "SELECT pg_ls_dir('.')"],
      ['postgres', 'SELECT pg_advisory_lock(1)'], ['postgres', 'SELECT pg_try_advisory_xact_lock(1)'], ['postgres', 'SELECT lo_import(\'/etc/passwd\')'], ['postgres', "SELECT dblink_exec('x', 'DELETE FROM t')"],
      ['postgres', "SELECT pg_notify('c', 'x')"], ['postgres', "SELECT set_config('default_transaction_read_only', 'off', false)"], ['postgres', 'SELECT pg_sleep(100)'], ['postgres', "SELECT query_to_xml('select 1', true, true, '')"],
      ['duckdb', "SELECT getenv('HOME')"], ['mysql', "SELECT GET_LOCK('a', 1)"], ['mariadb', 'SELECT sleep(10)'], ['mysql', 'SELECT BENCHMARK(100000000, md5(1))'],
      ['mssql', "SELECT * FROM OPENROWSET('x', 'y', 'z')"], ['mssql', 'SELECT NEXT VALUE FOR dbo.s'], ['mssql', "SELECT * FROM sys.fn_xe_file_target_read_file('x', null, null, null)"], ['mssql', 'xp_cmdshell'],
      ['oracle', "SELECT UTL_HTTP.REQUEST('http://x') FROM dual"], ['oracle', 'SELECT DBMS_LOCK.SLEEP(10) FROM dual'], ['oracle', "SELECT HTTPURITYPE('http://x').getclob() FROM dual"], ['oracle', 'SELECT * FROM t FOR UPDATE'],
      ['clickhouse', "SELECT * FROM file('x.csv')"], ['clickhouse', "SELECT * FROM url('http://x', CSV)"], ['clickhouse', "SELECT * FROM remote('h', db.t)"], ['clickhouse', "SELECT * FROM s3('https://x')"],
      ['sqlite', "SELECT load_extension('x')"], ['trino', "SELECT * FROM TABLE(system.query(query => 'DELETE FROM t'))"],
    ]
    for (const [d, s] of refused) expect(readVerdict(s, d).ok, `${d}: ${s}`).toBe(false)
    // Names that only look alike are no calls.
    expect(readVerdict('SELECT url, file, remote FROM t', 'clickhouse').ok).toBe(true)
    expect(readVerdict('SELECT sleep FROM t', 'mysql').ok).toBe(true)
  })

  it('the user profile: harmless session statements of each database, nothing that weakens the guard', () => {
    const user = (s: string, d: DriverId) => readVerdict(s, d, { profile: 'user' })
    for (const [d, s] of [
      ['postgres', 'SET search_path TO app, public'], ['postgres', 'SET statement_timeout = 5000'], ['postgres', 'SET SESSION work_mem TO \'64MB\''], ['postgres', 'SET TIME ZONE \'UTC\''], ['postgres', 'RESET search_path'], ['postgres', 'SET enable_seqscan = off'], ['postgres', 'SET LOCAL lock_timeout = 1000'],
      ['mysql', 'USE shop'], ['mysql', 'SET @a = 1, @b = 2'], ['mysql', 'SET NAMES utf8mb4'], ['mysql', 'SELECT count(*) INTO @n FROM t'],
      ['mssql', 'USE shop; SELECT 1'], ['mssql', 'SET NOCOUNT ON; SELECT 1'], ['mssql', 'SET ANSI_WARNINGS OFF'], ['mssql', 'DECLARE @x int; SET @x = 41; SELECT @x + 1'], ['mssql', 'SELECT * INTO #t FROM s.x; SELECT * FROM #t'], ['mssql', 'INSERT INTO #t VALUES (1); UPDATE #t SET a = 2; DELETE FROM #t'],
    ] as [DriverId, string][]) expect(user(s, d), `${d}: ${s}`).toMatchObject({ ok: true })
    expect(user('SET search_path TO app', 'postgres').statements[0]).toMatchObject({ session: true })
    expect(user('SET LOCAL lock_timeout = 1000', 'postgres').statements[0]!.session).toBeUndefined()
    for (const [d, s] of [
      ['postgres', 'SET default_transaction_read_only = off'], ['postgres', 'SET transaction_read_only = off'], ['postgres', 'SET ROLE admin'], ['postgres', 'SET SESSION AUTHORIZATION admin'], ['postgres', 'RESET ALL'], ['postgres', 'SET session_replication_role = replica'],
      ['mysql', 'SET sql_mode = \'ANSI_QUOTES\''], ['mysql', 'SET @@global.read_only = 0'], ['mysql', 'SET autocommit = 1'], ['mysql', 'SELECT 1 INTO OUTFILE \'/tmp/x\''],
      ['mssql', 'SET IMPLICIT_TRANSACTIONS ON'], ['mssql', 'INSERT INTO dbo.t VALUES (1)'], ['mssql', 'SELECT * INTO dbo.copy FROM t'], ['mssql', 'UPDATE dbo.t SET a = 1'],
      ['duckdb', 'SET enable_external_access = true'],
    ] as [DriverId, string][]) {
      const v = user(s, d)
      expect(v.ok, `${d}: ${s}`).toBe(false)
      expect(v.reason, `${d}: ${s}`).toMatch(/This connection is read-only:/)
    }
    // The agent profile takes none of them.
    for (const [d, s] of [['postgres', 'SET search_path TO app'], ['mysql', 'USE shop'], ['mssql', 'SET NOCOUNT ON; SELECT 1'], ['mssql', 'SELECT * INTO #t FROM x']] as [DriverId, string][]) expect(readVerdict(s, d).ok, `${d}: ${s}`).toBe(false)
  })

  it('SQL Server batches are planned and run whole', () => {
    expect(readVerdict('DECLARE @x int; SET @x = 41; SELECT @x + 1', 'mssql').statements).toHaveLength(1)
    expect(readVerdict('SELECT 1\nGO\nSELECT 2', 'mssql').statements).toHaveLength(2)
  })
})

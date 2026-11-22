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

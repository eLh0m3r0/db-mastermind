import { describe, expect, it } from 'vitest'
import {
  changesSchema,
  classifyStatement,
  isDangerousStatement,
  isReadOnlyCondition,
  isReadOnlyScript,
  splitStatements,
  statementAtOffset,
} from '../src/index.js'

const texts = (script: string, driver: Parameters<typeof splitStatements>[1], batchesOnly = false) =>
  splitStatements(script, driver, { batchesOnly }).map((s) => s.text)

describe('splitStatements', () => {
  it('splits on semicolons and ignores ones in strings and comments', () => {
    const script = `select 'a;b' as x; -- c;omment\nselect "q;" from t /* ; */;\n\nselect 3`
    expect(texts(script, 'postgres')).toEqual([`select 'a;b' as x`, `-- c;omment\nselect "q;" from t /* ; */`, 'select 3'])
  })

  it('handles postgres dollar quoting and nested comments', () => {
    const script = `create function f() returns int as $body$ begin return 1; end; $body$ language plpgsql;
/* outer /* inner; */ still; */ select 1;`
    const parts = texts(script, 'postgres')
    expect(parts).toHaveLength(2)
    expect(parts[0]).toContain('$body$ language plpgsql')
    expect(parts[1]).toContain('select 1')
  })

  it('does not treat $1 parameters as dollar quotes', () => {
    expect(texts('select $1; select $2', 'postgres')).toEqual(['select $1', 'select $2'])
  })

  it('handles BEGIN ATOMIC function bodies', () => {
    const script = `create function f() returns int language sql begin atomic select 1; select case when true then 2 end; end; select 2;`
    expect(texts(script, 'postgres')).toHaveLength(2)
  })

  it('handles SQLite triggers', () => {
    const script = `create trigger tr after insert on t begin update t set a = 1; insert into log values (1); end; select 1;`
    expect(texts(script, 'sqlite')).toEqual([
      'create trigger tr after insert on t begin update t set a = 1; insert into log values (1); end',
      'select 1',
    ])
  })

  it('supports the MySQL DELIMITER command and backslash escapes', () => {
    const script = `select 'it\\'s;';\nDELIMITER //\ncreate procedure p() begin select 1; select 2; end//\nDELIMITER ;\nselect 3;`
    expect(texts(script, 'mysql')).toEqual([`select 'it\\'s;'`, 'create procedure p() begin select 1; select 2; end', 'select 3'])
  })

  it('splits T-SQL on GO lines and bracket identifiers', () => {
    const script = `select [a;b] from t;\nselect 1\ngo\nselect 2\nGO\n`
    expect(texts(script, 'mssql')).toEqual(['select [a;b] from t', 'select 1', 'select 2'])
    expect(texts(script, 'mssql', true)).toEqual(['select [a;b] from t;\nselect 1', 'select 2'])
  })

  it('handles Oracle PL/SQL blocks terminated by a slash line', () => {
    const script = `select 1 from dual;\ncreate or replace procedure p as\nbegin\n  null;\nend;\n/\nbegin\n  p;\nend;\n/\nselect 2 from dual`
    expect(texts(script, 'oracle')).toEqual([
      'select 1 from dual',
      'create or replace procedure p as\nbegin\n  null;\nend;',
      'begin\n  p;\nend;',
      'select 2 from dual',
    ])
  })

  it('keeps offsets aligned with the source', () => {
    const script = '  select 1;\n\n  select 2  ;'
    const [a, b] = splitStatements(script, 'postgres')
    expect(script.slice(a!.start, a!.start + a!.text.length)).toBe('select 1')
    expect(script.slice(b!.start, b!.start + b!.text.length)).toBe('select 2')
  })

  it('drops comment-only statements', () => {
    expect(texts('-- nothing\n;\n/* x */;', 'postgres')).toEqual([])
  })
})

describe('statementAtOffset', () => {
  const script = 'select 1;\nselect 2;\n\nselect 3'
  it('finds the statement under the cursor', () => {
    expect(statementAtOffset(script, 12, 'postgres')?.text).toBe('select 2')
    expect(statementAtOffset(script, script.length, 'postgres')?.text).toBe('select 3')
  })
  it('a cursor right after the semicolon belongs to the previous statement', () => {
    expect(statementAtOffset(script, 9, 'postgres')?.text).toBe('select 1')
  })
})

describe('classifyStatement', () => {
  it.each([
    ['select * from t', 'read'],
    ['  (select 1)', 'read'],
    ['/* hi */ SELECT 1', 'read'],
    ['with x as (select 1) select * from x', 'read'],
    ['with x as (delete from t returning *) select * from x', 'write'],
    ["select 'delete from x'", 'read'],
    ['select * into new_t from t', 'write'],
    ['explain select 1', 'read'],
    ['explain analyze delete from t', 'write'],
    ['insert into t values (1)', 'write'],
    ['drop table t', 'ddl'],
    ['begin', 'transaction'],
    ['begin try select 1 end try', 'other'],
    ['pragma table_info(t)', 'read'],
    ['pragma journal_mode = wal', 'write'],
    ['pragma journal_mode', 'read'],
    ['pragma journal_mode(wal)', 'write'],
    ['pragma user_version(5)', 'write'],
    ['PRAGMA main.user_version = 5', 'write'],
    ['pragma main.table_info("users")', 'read'],
    ['pragma foreign_key_list(orders)', 'read'],
    ['pragma integrity_check', 'read'],
    ['pragma optimize', 'write'],
    ['pragma incremental_vacuum', 'write'],
    ['pragma wal_checkpoint(truncate)', 'write'],
    ['declare @x int = 1', 'read'],
    ['declare cur cursor for select * from t', 'read'],
    ['DECLARE n NUMBER; BEGIN DELETE FROM t; END;', 'other'],
  ])('%s → %s', (sql, kind) => {
    expect(classifyStatement(sql)).toBe(kind)
  })

  it('read-only scripts must contain only reads', () => {
    expect(isReadOnlyScript('select 1; select 2', 'postgres')).toBe(true)
    expect(isReadOnlyScript('select 1; delete from t', 'postgres')).toBe(false)
  })

  it('T-SQL: a write or COMMIT after a SELECT without a semicolon is not a read', () => {
    expect(isReadOnlyScript('SELECT 1 DELETE FROM t', 'mssql')).toBe(false)
    expect(isReadOnlyScript('select * from t update t set a = 1', 'mssql')).toBe(false)
    expect(isReadOnlyScript('SELECT 1 COMMIT', 'mssql')).toBe(false)
    expect(isReadOnlyScript('SELECT 1 EXEC sp_who', 'mssql')).toBe(false)
    expect(isReadOnlyScript("SELECT REPLACE(name, 'a', 'b'), [update], 'delete' FROM [dbo].[insert] WITH (NOLOCK)", 'mssql')).toBe(true)
    expect(isReadOnlyScript('SELECT create_date, updated_at FROM sys.objects', 'mssql')).toBe(true)
    // Elsewhere statements end with semicolons, and column names may be keywords.
    expect(isReadOnlyScript('SELECT update_count, "delete" FROM t', 'postgres')).toBe(true)
  })

  it('a filter condition is one condition that reads', () => {
    expect(isReadOnlyCondition("status = 'open' AND id IN (SELECT order_id FROM items)", 'postgres')).toBe(true)
    expect(isReadOnlyCondition("name = 'a; delete from t'", 'postgres')).toBe(true)
    expect(isReadOnlyCondition('1=1); DELETE FROM t; --', 'postgres')).toBe(false)
    expect(isReadOnlyCondition('1=1) DELETE FROM t --', 'mssql')).toBe(false)
    expect(isReadOnlyCondition('1=1); PRAGMA user_version = 5; --', 'sqlite')).toBe(false)
  })

  it('flags dangerous statements', () => {
    expect(isDangerousStatement('delete from t')).toBe(true)
    expect(isDangerousStatement('delete from t where id = 1')).toBe(false)
    expect(isDangerousStatement("update t set a = 'where'")).toBe(true)
    expect(isDangerousStatement('drop table x')).toBe(true)
  })
})

describe('changesSchema', () => {
  it('finds DDL anywhere in a batch, not only as the first word', () => {
    expect(changesSchema('CREATE TABLE t (id int)')).toBe(true)
    expect(changesSchema('SET XACT_ABORT ON; BEGIN TRANSACTION; CREATE TABLE [dbo].[t] ([id] int); COMMIT TRANSACTION;')).toBe(true)
    expect(changesSchema('-- migration\nALTER TABLE t ADD c int')).toBe(true)
    expect(changesSchema("EXEC sp_rename 'dbo.t', 't2'")).toBe(true)
    expect(changesSchema("COMMENT ON TABLE t IS 'x'")).toBe(true)
  })
  it('ignores reads and words inside strings or comments', () => {
    expect(changesSchema('SELECT * FROM t')).toBe(false)
    expect(changesSchema("SELECT 'drop table x' AS s")).toBe(false)
    expect(changesSchema('SELECT 1 -- create later')).toBe(false)
    expect(changesSchema('UPDATE t SET a = 1 WHERE id = 2')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import {
  classifyStatement,
  isDangerousStatement,
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
    ['declare @x int = 1', 'read'],
  ])('%s → %s', (sql, kind) => {
    expect(classifyStatement(sql)).toBe(kind)
  })

  it('read-only scripts must contain only reads', () => {
    expect(isReadOnlyScript('select 1; select 2', 'postgres')).toBe(true)
    expect(isReadOnlyScript('select 1; delete from t', 'postgres')).toBe(false)
  })

  it('flags dangerous statements', () => {
    expect(isDangerousStatement('delete from t')).toBe(true)
    expect(isDangerousStatement('delete from t where id = 1')).toBe(false)
    expect(isDangerousStatement("update t set a = 'where'")).toBe(true)
    expect(isDangerousStatement('drop table x')).toBe(true)
  })
})

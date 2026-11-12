import { describe, expect, it } from 'vitest'
import { createScript, getDialect, parseDbml, translateDefault, translateTables, translateType } from '../src/index.js'

describe('type translation', () => {
  it('maps common types between databases', () => {
    expect(translateType('boolean', 'mssql')).toBe('bit')
    expect(translateType('BOOLEAN', 'oracle')).toBe('NUMBER(1)')
    expect(translateType('jsonb', 'mysql')).toBe('json')
    expect(translateType('VARCHAR', 'mssql')).toBe('nvarchar(255)')
    expect(translateType('character varying(200)', 'mssql')).toBe('nvarchar(200)')
    expect(translateType('nvarchar(max)', 'postgres')).toBe('text')
    expect(translateType('uniqueidentifier', 'postgres')).toBe('uuid')
    expect(translateType('datetime2', 'mysql')).toBe('datetime')
    expect(translateType('decimal(12,2)', 'oracle')).toBe('decimal(12,2)')
    expect(translateType('geometry', 'mssql')).toBe('geometry')
  })

  it("turns PostgreSQL's serial into an identity integer for other databases", () => {
    const { tables } = parseDbml('Table t {\n  id bigserial [pk]\n  n serial\n  s smallserial\n}\n')
    for (const to of ['mysql', 'mssql', 'oracle'] as const) {
      const out = translateTables(tables, to, 'postgres')[0]!.columns
      // (These number one column per table: the key's.)
      expect(out.filter((c) => c.isIdentity).map((c) => c.name), to).toEqual(['id'])
      expect(out.map((c) => c.dataType).join(' '), to).not.toMatch(/serial/i)
      expect(createScript(tables, getDialect(to), { translateTypes: true, from: 'postgres' }), to).not.toMatch(/serial/i)
    }
    expect(translateTables(tables, 'mysql', 'postgres')[0]!.columns.map((c) => c.dataType)).toEqual(['bigint', 'integer', 'smallint'])
    expect(translateTables(tables, 'postgres', 'postgres')[0]!.columns[0]!.dataType).toBe('bigserial')
  })

  it('keeps a PostgreSQL model creatable in MySQL and SQL Server', () => {
    const { tables } = parseDbml(
      "Table t {\n  id integer [pk]\n  line bigserial\n  opens \"time with time zone\"\n  code \"character(512)\"\n  huge varchar(20000)\n  n serial\n  a varchar(4000)\n  b varchar(4000)\n  c varchar(4000)\n  d varchar(4000)\n  e varchar(4000)\n  day date [default: `current_date`]\n\n  checks {\n    `day <= current_date` [name: 'not_future']\n    `id > 0` [name: 'positive']\n  }\n}\n",
    )
    const my = translateTables(tables, 'mysql', 'postgres')[0]!
    const type = (name: string) => my.columns.find((c) => c.name === name)!.dataType
    expect([type('opens'), type('code'), type('huge')]).toEqual(['time', 'varchar(512)', 'mediumtext'])
    // Wider than 65,535 bytes: the longest strings become TEXT until the row fits.
    expect(my.columns.reduce((n, c) => n + (/^varchar\((\d+)\)$/.exec(c.dataType) ? Number(/\d+/.exec(c.dataType)![0]) * 4 + 2 : 8), 0)).toBeLessThanOrEqual(65535)
    expect(my.indexes.find((i) => i.columns[0] === 'line')).toMatchObject({ unique: true, constraint: true })
    expect(createScript(tables, getDialect('mysql'), { translateTypes: true, from: 'postgres' })).toMatch(/CREATE TABLE[^;]*UNIQUE \(`line`\)/)
    expect(my.checks!.map((c) => c.name)).toEqual(['positive'])
    expect(my.columns.find((c) => c.name === 'day')!.defaultValue).toBe('(CURRENT_DATE)')
    const ms = translateTables(tables, 'mssql', 'postgres')[0]!
    expect(my.columns.filter((c) => c.isIdentity).map((c) => c.name)).toEqual(['line'])
    expect(ms.columns.find((c) => c.name === 'huge')!.dataType).toBe('nvarchar(max)')
    expect([ms.columns.find((c) => c.name === 'opens')!.dataType, ms.columns.find((c) => c.name === 'day')!.defaultValue, ms.checks!.map((c) => c.expression)]).toEqual(['time', 'CAST(GETDATE() AS date)', ['day <= CAST(GETDATE() AS date)', 'id > 0']])
    expect(translateTables(tables, 'oracle', 'postgres')[0]!.checks!.map((c) => c.name)).toEqual(['positive'])
  })

  it('leaves the types of the model\'s own database as written', () => {
    expect(translateType('json', 'postgres', 'postgres')).toBe('json')
    expect(translateType('timestamp', 'mysql', 'mysql')).toBe('timestamp')
    expect(translateType('varchar(50)', 'mssql', 'mssql')).toBe('varchar(50)')
    expect(translateType('int(11)', 'mariadb', 'mysql')).toBe('int(11)')
    // Types no version of the database has are translated even so (DeZign's database-independent names).
    expect(translateType('int64', 'mssql', 'mssql')).toBe('bigint')
    expect(translateType('string(80)', 'mssql', 'mssql')).toBe('nvarchar(80)')
    const { tables } = parseDbml('Table t {\n  id integer [pk]\n  meta json\n  at timestamp [default: `now()`]\n}', {})
    expect(createScript(tables, getDialect('postgres'), { translateTypes: true, from: 'postgres' })).toContain('"meta" json,')
    expect(createScript(tables, getDialect('postgres'), { translateTypes: true })).toContain('"meta" jsonb,')
  })

  it('translates the spellings only one database has', () => {
    expect(translateType('NUMBER(9)', 'postgres')).toBe('integer')
    expect(translateType('number(12)', 'postgres')).toBe('bigint')
    expect(translateType('NUMBER(10,2)', 'mysql')).toBe('numeric(10,2)')
    expect(translateType('number', 'postgres')).toBe('numeric')
    expect(translateType('NUMBER(9)', 'oracle')).toBe('NUMBER(9)')
    expect(translateType('int(11)', 'postgres')).toBe('integer')
    expect(translateType('bigint(20) unsigned', 'postgres')).toBe('bigint')
    expect(translateType('mediumint', 'mssql')).toBe('int')
    expect(translateType('tinyint(1)', 'postgres')).toBe('boolean')
    expect(translateType("enum('a','b')", 'postgres')).toBe('varchar(255)')
    expect(translateType("enum('a','b')", 'mariadb')).toBe("enum('a','b')")
    expect(translateType('memo', 'postgres')).toBe('text')
    expect(translateType('money', 'mysql')).toBe('decimal(19,4)')
    expect(translateType('binary(16)', 'postgres')).toBe('bytea')
    // A flag kept as 0/1 gets a real boolean default; a one-digit number that defaults to 2 was never a flag.
    const { tables } = parseDbml('Table t {\n  done "tinyint(1)" [default: 0]\n  role "number(1)" [default: 2]\n}', {})
    const sql = createScript(tables, getDialect('postgres'), { translateTypes: true })
    expect(sql).toContain('"done" boolean DEFAULT false')
    expect(sql).toContain('"role" smallint DEFAULT 2')
  })

  it('maps timestamp and boolean defaults', () => {
    expect(translateDefault('now()', 'mssql')).toBe('SYSDATETIME()')
    expect(translateDefault("CAST('f' AS BOOLEAN)", 'mssql')).toBe('0')
    expect(translateDefault('true', 'postgres')).toBe('true')
    expect(translateDefault("'paid'", 'mssql')).toBe("'paid'")
  })

  it('writes a PostgreSQL-flavoured model as valid SQL Server DDL', () => {
    const { tables } = parseDbml('Table t {\n  id integer [pk, increment]\n  vip boolean [default: false]\n  meta jsonb\n  created timestamptz [default: `now()`]\n}', {})
    const sql = createScript(tables, getDialect('mssql'), { translateTypes: true })
    expect(sql).toContain('[vip] bit DEFAULT 0')
    expect(sql).toContain('[meta] nvarchar(max)')
    expect(sql).toContain('[created] datetimeoffset DEFAULT SYSDATETIME()')
  })
})

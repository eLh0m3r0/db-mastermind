import { describe, expect, it } from 'vitest'
import { createScript, getDialect, parseDbml, translateDefault, translateType } from '../src/index.js'

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

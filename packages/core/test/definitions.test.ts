import { describe, expect, it } from 'vitest'
import { definitionSupport, tableDefinition, withLeadingCreate, type TableInfo } from '../src/index.js'

describe('withLeadingCreate', () => {
  it('rewrites the first CREATE after comments and keeps an existing OR REPLACE / OR ALTER', () => {
    expect(withLeadingCreate('CREATE VIEW v AS SELECT 1', 'CREATE OR REPLACE')).toBe('CREATE OR REPLACE VIEW v AS SELECT 1')
    expect(withLeadingCreate('-- note\n/* block */\n  create procedure p as select 1', 'CREATE OR ALTER')).toBe('-- note\n/* block */\n  CREATE OR ALTER procedure p as select 1')
    expect(withLeadingCreate('CREATE OR ALTER VIEW v AS SELECT 1', 'CREATE OR ALTER')).toBe('CREATE OR ALTER VIEW v AS SELECT 1')
    expect(withLeadingCreate('CREATE OR REPLACE VIEW v AS SELECT 1', 'CREATE OR REPLACE')).toBe('CREATE OR REPLACE VIEW v AS SELECT 1')
  })

  it('leaves text without a leading CREATE alone (a CREATE further in is not touched)', () => {
    expect(withLeadingCreate('SELECT 1 -- CREATE', 'CREATE OR REPLACE')).toBe('SELECT 1 -- CREATE')
    expect(withLeadingCreate('CREATED_AT', 'CREATE OR REPLACE')).toBe('CREATED_AT')
  })
})

describe('tableDefinition', () => {
  it('says it is generated and creates the table with its key', () => {
    const table: TableInfo = {
      schema: 'shop',
      name: 'customers',
      type: 'table',
      columns: [
        { name: 'id', ordinal: 1, dataType: 'integer', nullable: false, isPrimaryKey: true, isIdentity: false },
        { name: 'email', ordinal: 2, dataType: 'varchar(200)', nullable: true, isPrimaryKey: false, isIdentity: false },
      ],
      primaryKey: ['id'],
      foreignKeys: [],
      indexes: [{ name: 'customers_email_idx', columns: ['email'], unique: false, primary: false }],
    }
    const sql = tableDefinition(table, 'postgres')
    expect(sql.split('\n')[0]).toMatch(/^-- Generated from the catalog/)
    expect(sql).toContain('CREATE TABLE "shop"."customers"')
    expect(sql).toMatch(/PRIMARY KEY/)
    expect(sql).toContain('customers_email_idx')
  })
})

describe('definitionSupport', () => {
  it('offers routines only where the database keeps their source', () => {
    expect(definitionSupport('postgres')).toEqual({ views: true, routines: true })
    expect(definitionSupport('sqlite')).toEqual({ views: true, routines: false })
  })
})

import { describe, expect, it } from 'vitest'
import { sqlFunctions, tablesInScope, type DriverId, type SchemaSnapshot, type TableInfo } from '../src/index.js'

const col = (name: string) => ({ name, dataType: 'text', ordinal: 0, nullable: true, isPrimaryKey: false, isIdentity: false })
const table = (schema: string | undefined, name: string, columns: string[]): TableInfo => ({ schema, name, type: 'table', columns: columns.map(col), primaryKey: [], foreignKeys: [], indexes: [] })
const pg: SchemaSnapshot = {
  defaultSchema: 'public',
  schemas: ['public', 'dbo'],
  tables: [table('dbo', 'akce', ['id', 'nazev', 'datum']), table('public', 'osoby', ['id', 'jmeno'])],
  routines: [],
  capturedAt: '',
}
const sqlite: SchemaSnapshot = { defaultSchema: 'main', schemas: ['main'], tables: [table('main', 'items', ['id', 'title'])], routines: [], capturedAt: '' }

const scope = (sql: string, snapshot = pg, driver: DriverId = 'postgres') => {
  const pos = sql.indexOf('|')
  return tablesInScope(sql.replace('|', ''), pos, driver, snapshot).map((r) => `${r.table.name}${r.alias ? ` ${r.alias}` : ''}`)
}

describe('sqlFunctions', () => {
  it('PostgreSQL: the whole pg_catalog, with signatures and descriptions', () => {
    const fns = sqlFunctions('postgres')
    const random = fns.find((f) => f.name === 'random')
    expect(random?.signatures).toContain('() → double precision')
    expect(random?.doc).toBe('random value')
    for (const name of ['now', 'date_trunc', 'jsonb_build_object', 'string_agg', 'generate_series', 'gen_random_uuid', 'regexp_replace', 'to_char', 'pg_size_pretty', 'to_date', 'to_timestamp', 'to_number', 'chr', 'ascii', 'coalesce', 'greatest']) {
      expect(fns.some((f) => f.name === name), name).toBe(true)
    }
    expect(fns.find((f) => f.name === 'count')?.kind).toBe('aggregate')
    expect(fns.find((f) => f.name === 'row_number')?.kind).toBe('window')
    // Machinery nobody types.
    for (const name of ['int4larger', 'binary_upgrade_set_next_pg_type_oid', 'float8_accum', 'pg_stat_get_numscans', 'textin', 'int4']) {
      expect(fns.some((f) => f.name === name), name).toBe(false)
    }
    expect(new Set(fns.map((f) => f.name)).size).toBe(fns.length)
  })

  it('other engines', () => {
    expect(sqlFunctions('sqlite').some((f) => f.name === 'random')).toBe(true)
    expect(sqlFunctions('duckdb').find((f) => f.name === 'random')?.doc).toMatch(/random/i)
    expect(sqlFunctions('mysql').some((f) => f.name === 'rand')).toBe(true)
    expect(sqlFunctions('mssql').find((f) => f.name === 'newid')?.signatures).toEqual(['()'])
    expect(sqlFunctions('mssql').find((f) => f.name === 'string_agg')?.kind).toBe('aggregate')
    for (const d of ['oracle', 'clickhouse', 'bigquery', 'trino'] as DriverId[]) expect(sqlFunctions(d).length).toBeGreaterThan(30)
  })
})

describe('tablesInScope: columns completed without a qualifier', () => {
  it('the statement under the cursor, wherever the cursor is', () => {
    expect(scope('SELECT | FROM dbo.akce')).toEqual(['akce'])
    expect(scope('SELECT * FROM dbo.akce a WHERE |')).toEqual(['akce a'])
    expect(scope('SELECT * FROM dbo.akce ORDER BY |')).toEqual(['akce'])
    expect(scope('SELECT * FROM dbo.akce a JOIN osoby o ON o.id = a.id WHERE |')).toEqual(['akce a', 'osoby o'])
    expect(scope('SELECT 1;\nSELECT * FROM osoby WHERE |;\nSELECT * FROM dbo.akce')).toEqual(['osoby'])
  })

  it('UPDATE, INSERT, DELETE', () => {
    expect(scope('UPDATE osoby SET |')).toEqual(['osoby'])
    expect(scope('INSERT INTO osoby (|')).toEqual(['osoby'])
    expect(scope('DELETE FROM dbo.akce WHERE |')).toEqual(['akce'])
  })

  it('SQLite (the column called id)', () => {
    expect(scope('select * from items where i|', sqlite, 'sqlite')).toEqual(['items'])
    expect(scope('select i| from items', sqlite, 'sqlite')).toEqual(['items'])
  })

  it('CTEs and unknown tables are left out', () => {
    expect(scope('WITH osoby AS (SELECT 1 AS x) SELECT | FROM osoby')).toEqual([])
    expect(scope('SELECT | FROM nowhere')).toEqual([])
  })
})

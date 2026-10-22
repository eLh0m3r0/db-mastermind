import { describe, expect, it } from 'vitest'
import { bindParameters, extractParameters, mssqlDialect, mysqlDialect, postgresDialect } from '../src/index.js'

describe('query parameters', () => {
  it('finds named parameters outside strings, comments and casts', () => {
    const sql = `select :id, ':not', "x:y", amount::numeric -- :comment\nfrom t where a = :id and b = :name /* :c */`
    expect(extractParameters(sql, 'postgres').map((p) => [p.name, p.occurrences.length])).toEqual([
      ['id', 2],
      ['name', 1],
    ])
  })

  it('treats ? and $n positionally where the database has no meaning for them', () => {
    expect(extractParameters('select ? , ?', 'mysql').map((p) => p.name)).toEqual(['1', '2'])
    expect(extractParameters('select $1, $2, $1', 'postgres').map((p) => [p.name, p.occurrences.length])).toEqual([
      ['1', 2],
      ['2', 1],
    ])
    expect(extractParameters("select $$ :x $$, $tag$ ? $tag$", 'postgres')).toEqual([])
  })

  it('binds values to native placeholders', () => {
    expect(bindParameters('select * from t where a = :a and b = :b or a = :a', 'postgres', postgresDialect, { a: '1', b: null })).toEqual({
      sql: 'select * from t where a = $1 and b = $2 or a = $3',
      params: ['1', null, '1'],
    })
    expect(bindParameters('select :x, @local', 'mssql', mssqlDialect, { x: 'v' })).toEqual({ sql: 'select @p1, @local', params: ['v'] })
    expect(bindParameters('select ?', 'mysql', mysqlDialect, { $1: '5' })).toEqual({ sql: 'select ?', params: ['5'] })
    expect(() => bindParameters('select :x', 'postgres', postgresDialect, {})).toThrow(/Missing value/)
  })
})

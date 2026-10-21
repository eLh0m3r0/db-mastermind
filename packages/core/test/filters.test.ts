import { describe, expect, it } from 'vitest'
import {
  buildCount,
  buildSelect,
  countActiveConditions,
  FilterError,
  mssqlDialect,
  mysqlDialect,
  postgresDialect,
  sqliteDialect,
  type FilterNode,
} from '../src/index.js'

const now = new Date(2026, 9, 22, 15, 30) // Thursday 22 Oct 2026

const tree: FilterNode = {
  kind: 'group',
  id: 'root',
  combinator: 'and',
  children: [
    { kind: 'condition', id: 'a', column: 'name', operator: 'contains', value: '50%_off' },
    {
      kind: 'group',
      id: 'g',
      combinator: 'or',
      children: [
        { kind: 'condition', id: 'b', column: 'status', operator: 'in', values: ['new', 'paid'] },
        { kind: 'condition', id: 'c', column: 'total', operator: 'gt', value: '1000' },
      ],
    },
    { kind: 'condition', id: 'd', column: 'deleted_at', operator: 'is_null' },
    { kind: 'condition', id: 'e', column: 'ignored', operator: 'eq', value: 'x', enabled: false },
  ],
}

describe('buildSelect', () => {
  it('renders nested groups with postgres placeholders', () => {
    const q = buildSelect(
      { table: { schema: 'public', name: 'orders' }, filter: tree, sort: [{ column: 'id', direction: 'desc' }], limit: 100, offset: 200 },
      postgresDialect,
    )
    expect(q.sql).toBe(
      `SELECT * FROM "public"."orders" WHERE ("name"::text ILIKE $1 ESCAPE '!' AND ("status" IN ($2, $3) OR "total" > $4) AND "deleted_at" IS NULL) ORDER BY "id" DESC LIMIT 100 OFFSET 200`,
    )
    expect(q.params).toEqual(['%50!%!_off%', 'new', 'paid', '1000'])
  })

  it('uses OFFSET/FETCH with a stable fallback order on SQL Server', () => {
    const q = buildSelect({ table: { schema: 'dbo', name: 'Orders' }, limit: 50, offset: 0 }, mssqlDialect)
    expect(q.sql).toBe('SELECT * FROM [dbo].[Orders] ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 50 ROWS ONLY')
  })

  it('escapes T-SQL bracket patterns in LIKE', () => {
    const q = buildSelect(
      {
        table: { name: 't' },
        filter: { kind: 'condition', id: 'x', column: 'c', operator: 'starts_with', value: '[a]' },
        limit: 1,
      },
      mssqlDialect,
    )
    expect(q.params).toEqual(['![a]%'])
    expect(q.sql).toContain('CAST([c] AS NVARCHAR(MAX)) LIKE @p1')
  })

  it('uses ? placeholders on MySQL and SQLite', () => {
    const filter: FilterNode = { kind: 'condition', id: 'x', column: 'a', operator: 'between', value: '1', value2: '5' }
    expect(buildSelect({ table: { name: 't' }, filter, limit: 10 }, mysqlDialect).sql).toBe(
      'SELECT * FROM `t` WHERE `a` BETWEEN ? AND ? LIMIT 10',
    )
    expect(buildSelect({ table: { name: 't' }, filter, limit: 10 }, sqliteDialect).sql).toBe(
      'SELECT * FROM "t" WHERE "a" BETWEEN ? AND ? LIMIT 10',
    )
  })

  it('treats NULL as different for neq / not_contains / not_in', () => {
    const q = buildSelect(
      { table: { name: 't' }, filter: { kind: 'condition', id: 'x', column: 'a', operator: 'neq', value: '1' }, limit: 1 },
      postgresDialect,
    )
    expect(q.sql).toContain('("a" <> $1 OR "a" IS NULL)')
  })

  it('renders relative date ranges from a fixed clock', () => {
    const filter: FilterNode = {
      kind: 'group',
      id: 'g',
      combinator: 'or',
      children: [
        { kind: 'condition', id: 'a', column: 'd', operator: 'this_week' },
        { kind: 'condition', id: 'b', column: 'd', operator: 'last_n_days', value: '7' },
        { kind: 'condition', id: 'c', column: 'd', operator: 'this_month' },
      ],
    }
    const q = buildSelect({ table: { name: 't' }, filter, limit: 1, now }, postgresDialect)
    expect(q.params).toEqual(['2026-10-19', '2026-10-26', '2026-10-15', '2026-10-23', '2026-10-01', '2026-11-01'])
  })

  it('negates groups and passes raw SQL through', () => {
    const filter: FilterNode = {
      kind: 'group',
      id: 'g',
      combinator: 'and',
      negate: true,
      children: [
        { kind: 'raw', id: 'r', sql: 'a > b' },
        { kind: 'condition', id: 'c', column: 'flag', operator: 'is_true' },
      ],
    }
    expect(buildSelect({ table: { name: 't' }, filter, limit: 1 }, mysqlDialect).sql).toBe(
      'SELECT * FROM `t` WHERE NOT ((a > b) AND `flag` = 1) LIMIT 1',
    )
  })

  it('rejects unknown columns when the schema is known', () => {
    expect(() =>
      buildSelect(
        {
          table: { name: 't' },
          filter: { kind: 'condition', id: 'x', column: 'nope', operator: 'eq', value: '1' },
          limit: 1,
          knownColumns: ['a'],
        },
        postgresDialect,
      ),
    ).toThrow(FilterError)
    expect(() =>
      buildSelect({ table: { name: 't' }, sort: [{ column: 'x; drop', direction: 'asc' }], limit: 1, knownColumns: ['a'] }, postgresDialect),
    ).toThrow(FilterError)
  })

  it('quotes identifiers safely', () => {
    const q = buildSelect({ table: { schema: 'we"ird', name: 'ta]b`le' }, limit: 1 }, postgresDialect)
    expect(q.sql).toBe('SELECT * FROM "we""ird"."ta]b`le" LIMIT 1')
    expect(buildSelect({ table: { name: 'ta]b`le' }, limit: 1 }, mssqlDialect).sql).toContain('[ta]]b`le]')
    expect(buildSelect({ table: { name: 'ta]b`le' }, limit: 1 }, mysqlDialect).sql).toContain('`ta]b``le`')
  })

  it('regex is unsupported on SQL Server', () => {
    expect(() =>
      buildSelect(
        { table: { name: 't' }, filter: { kind: 'condition', id: 'x', column: 'a', operator: 'regex', value: '^a' }, limit: 1 },
        mssqlDialect,
      ),
    ).toThrow(/not supported/)
  })

  it('empty in-list matches nothing', () => {
    const q = buildSelect(
      { table: { name: 't' }, filter: { kind: 'condition', id: 'x', column: 'a', operator: 'in', values: [] }, limit: 1 },
      postgresDialect,
    )
    expect(q.sql).toContain('WHERE 1 = 0')
  })
})

describe('buildCount', () => {
  it('reuses the filter', () => {
    const q = buildCount({ table: { name: 'orders' }, filter: tree }, postgresDialect)
    expect(q.sql.startsWith('SELECT COUNT(*) AS count FROM "orders" WHERE (')).toBe(true)
    expect(q.params).toHaveLength(4)
  })
})

describe('countActiveConditions', () => {
  it('ignores disabled nodes', () => {
    expect(countActiveConditions(tree)).toBe(4)
  })
})

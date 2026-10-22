import { describe, expect, it } from 'vitest'
import { filterPrompt, sanitizeFilter, type TableInfo } from '../src/index.js'

const table: TableInfo = {
  name: 'orders',
  type: 'table',
  primaryKey: ['id'],
  foreignKeys: [],
  indexes: [],
  columns: [
    { name: 'id', ordinal: 1, dataType: 'int', nullable: false, isPrimaryKey: true, isIdentity: true },
    { name: 'Status', ordinal: 2, dataType: 'text', nullable: true, isPrimaryKey: false, isIdentity: false },
    { name: 'total', ordinal: 3, dataType: 'numeric', nullable: false, isPrimaryKey: false, isIdentity: false },
  ],
}

describe('AI filters', () => {
  it('describes columns and operators in the prompt', () => {
    const { system, prompt } = filterPrompt(table, 'big unpaid orders', new Date('2026-10-22'))
    expect(system).toContain('today is 2026-10-22')
    expect(system).toContain('last_n_days')
    expect(prompt).toContain('total numeric')
  })

  it('keeps valid conditions, fixes column case and drops inventions', () => {
    const f = sanitizeFilter(
      {
        combinator: 'and',
        children: [
          { column: 'status', operator: 'neq', value: 'paid' },
          { column: 'total', operator: 'gt', value: 1000 },
          { column: 'customer_name', operator: 'contains', value: 'x' },
          { column: 'total', operator: 'approximately', value: '5' },
          { combinator: 'or', children: [{ column: 'id', operator: 'in', values: [1, 2] }] },
        ],
      },
      table,
    )
    expect(f.children.map((c) => (c.kind === 'condition' ? `${c.column} ${c.operator} ${c.value ?? c.values?.join('|')}` : c.kind))).toEqual([
      'Status neq paid',
      'total gt 1000',
      'group',
    ])
  })

  it('wraps a single condition and rejects empty output', () => {
    expect(sanitizeFilter({ column: 'total', operator: 'is_null' }, table).children).toHaveLength(1)
    expect(() => sanitizeFilter({ children: [] }, table)).toThrow(/usable filter/)
  })
})

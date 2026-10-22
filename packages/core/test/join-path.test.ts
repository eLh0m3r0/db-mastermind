import { describe, expect, it } from 'vitest'
import { findJoinPath, joinPathSql, postgresDialect, type SchemaSnapshot, type TableInfo } from '../src/index.js'

const table = (name: string, fks: [string, string, string][] = []): TableInfo => ({
  schema: 'public',
  name,
  type: 'table',
  columns: [],
  primaryKey: ['id'],
  foreignKeys: fks.map(([col, refTable, refCol]) => ({ name: `${name}_${col}_fk`, columns: [col], refTable, refColumns: [refCol] })),
  indexes: [],
})

const snapshot: SchemaSnapshot = {
  schemas: ['public'],
  defaultSchema: 'public',
  capturedAt: '',
  routines: [],
  tables: [
    table('customers'),
    table('orders', [['customer_id', 'customers', 'id']]),
    table('order_items', [
      ['order_id', 'orders', 'id'],
      ['product_id', 'products', 'id'],
    ]),
    table('products', [['category_id', 'categories', 'id']]),
    table('categories'),
    table('islands'),
    table('user', [['customer_id', 'customers', 'id']]),
  ],
}

describe('join path', () => {
  it('walks foreign keys in both directions', () => {
    const path = findJoinPath(snapshot, { name: 'customers' }, { name: 'categories' })!
    expect(path.map((s) => `${s.from.name}>${s.to.name}${s.reverse ? '<' : ''}`)).toEqual([
      'customers>orders<',
      'orders>order_items<',
      'order_items>products',
      'products>categories',
    ])
    expect(joinPathSql(path, postgresDialect.quoteIdent, 'public')).toBe(
      [
        'SELECT *',
        'FROM customers c',
        'JOIN orders o ON o.customer_id = c.id',
        'JOIN order_items oi ON oi.order_id = o.id',
        'JOIN products p ON p.id = oi.product_id',
        'JOIN categories c2 ON c2.id = p.category_id',
      ].join('\n'),
    )
  })

  it('quotes reserved words', () => {
    const path = findJoinPath(snapshot, { name: 'user' }, { name: 'customers' })!
    expect(joinPathSql(path, postgresDialect.quoteIdent, 'public')).toBe('SELECT *\nFROM "user" u\nJOIN customers c ON c.id = u.customer_id')
  })

  it('returns null for unconnected tables and [] for the same table', () => {
    expect(findJoinPath(snapshot, { name: 'customers' }, { name: 'islands' })).toBeNull()
    expect(findJoinPath(snapshot, { name: 'orders' }, { name: 'orders' })).toEqual([])
    expect(findJoinPath(snapshot, { name: 'customers' }, { name: 'categories' }, 2)).toBeNull()
  })
})

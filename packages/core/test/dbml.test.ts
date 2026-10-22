import { describe, expect, it } from 'vitest'
import { compareSchemas, parseDbml, toDbml } from '../src/index.js'

const source = `
Project shop { database_type: 'PostgreSQL' }

// People who buy things
Table customers {
  id integer [pk, increment]
  email varchar(200) [unique, not null, note: 'Login, it\\'s unique']
  vip boolean [default: false]
  created_at timestamp [default: \`now()\`]
  Note: 'Customers'
}

Table shop.orders as O {
  id bigint [pk]
  customer_id integer [not null, ref: > customers.id]
  total "numeric(12, 2)" [not null]
  status varchar
  indexes {
    (status, id) [name: 'ix_orders_status']
  }
}

Table order_items {
  order_id bigint
  line int
  indexes {
    (order_id, line) [pk]
  }
}

Ref: order_items.order_id > O.id [delete: cascade]
Enum status { new paid shipped }
TableGroup sales { customers O }
`

describe('DBML', () => {
  it('parses tables, columns, keys, indexes, notes and references', () => {
    const { tables, enums, errors } = parseDbml(source, { defaultSchema: 'public' })
    expect(errors).toEqual([])
    expect(enums.status).toEqual(['new', 'paid', 'shipped'])
    const customers = tables.find((t) => t.name === 'customers')!
    expect(customers.schema).toBe('public')
    expect(customers.comment).toBe('Customers')
    expect(customers.columns.find((c) => c.name === 'id')).toMatchObject({ isPrimaryKey: true, isIdentity: true, nullable: false })
    expect(customers.columns.find((c) => c.name === 'email')).toMatchObject({ nullable: false, comment: "Login, it's unique" })
    expect(customers.columns.find((c) => c.name === 'created_at')!.defaultValue).toBe('now()')
    expect(customers.indexes.some((i) => i.unique && i.columns[0] === 'email')).toBe(true)
    const orders = tables.find((t) => t.name === 'orders')!
    expect(orders.schema).toBe('shop')
    expect(orders.columns.find((c) => c.name === 'total')!.dataType).toBe('numeric(12, 2)')
    expect(orders.foreignKeys[0]).toMatchObject({ columns: ['customer_id'], refTable: 'customers', refColumns: ['id'] })
    expect(orders.indexes.find((i) => i.name === 'ix_orders_status')!.columns).toEqual(['status', 'id'])
    const items = tables.find((t) => t.name === 'order_items')!
    expect(items.primaryKey).toEqual(['order_id', 'line'])
    expect(items.foreignKeys[0]).toMatchObject({ refSchema: 'shop', refTable: 'orders', onDelete: 'CASCADE' })
  })

  it('round-trips through toDbml without differences', () => {
    const first = parseDbml(source, { defaultSchema: 'public' }).tables
    const text = toDbml(first, { defaultSchema: 'public' })
    const second = parseDbml(text, { defaultSchema: 'public' })
    expect(second.errors).toEqual([])
    expect(compareSchemas(first, second.tables, { keepExtra: false })).toEqual([])
  })

  it('reports lines it cannot read', () => {
    const { errors } = parseDbml('Table t {\n  id\n}\nWhat is this', {})
    expect(errors.map((e) => e.line)).toEqual([2, 4])
  })
})

describe('DBML enums', () => {
  it('maps enum columns to a plain type and keeps the values in the comment', () => {
    const { tables } = parseDbml('Enum status { new paid }\nTable t {\n  s status [note: \'State\']\n}', { enumType: 'varchar(50)' })
    expect(tables[0]!.columns[0]).toMatchObject({ dataType: 'varchar(50)', comment: 'State. One of: new, paid' })
  })
})

import { describe, expect, it } from 'vitest'
import { parseDbml, toDbml, updateModelFromDatabase, type TableInfo } from '../src/index.js'

const model = () =>
  parseDbml(`
Table shop.customers {
  id bigserial [pk]
  email varchar(120) [not null, note: 'Login']
  country char(2) [domain: 'country_code']
  nickname text

  checks {
    \`email <> ''\`
  }

  Note: 'People who buy'
}
Table shop.orders {
  id bigserial [pk]
  customer_id bigint [not null, ref: > shop.customers.id]
}
Table shop.drafts {
  id int [pk]
}`).tables

// What a PostgreSQL connection reports for the same schema after a few changes made straight in the database.
const column = (name: string, dataType: string, more: Partial<TableInfo['columns'][number]> = {}) => ({ name, ordinal: 0, dataType, nullable: true, defaultValue: null, isPrimaryKey: false, isIdentity: false, comment: null, ...more })
const database = (): TableInfo[] => [
  {
    schema: 'shop',
    name: 'customers',
    type: 'table',
    comment: null,
    columns: [
      column('id', 'bigint', { nullable: false, isPrimaryKey: true, defaultValue: "nextval('shop.customers_id_seq'::regclass)" }),
      column('email', 'character varying(200)', { nullable: false }),
      column('country', 'character(2)'),
      column('vat_id', 'character varying(20)', { comment: 'Added by a hotfix' }),
    ],
    primaryKey: ['id'],
    foreignKeys: [],
    indexes: [
      { name: 'customers_pkey', columns: ['id'], unique: true, primary: true },
      { name: 'customers_email_key', columns: ['email'], unique: true, primary: false, constraint: true },
    ],
  },
  {
    schema: 'shop',
    name: 'orders',
    type: 'table',
    comment: 'Orders of the shop',
    columns: [column('id', 'bigint', { nullable: false, isPrimaryKey: true, defaultValue: "nextval('shop.orders_id_seq'::regclass)" }), column('customer_id', 'bigint', { nullable: false })],
    primaryKey: ['id'],
    foreignKeys: [{ name: 'orders_customer_id_fkey', columns: ['customer_id'], refSchema: 'shop', refTable: 'customers', refColumns: ['id'], onDelete: 'CASCADE' }],
    indexes: [{ name: 'orders_pkey', columns: ['id'], unique: true, primary: true }],
  },
  { schema: 'shop', name: 'payments', type: 'table', comment: null, columns: [column('id', 'bigint', { nullable: false, isPrimaryKey: true }), column('order_id', 'bigint')], primaryKey: ['id'], foreignKeys: [{ name: 'payments_order_fk', columns: ['order_id'], refSchema: 'shop', refTable: 'orders', refColumns: ['id'] }], indexes: [] },
  { schema: 'shop', name: 'v_open', type: 'view', comment: null, columns: [column('id', 'bigint')], primaryKey: [], foreignKeys: [], indexes: [] },
]

describe('updating a model from a database', () => {
  it('takes what the database has and keeps what only the model knows', () => {
    const { tables, summary } = updateModelFromDatabase(model(), database())
    expect(tables.map((t) => t.name)).toEqual(['customers', 'orders', 'drafts', 'payments'])
    const [customers, orders] = tables
    expect(customers!.columns.map((c) => `${c.name} ${c.dataType}${c.nullable ? '' : ' nn'}${c.domain ? ` @${c.domain}` : ''}${c.comment ? ` #${c.comment}` : ''}`)).toEqual([
      // The model's spelling of a serial key stays; the widened column follows the database and keeps its comment.
      'id bigserial nn',
      'email character varying(200) nn #Login',
      'country char(2) @country_code',
      'vat_id character varying(20) #Added by a hotfix',
    ])
    expect(customers!.comment).toBe('People who buy')
    expect(customers!.checks).toEqual([{ expression: "email <> ''" }])
    expect(customers!.indexes.filter((ix) => !ix.primary).map((ix) => `${ix.unique ? 'unique ' : ''}${ix.columns}`)).toEqual(['unique email'])
    expect(orders!.comment).toBe('Orders of the shop')
    expect(orders!.foreignKeys).toEqual([{ name: 'fk_orders_customer_id', columns: ['customer_id'], refSchema: 'shop', refTable: 'customers', refColumns: ['id'], onDelete: 'CASCADE' }])
    expect(summary).toEqual({ tablesAdded: 1, tablesRemoved: 0, columnsAdded: 1, columnsRemoved: 1, columnsChanged: 1, relationshipsChanged: 0, indexesChanged: 1 })
    // The result is a valid model.
    expect(parseDbml(toDbml(tables)).errors).toEqual([])
  })

  it('removes tables the database does not have only when asked', () => {
    const { tables, summary } = updateModelFromDatabase(model(), database(), { removeMissing: true })
    expect(tables.map((t) => t.name)).toEqual(['customers', 'orders', 'payments'])
    expect(summary.tablesRemoved).toBe(1)
  })

  it('changes nothing when the model and the database agree', () => {
    const first = updateModelFromDatabase(model(), database()).tables
    const again = updateModelFromDatabase(first, database())
    expect(again.summary).toEqual({ tablesAdded: 0, tablesRemoved: 0, columnsAdded: 0, columnsRemoved: 0, columnsChanged: 0, relationshipsChanged: 0, indexesChanged: 0 })
    expect(toDbml(again.tables)).toBe(toDbml(first))
  })

  it('takes a column out of its domain when the database gave it another type', () => {
    const db = database()
    db[0]!.columns[2] = column('country', 'character varying(3)')
    const country = updateModelFromDatabase(model(), db).tables[0]!.columns[2]!
    expect(country.dataType).toBe('character varying(3)')
    expect(country.domain).toBeUndefined()
  })
})

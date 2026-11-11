import { describe, expect, it } from 'vitest'
import { compareSchemas, designFromDbml, diffTables, parseDbml, toDbml } from '../src/index.js'

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
    expect(parseDbml(source, { defaultSchema: 'public' }).groups).toEqual({ sales: ['customers', 'orders'] })
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

describe('toDbml with enums and groups', () => {
  it('round-trips enums and table groups', () => {
    const source = `Enum order_status {
  new
  "in progress"
  done
}

Table customers {
  id int [pk]
}

Table orders {
  id int [pk]
  status order_status [not null]
  customer_id int
}

Ref: orders.customer_id > customers.id

TableGroup Sales {
  customers
  orders
}
`
    const model = parseDbml(source)
    const text = toDbml(model.tables, { enums: model.enums, groups: model.groups })
    const again = parseDbml(text)
    expect(again.errors).toEqual([])
    expect(again.enums).toEqual({ order_status: ['new', 'in progress', 'done'] })
    expect(again.groups).toEqual({ Sales: ['customers', 'orders'] })
    expect(again.tables.find((t) => t.name === 'orders')!.columns.find((c) => c.name === 'status')!.dataType).toBe('order_status')
  })
})

describe('designFromDbml', () => {
  const live = parseDbml(`
Table customers {
  id int [pk, increment]
  email varchar(200) [not null, unique]
  created_at timestamp [default: \`now()\`]
}
Table orders {
  id int [pk]
  customer_id int [not null]
}
Table legacy {
  id int [pk]
}
Ref: orders.customer_id > customers.id
`).tables

  it('turns an AI reply into drafts that only add what changed', () => {
    const reply = `${toDbml(live.filter((t) => t.name === 'customers'))}`.replace('created_at', 'deleted_at timestamp\n  created_at') + '\n// drop table legacy\n'
    const fixed = reply.replace(/deleted_at timestamp\n  created_at timestamp/, 'deleted_at timestamp\n  created_at timestamp')
    const { drafts, errors } = designFromDbml(fixed, live)
    expect(errors).toEqual([])
    const changes = diffTables(live, Object.values(drafts))
    expect(changes.map((c) => `${c.kind}:${c.table.name}`).sort()).toEqual(['add_column:customers', 'drop_table:legacy'])
  })

  it('creates new tables with foreign keys to live ones', () => {
    const { drafts } = designFromDbml(`Table addresses {\n  id int [pk]\n  customer_id int [ref: > customers.id]\n}`, live)
    const changes = diffTables(live, Object.values(drafts))
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ kind: 'create_table', table: { name: 'addresses', foreignKeys: [{ refTable: 'customers' }] } })
  })

  it('keeps notes with line breaks, quotes and backslashes through a round trip', () => {
    const note = "0 = off;\n1 = on, it's {final}\nC:\\new [x]"
    const table = { schema: undefined, name: 't', type: 'table' as const, comment: `About\n${note}`, columns: [{ name: 'state', ordinal: 1, dataType: 'int', nullable: true, isPrimaryKey: false, isIdentity: false, comment: note }, { name: 'after', ordinal: 2, dataType: 'int', nullable: true, isPrimaryKey: false, isIdentity: false }], primaryKey: [], foreignKeys: [], indexes: [] }
    const dbml = toDbml([table])
    expect(dbml).toContain("note: '''0 = off;\n1 = on")
    const back = parseDbml(dbml)
    expect(back.errors).toEqual([])
    expect(back.tables[0]!.columns.map((c) => c.name)).toEqual(['state', 'after'])
    expect(back.tables[0]!.columns[0]!.comment).toBe(note)
    expect(back.tables[0]!.comment).toBe(`About\n${note}`)
    // Lines after a multi-line string keep their numbers.
    expect(parseDbml("Table t {\n  a int [note: '''one\ntwo\nthree''']\n  ???\n}").errors).toEqual([{ line: 5, message: "Can't read column: ???" }])
  })

  it('reads and writes check constraints', () => {
    const dbml = "Table products {\n  id int [pk]\n  price numeric(10,2) [not null, check: `price >= 0`]\n  stock int\n\n  checks {\n    `stock >= 0 and price < 1000000` [name: 'sane_values']\n    `stock < 5000`\n  }\n}"
    const model = parseDbml(dbml)
    expect(model.errors).toEqual([])
    expect(model.tables[0]!.checks).toEqual([{ expression: 'price >= 0' }, { expression: 'stock >= 0 and price < 1000000', name: 'sane_values' }, { expression: 'stock < 5000' }])
    const written = toDbml(model.tables)
    expect(written).toContain("  checks {\n    `price >= 0`\n    `stock >= 0 and price < 1000000` [name: 'sane_values']\n    `stock < 5000`\n  }")
    expect(parseDbml(written).tables[0]!.checks).toEqual(model.tables[0]!.checks)
  })

  it('expands TablePartial into the tables that use it', () => {
    const dbml = `
Table orders {
  id int [pk]
  ~audit
  note text
  created_by varchar(80) [note: 'own definition wins']
}
TablePartial audit {
  created_at timestamp [not null, default: \`now()\`]
  created_by int
  indexes {
    created_at
  }
}
Table customers {
  ~audit
  id int [pk]
  ~missing
}`
    const model = parseDbml(dbml)
    expect(model.errors).toEqual([{ line: 18, message: 'Unknown TablePartial: missing' }])
    expect(model.tables[0]!.columns.map((c) => `${c.ordinal} ${c.name} ${c.dataType}`)).toEqual(['1 id int', '2 created_at timestamp', '3 note text', '4 created_by varchar(80)'])
    expect(model.tables[0]!.indexes.filter((ix) => !ix.primary).map((ix) => ix.columns)).toEqual([['created_at']])
    expect(model.tables[1]!.columns.map((c) => c.name)).toEqual(['created_at', 'created_by', 'id'])
    expect(model.tables[1]!.columns[0]).toMatchObject({ nullable: false, defaultValue: 'now()' })
  })

  it('keeps the blocks it does not model when the model is written again', () => {
    const dbml = `Project shop {
  database_type: 'PostgreSQL'
  Note: '''
    Orders of the shop
    // not a comment
  '''
}

Table orders {
  id int [pk]
  ~audit
}

TablePartial audit {
  created_at timestamp
}

Records orders(id) {
  1
  2
}

Note reminder {
  'Ask about VAT'
}
`
    const model = parseDbml(dbml)
    expect(model.errors).toEqual([])
    expect(model.extras).toHaveLength(4)
    expect(model.extras[0]).toContain("    Orders of the shop\n    // not a comment")
    const written = toDbml(model.tables, { extras: model.extras })
    // The table now lists the partial's column itself; the blocks are there as written.
    expect(written).toContain('Table orders {\n  id int [pk]\n  created_at timestamp\n}')
    for (const extra of model.extras) expect(written).toContain(extra)
    const again = parseDbml(written)
    expect(again.errors).toEqual([])
    expect(again.extras).toEqual(model.extras)
    expect(again.tables[0]!.columns.map((c) => c.name)).toEqual(['id', 'created_at'])
  })

  it('keeps the domain a column follows as a custom setting', () => {
    const model = parseDbml("Table t {\n  code char(2) [not null, domain: 'country_code', note: 'ISO']\n}")
    expect(model.errors).toEqual([])
    expect(model.tables[0]!.columns[0]).toMatchObject({ dataType: 'char(2)', domain: 'country_code', comment: 'ISO', nullable: false })
    expect(toDbml(model.tables)).toContain("code char(2) [not null, domain: 'country_code', note: 'ISO']")
  })

  it('reads references between names with hyphens and spaces', () => {
    const dbml = `Table "user" {\n  "user-id" varchar(40) [pk]\n}\nTable appointment {\n  "app-id" varchar(40) [pk]\n  "user-id" varchar(40)\n  "booked - by" varchar(40)\n}\nRef: appointment."user-id" > "user"."user-id" [delete: cascade]\nRef: appointment."booked - by" - "user"."user-id"\nRef: appointment."app-id"`
    const model = parseDbml(dbml)
    expect(model.errors).toEqual([{ line: 11, message: `Can't read reference: appointment."app-id"` }])
    expect(model.tables[1]!.foreignKeys.map((f) => `${f.columns} > ${f.refTable}.${f.refColumns} ${f.onDelete ?? ''}`.trim())).toEqual(['user-id > user.user-id CASCADE', 'booked - by > user.user-id'])
    // And writes them so that they read back.
    const again = parseDbml(toDbml(model.tables))
    expect(again.errors).toEqual([])
    expect(again.tables[1]!.foreignKeys).toHaveLength(2)
  })
})

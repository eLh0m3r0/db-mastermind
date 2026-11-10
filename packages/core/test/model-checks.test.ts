import { describe, expect, it } from 'vitest'
import { checkModel, fixModelIssue, parseDbml, suggestRelationships, toDbml, typeFamily } from '../src/index.js'

const model = (dbml: string) => parseDbml(dbml).tables
const kinds = (dbml: string) => checkModel(model(dbml)).map((i) => `${i.kind} ${i.table}${i.column ? `.${i.column}` : ''}${i.detail ? ` → ${i.detail}` : ''}`)

describe('model checks', () => {
  it('finds nothing in a tidy model', () => {
    expect(
      kinds(`
Table customers {
  id int [pk]
  email varchar(120) [unique]
}
Table orders {
  id int [pk]
  customer_id int [not null, ref: > customers.id]
  indexes {
    customer_id
  }
}`),
    ).toEqual([])
  })

  it('reports tables without a key or without columns', () => {
    expect(kinds('Table log {\n  message text\n}\nTable empty {\n}')).toEqual(['no_primary_key log', 'no_columns empty'])
  })

  it('reports foreign keys that cannot work', () => {
    expect(
      kinds(`
Table customers {
  id int [pk]
  code varchar(10)
}
Table orders {
  id int [pk]
  customer_id varchar(36) [ref: > customers.id]
  customer_code varchar(10) [ref: > customers.code]
  indexes {
    customer_id
    customer_code
  }
}`),
    ).toEqual(['fk_type_mismatch orders.customer_id → varchar(36) ≠ customers.id int', 'fk_target_not_unique orders.customer_code → customers.code'])
    // DBML itself rejects a reference to a table that is not there; models from elsewhere can carry one.
    const loose = model('Table orders {\n  id int [pk]\n  shop_id int\n  indexes {\n    shop_id\n  }\n}')
    loose[0]!.foreignKeys.push({ name: 'fk', columns: ['shop_id'], refTable: 'shops', refColumns: ['id'] })
    expect(checkModel(loose).map((i) => `${i.kind} → ${i.detail}`)).toEqual(['fk_target_missing → shops.id'])
    // Names for the same values are not a mismatch.
    expect(typeFamily('BIGSERIAL')).toBe(typeFamily('bigint'))
    expect(typeFamily('character varying(40)')).toBe(typeFamily('nvarchar(80)'))
    expect(typeFamily('uuid')).not.toBe(typeFamily('varchar(36)'))
  })

  it('reports indexes that repeat each other and foreign keys without one, and fixes them', () => {
    const dbml = `
Table customers {
  id int [pk]
}
Table orders {
  id int [pk]
  customer_id int [ref: > customers.id]
  placed date
  indexes {
    placed [name: 'a']
    placed [name: 'b']
    (placed, id) [name: 'c']
    id [name: 'again']
  }
}`
    expect(kinds(dbml)).toEqual([
      'redundant_index orders.placed → c',
      'duplicate_index orders.placed → a',
      'duplicate_index orders.id → primary key',
      'fk_without_index orders.customer_id → customers',
    ])
    let tables = model(dbml)
    for (let i = 0; i < 6; i++) {
      const issue = checkModel(tables).find((x) => x.fixable)
      if (!issue) break
      tables = fixModelIssue(tables, issue)!
    }
    expect(checkModel(tables)).toEqual([])
    expect(tables[1]!.indexes.filter((ix) => !ix.primary).map((ix) => ix.columns.join(','))).toEqual(['placed,id', 'customer_id'])
    // The fixed model is still valid DBML.
    expect(parseDbml(toDbml(tables)).errors).toEqual([])
  })

  it('suggests relationships the names imply and adds them', () => {
    const tables = model(`
Table customers {
  id int [pk]
}
Table Party {
  PartyID int [pk]
}
Table products {
  id uuid [pk]
}
Table orders {
  id int [pk]
  customer_id int
  PartyID int
  product_id int
  note_id int
  created_by int
}`)
    const found = suggestRelationships(tables)
    // product_id has the wrong type for products.id; note_id and created_by name no table.
    expect(found.map((i) => `${i.table}.${i.column} → ${i.detail}`)).toEqual(['orders.customer_id → customers.id', 'orders.PartyID → Party.PartyID'])
    const fixed = fixModelIssue(tables, found[0]!)!
    expect(fixed[3]!.foreignKeys).toEqual([{ name: 'fk_orders_customer_id', columns: ['customer_id'], refSchema: undefined, refTable: 'customers', refColumns: ['id'] }])
    expect(suggestRelationships(fixed).map((i) => i.column)).toEqual(['PartyID'])
  })

  it('makes no guess when two tables fit a column equally', () => {
    expect(suggestRelationships(model('Table user {\n  id int [pk]\n}\nTable users {\n  id int [pk]\n}\nTable posts {\n  id int [pk]\n  user_id int\n}'))).toEqual([])
  })

  it('reports names that break the style nearly all others follow', () => {
    const dbml = `
Table order_items {
  id int [pk]
  order_id int
  unit_price int
  created_at date
  updated_at date
  productCode int
  note text
}
Table shop_orders {
  id int [pk]
  placed_at date
}
Table customer_addresses {
  id int [pk]
}
Table payment_methods {
  id int [pk]
}
Table price_lists {
  id int [pk]
}
Table tax_rates {
  id int [pk]
}
Table AuditLog {
  id int [pk]
}`
    expect(kinds(dbml).filter((k) => k.startsWith('naming'))).toEqual(['naming order_items.productCode → snake_case', 'naming AuditLog → snake_case'])
    // A model without a clear style is not judged.
    expect(kinds('Table a_b {\n  id int [pk]\n}\nTable CdEf {\n  id int [pk]\n}').filter((k) => k.startsWith('naming'))).toEqual([])
  })
})

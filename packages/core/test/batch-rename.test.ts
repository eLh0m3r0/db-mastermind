import { describe, expect, it } from 'vitest'
import { batchRename, renameInCondition, parseDbml, toDbml } from '../src/index.js'

const model = parseDbml(`Table shop.tbl_customer {
  id bigint [pk]
  cust_name text
  cust_email text [unique]
}
Table shop.tbl_invoice {
  id bigint [pk]
  cust_id bigint [ref: > shop.tbl_customer.id]
  total numeric(12,2)

  indexes {
    (cust_id, total) [name: 'ix_invoice_customer']
  }
  checks {
    \`total >= 0 and cust_id is not null\` [name: 'invoice_ok']
  }
}
Table shop.customer {
  id bigint [pk]
}
`).tables

describe('batch rename', () => {
  it('renames tables by a prefix and keeps the relationships pointing at them', () => {
    const { tables, renames } = batchRename(model, { find: 'tbl_', replace: '', scope: 'tables' })
    // tbl_customer → customer is taken by another table: left out; tbl_invoice → invoice is fine.
    expect(renames.map((r) => `${r.from}→${r.to}${r.skipped ? ` (${r.skipped})` : ''}`)).toEqual([
      'tbl_customer→customer (taken)',
      'tbl_invoice→invoice',
    ])
    expect(tables.map((t) => t.name)).toEqual(['tbl_customer', 'invoice', 'customer'])
    expect(tables[1]!.foreignKeys[0]!.refTable).toBe('tbl_customer')
  })

  it('renames columns everywhere they are named: keys, indexes, relationships at both ends, checks', () => {
    const { tables, renames } = batchRename(model, {
      find: '^cust_',
      replace: 'customer_',
      regex: true,
      scope: 'columns',
    })
    expect(renames.filter((r) => !r.skipped).map((r) => `${r.table}.${r.from}→${r.to}`)).toEqual([
      'tbl_customer.cust_name→customer_name',
      'tbl_customer.cust_email→customer_email',
      'tbl_invoice.cust_id→customer_id',
    ])
    const invoice = tables[1]!
    expect(invoice.foreignKeys[0]!.columns).toEqual(['customer_id'])
    expect(invoice.indexes.find((i) => i.name === 'ix_invoice_customer')!.columns).toEqual([
      'customer_id',
      'total',
    ])
    expect(invoice.checks![0]!.expression).toBe('total >= 0 and customer_id is not null')
    // Text in single quotes and function names are not column names.
    const quoted = parseDbml(
      "Table t {\n  kind text\n  total int\n\n  checks {\n    `kind in ('kind', 'other') and total(1) is null and \"kind\" <> ''` [name: 'k']\n  }\n}\n",
    ).tables
    expect(
      batchRename(quoted, { find: '^', replace: 'x_', regex: true, scope: 'columns' }).tables[0]!.checks![0]!
        .expression,
    ).toBe(`x_kind in ('kind', 'other') and total(1) is null and "x_kind" <> ''`)
    // Nor is anything in a comment (prose that happens to use the word).
    expect(
      renameInCondition('kind = 1 /* kind one */ or -- any kind\nkind = 2', (n) =>
        n === 'kind' ? 'x_kind' : undefined,
      ),
    ).toBe('x_kind = 1 /* kind one */ or -- any kind\nx_kind = 2')
    // The model reads back as written.
    expect(parseDbml(toDbml(tables)).errors).toEqual([])
  })

  it('renames a referenced column at the other end too, and leaves out empty names', () => {
    const { tables, renames } = batchRename(model, {
      find: 'id',
      replace: 'key',
      caseSensitive: true,
      scope: 'columns',
    })
    expect(tables[1]!.foreignKeys[0]!.refColumns).toEqual(['key'])
    expect(tables[0]!.primaryKey).toEqual(['key'])
    expect(batchRename(model, { find: 'total', replace: '', scope: 'columns' }).renames[0]!.skipped).toBe(
      'empty',
    )
    expect(renames.every((r) => r.kind === 'column')).toBe(true)
    // A broken regular expression renames nothing.
    expect(batchRename(model, { find: '(', replace: 'x', regex: true, scope: 'both' }).renames).toEqual([])
  })
})

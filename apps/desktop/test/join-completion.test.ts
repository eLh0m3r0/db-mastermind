import { EditorState } from '@codemirror/state'
import { CompletionContext } from '@codemirror/autocomplete'
import { describe, expect, it } from 'vitest'
import type { SchemaSnapshot, TableInfo } from '@dbmastermind/core/browser'
import { joinCompletionSource, referencedTables } from '../src/renderer/src/features/query/joinCompletion'

const col = (name: string) => ({ name, ordinal: 1, dataType: 'int', nullable: false, isPrimaryKey: name === 'id', isIdentity: false })
const table = (name: string, cols: string[], fks: TableInfo['foreignKeys'] = []): TableInfo => ({
  schema: 'public',
  name,
  type: 'table',
  columns: cols.map(col),
  primaryKey: ['id'],
  foreignKeys: fks,
  indexes: [],
})
const schema: SchemaSnapshot = {
  defaultSchema: 'public',
  schemas: ['public'],
  capturedAt: '',
  routines: [],
  tables: [
    table('customers', ['id', 'name']),
    table('orders', ['id', 'customer_id'], [{ name: 'fk1', columns: ['customer_id'], refSchema: 'public', refTable: 'customers', refColumns: ['id'] }]),
    table('order_items', ['order_id', 'product_id'], [{ name: 'fk2', columns: ['order_id'], refSchema: 'public', refTable: 'orders', refColumns: ['id'] }]),
  ],
}

const complete = (doc: string) => {
  const state = EditorState.create({ doc })
  const result = joinCompletionSource(() => schema, () => 'postgres')(new CompletionContext(state, doc.length, true))
  return result?.options.map((o) => o.label) ?? []
}

describe('join completion', () => {
  it('reads table references and aliases', () => {
    expect(referencedTables('select * from orders o join customers as c on true', schema).map((r) => [r.table.name, r.alias])).toEqual([
      ['orders', 'o'],
      ['customers', 'c'],
    ])
    expect(referencedTables('select * from public.orders where', schema).map((r) => r.alias)).toEqual(['orders'])
  })

  it('suggests related tables with the ON clause after JOIN', () => {
    expect(complete('select * from orders o join ')).toEqual(['customers c ON o.customer_id = c.id', 'order_items oi ON oi.order_id = o.id'])
  })

  it('suggests the condition after ON', () => {
    expect(complete('select * from customers c join orders o on ')).toEqual(['o.customer_id = c.id'])
  })

  it('stays quiet elsewhere', () => {
    expect(complete('select * from orders where ')).toEqual([])
  })
})

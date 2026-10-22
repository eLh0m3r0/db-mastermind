import { describe, expect, it } from 'vitest'
import { buildDataDictionary, renderMarkdown, type SchemaSnapshot } from '../src/index.js'

const snapshot: SchemaSnapshot = {
  schemas: ['shop'],
  capturedAt: '',
  routines: [],
  tables: [
    {
      schema: 'shop',
      name: 'orders',
      type: 'table',
      rowEstimate: 1200,
      columns: [
        { name: 'id', ordinal: 1, dataType: 'bigint', nullable: false, isPrimaryKey: true, isIdentity: true },
        { name: 'customer_id', ordinal: 2, dataType: 'int', nullable: false, isPrimaryKey: false, isIdentity: false, comment: 'Who | ordered' },
      ],
      primaryKey: ['id'],
      foreignKeys: [{ name: 'fk', columns: ['customer_id'], refSchema: 'shop', refTable: 'customers', refColumns: ['id'] }],
      indexes: [{ name: 'orders_customer_idx', columns: ['customer_id'], unique: false, primary: false }],
    },
    {
      schema: 'shop',
      name: 'customers',
      type: 'table',
      comment: 'People <who> buy',
      columns: [{ name: 'id', ordinal: 1, dataType: 'int', nullable: false, isPrimaryKey: true, isIdentity: true }],
      primaryKey: ['id'],
      foreignKeys: [],
      indexes: [],
    },
  ],
}

describe('data dictionary', () => {
  it('writes markdown with relationships both ways and escaped cells', () => {
    const md = buildDataDictionary(snapshot, { format: 'markdown', title: 'Shop', notes: new Map([['customers', [{ title: 'Customers', body: 'VIP after 10 orders.' }]]]) })
    expect(md).toContain('# Shop')
    expect(md.indexOf('## shop.customers')).toBeLessThan(md.indexOf('## shop.orders'))
    expect(md).toContain('FK → customers.id')
    expect(md).toContain('Who \\| ordered')
    expect(md).toMatch(/Referenced by\*\*\n\n- \[shop\.orders\]\(#t-shop-orders\) \(customer_id\)/)
    expect(md).toContain('VIP after 10 orders.')
    expect(md).toContain('~1,200 rows')
  })

  it('writes self-contained, escaped HTML', () => {
    const html = buildDataDictionary(snapshot, { format: 'html', schemas: ['shop'] })
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('People &lt;who&gt; buy')
    expect(html).toContain('href="#t-shop-customers"')
    expect(html).not.toMatch(/<script src=|<link /)
  })

  it('renders note markdown safely', () => {
    const html = renderMarkdown('# Title\n\n- **bold** and `code`\n- <img src=x onerror=alert(1)>\n\n```\nselect 1 < 2\n```\n[x](javascript:alert(1)) [ok](https://example.com)')
    expect(html).toContain('<h4>Title</h4>')
    expect(html).toContain('<li><strong>bold</strong> and <code>code</code></li>')
    expect(html).toContain('&lt;img')
    expect(html).toContain('select 1 &lt; 2')
    expect(html).not.toContain('href="javascript')
    expect(html).toContain('<a href="https://example.com">ok</a>')
  })
})

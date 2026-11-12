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

  it('makes a report as DeZign does: title page facts, chosen parts, the diagram, its color and order', () => {
    const model: SchemaSnapshot = { ...snapshot, tables: [{ ...snapshot.tables[0]!, todo: 'Split by year', labels: ['PII'], properties: { Owner: 'Sales' }, checks: [{ name: 'ck_id', expression: 'id > 0' }], remarks: 'Kept for 10 years' }, snapshot.tables[1]!] }
    const html = buildDataDictionary(model, { format: 'html', title: 'Shop', report: { author: 'Data team <x>', version: '1.2', description: 'For auditors', include: { indexes: false }, diagram: 'data:image/svg+xml;charset=utf-8,%3Csvg%3E', accent: '#cc0000', modelOrder: true } })
    expect(html).toContain('<td>Author</td><td>Data team &lt;x&gt;</td>')
    expect(html).toContain('<td>Version</td><td>1.2</td>')
    expect(html).toContain('For auditors')
    expect(html).toContain('<figure class="diagram"><img src="data:image/svg+xml;charset=utf-8,%3Csvg%3E"')
    expect(html).toContain(':root{--accent:#cc0000}')
    expect(html).not.toContain('<h3>Indexes</h3>')
    for (const part of ['<h3>Checks</h3>', '<h3>Notes</h3>', '<h3>Properties</h3>', '<h3>Labels</h3>', '<h3>To do</h3>']) expect(html).toContain(part)
    // The model's order: orders before customers.
    expect(html.indexOf('id="t-shop-orders"')).toBeLessThan(html.indexOf('id="t-shop-customers"'))
    // Not an image or a color that could carry anything else.
    const unsafe = buildDataDictionary(model, { format: 'html', report: { diagram: 'javascript:alert(1)', accent: 'red;}</style><script>' } })
    expect(unsafe).not.toContain('javascript:')
    expect(unsafe).not.toContain('<script>alert')
    expect(unsafe).not.toContain('--accent:red;')
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

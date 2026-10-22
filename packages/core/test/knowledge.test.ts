import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { KnowledgeBase, parseFrontMatter, parseRelation, staleKnowledge, withDocumentedRelations, type SchemaSnapshot } from '../src/index.js'

const dir = mkdtempSync(join(tmpdir(), 'dbm-kb-test-'))
mkdirSync(join(dir, 'sales'))
writeFileSync(
  join(dir, 'sales', 'orders.md'),
  `---\ntitle: Orders & invoices\ntables: [orders, invoices]\nrelations:\n  - orders.customer_code -> customers.code\n  - invoices(order_id) -> orders(id)\n---\n# Orders\nStatus P means paid.\n`,
)
writeFileSync(join(dir, 'README.md'), '# Overview\nThe ERP database.\n')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('knowledge base', () => {
  const kb = new KnowledgeBase(dir)

  it('parses front matter lists', () => {
    const { data, body } = parseFrontMatter('---\na: [x, "y"]\nb:\n  - one\n  - two # comment\nc: plain\n---\nBody')
    expect(data).toEqual({ a: ['x', 'y'], b: ['one', 'two'], c: 'plain' })
    expect(body).toBe('Body')
  })

  it('parses relation syntaxes', () => {
    expect(parseRelation('orders.customer_code -> customers.code', 'f')).toMatchObject({ fromTable: 'orders', fromColumns: ['customer_code'], toTable: 'customers', toColumns: ['code'] })
    expect(parseRelation('erp.lines(a, b) → erp.heads(x, y)', 'f')).toMatchObject({ fromTable: 'erp.lines', fromColumns: ['a', 'b'], toTable: 'erp.heads', toColumns: ['x', 'y'] })
    expect(parseRelation('nonsense', 'f')).toBeNull()
  })

  it('lists, reads and searches files', async () => {
    const files = await kb.list()
    expect(files.map((f) => f.path)).toEqual(['README.md', 'sales/orders.md'])
    expect(files[1]).toMatchObject({ title: 'Orders & invoices', tables: ['orders', 'invoices'] })
    const hits = await kb.search('paid status')
    expect(hits[0]?.path).toBe('sales/orders.md')
    expect((await kb.forTable('invoices')).map((d) => d.path)).toEqual(['sales/orders.md'])
  })

  it('refuses paths outside the folder', async () => {
    await expect(kb.read('../../etc/passwd')).rejects.toThrow(/outside/)
    await expect(kb.write('../escape.md', 'x')).rejects.toThrow(/outside/)
  })

  it('writes markdown files', async () => {
    expect(await kb.write('new/notes', '# Notes')).toBe('new/notes.md')
    expect((await kb.read('new/notes.md')).title).toBe('Notes')
  })

  it('adds documented relations as virtual foreign keys', async () => {
    const col = (name: string) => ({ name, ordinal: 1, dataType: 'text', nullable: true, isPrimaryKey: false, isIdentity: false })
    const table = (name: string, cols: string[]) => ({ schema: 'public', name, type: 'table' as const, columns: cols.map(col), primaryKey: [], foreignKeys: [], indexes: [] })
    const snapshot: SchemaSnapshot = {
      defaultSchema: 'public',
      schemas: ['public'],
      tables: [table('orders', ['id', 'customer_code']), table('customers', ['code']), table('invoices', ['order_id'])],
      routines: [],
      capturedAt: '',
    }
    const result = await withDocumentedRelations(snapshot, { id: 'x', name: 'x', driver: 'postgres', knowledgeBasePath: dir })
    const orders = result.tables.find((t) => t.name === 'orders')!
    expect(orders.foreignKeys).toEqual([expect.objectContaining({ columns: ['customer_code'], refTable: 'customers', refColumns: ['code'], virtual: true, refSchema: 'public' })])
    expect(result.tables.find((t) => t.name === 'invoices')!.foreignKeys[0]).toMatchObject({ refTable: 'orders', refColumns: ['id'] })
  })

  it('reports notes about tables and columns that no longer exist', async () => {
    const col = (name: string) => ({ name, ordinal: 1, dataType: 'text', nullable: true, isPrimaryKey: false, isIdentity: false })
    const snapshot: SchemaSnapshot = {
      schemas: [''],
      routines: [],
      capturedAt: '',
      tables: [
        { name: 'orders', type: 'table', columns: [col('id'), col('customer_ref')], primaryKey: [], foreignKeys: [], indexes: [] },
        { name: 'customers', type: 'table', columns: [col('code')], primaryKey: [], foreignKeys: [], indexes: [] },
      ],
    }
    const issues = await staleKnowledge(kb, snapshot)
    expect(issues.map((i) => i.message).sort()).toEqual([
      'Relationship invoices → orders: table invoices no longer exists',
      'Relationship orders → customers: column orders.customer_code no longer exists',
      'Table invoices no longer exists',
    ])
    expect(issues.every((i) => i.path === 'sales/orders.md')).toBe(true)
  })
})


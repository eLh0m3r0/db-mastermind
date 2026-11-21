import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { isDrawDb, modelFormatOf, parseDbml, readModelFile, tablesFromDrawDb, tablesFromMermaid, tablesFromMwb, toDbml, toMermaid, toPrisma } from '../src/index.js'

// Every fixture here is written by hand in the tool's format (other projects' files never go into the repository).

describe('Mermaid ER diagrams', () => {
  const DIAGRAM = `---
title: Shop
---
erDiagram
    %% customers and what they order
    direction LR
    CUSTOMER ||--o{ ORDER : places
    CUSTOMER {
        int id PK "the customer"
        string email UK
        varchar(120) name
    }
    ORDER {
        int id PK
        int customer_id FK
        decimal_10_2_ total
        timestamp_with_time_zone placed
    }
    ORDER ||--|{ LINE_ITEM : contains
    LINE_ITEM {
        int order_id PK, FK
        int line_no PK
    }
    "Product Group" {
        int id PK
    }
    LINE_ITEM }o--|| "Product Group" : "in group"
    PRODUCT }|..|{ "Product Group" : "belongs to"
    PERSON one or zero to only one PASSPORT : holds
    PERSON { int id PK }
`

  it('reads entities, attributes, keys and relationships', () => {
    const m = tablesFromMermaid(DIAGRAM)
    expect(m.tables.map((t) => t.name)).toEqual(['CUSTOMER', 'ORDER', 'LINE_ITEM', 'Product Group', 'PRODUCT', 'PERSON', 'PASSPORT'])
    const t = (n: string) => m.tables.find((x) => x.name === n)!
    expect(t('CUSTOMER').columns.map((c) => [c.name, c.dataType, c.isPrimaryKey, c.comment])).toEqual([
      ['id', 'integer', true, 'the customer'],
      ['email', 'text', false, null],
      ['name', 'varchar(120)', false, null],
    ])
    expect(t('CUSTOMER').indexes.find((i) => !i.primary)).toMatchObject({ columns: ['email'], unique: true })
    // What the app's own export mangles comes back: decimal(10,2), timestamp with time zone.
    expect(t('ORDER').columns.map((c) => c.dataType)).toEqual(['integer', 'integer', 'decimal(10,2)', 'timestamp with time zone'])
    // The child's FK column named after the parent's key.
    expect(t('ORDER').foreignKeys).toEqual([expect.objectContaining({ columns: ['customer_id'], refTable: 'CUSTOMER', refColumns: ['id'] })])
    expect(t('LINE_ITEM').primaryKey).toEqual(['order_id', 'line_no'])
    // `}|` on the child's side: one or more lines per order.
    expect(t('LINE_ITEM').foreignKeys.find((f) => f.refTable === 'ORDER')).toMatchObject({ columns: ['order_id'], cardinality: 'one-or-more' })
    // No column names the group: a new key column, as drawing the relationship adds it.
    expect(t('LINE_ITEM').columns.map((c) => c.name)).toContain('Product Group_id')
    expect(t('LINE_ITEM').foreignKeys.find((f) => f.refTable === 'Product Group')).toMatchObject({ columns: ['Product Group_id'], refColumns: ['id'] })
    // One-to-one in words: the right side holds the key, a new column for PERSON's; "only one" passport per person.
    expect(t('PASSPORT').foreignKeys).toEqual([expect.objectContaining({ columns: ['PERSON_id'], refTable: 'PERSON', cardinality: 'exactly-one' })])
    expect(m.leftOut).toEqual({ manyToMany: 1 })
  })

  it('reads ER diagrams in a Markdown file, and its own export back with the same columns', () => {
    const model = parseDbml('Table customers {\n  id integer [pk]\n  email "character varying(200)"\n}\nTable orders {\n  id bigint [pk]\n  buyer integer [ref: > customers.id]\n}\n')
    const md = `# Shop\n\nSome text.\n\n\`\`\`mermaid\n${toMermaid(model.tables)}\n\`\`\`\n`
    expect(modelFormatOf('README.md', md)).toBe('mermaid')
    const back = readModelFile('README.md', new TextEncoder().encode(md))
    expect(back.tables.map((t) => [t.name, t.columns.map((c) => `${c.name} ${c.dataType}`)])).toEqual([
      ['customers', ['id integer', 'email character varying(200)']],
      ['orders', ['id bigint', 'buyer integer']],
    ])
    // The label names the columns (the export writes them): `buyer`, not a new customers_id.
    expect(back.tables[1]!.foreignKeys).toEqual([expect.objectContaining({ columns: ['buyer'], refTable: 'customers', refColumns: ['id'] })])
    expect(() => tablesFromMermaid('# no diagram here')).toThrow(/erDiagram/)
  })

  it('counts a relationship to an entity without a key instead of making one up', () => {
    const m = tablesFromMermaid('erDiagram\n  A ||--o{ B : has\n')
    expect(m.tables.map((t) => t.name)).toEqual(['A', 'B'])
    expect(m.leftOut).toEqual({ relationshipsWithoutKey: 1 })
  })
})

describe('drawDB diagrams', () => {
  // A newer export: string ids, a relationship with two field pairs, enums, notes and a subject area.
  const NEWER = {
    title: 'Shop',
    database: 'postgresql',
    tables: [
      {
        id: 't-cust',
        name: 'customers',
        x: 100.4,
        y: 50,
        color: '#ff9159',
        comment: 'People',
        indices: [{ id: 0, name: 'customers_email_idx', unique: false, fields: ['email'] }],
        fields: [
          { id: 'f1', name: 'id', type: 'INTEGER', default: '', check: '', primary: true, unique: true, notNull: true, increment: true, comment: '' },
          { id: 'f2', name: 'email', type: 'VARCHAR', size: 200, default: '', check: '', primary: false, unique: true, notNull: true, increment: false, comment: 'Login' },
          { id: 'f3', name: 'status', type: 'STATUS', default: 'new', check: '', primary: false, unique: false, notNull: false, increment: false, comment: '' },
          { id: 'f4', name: 'credit', type: 'DECIMAL', size: '10,2', default: '0', check: 'credit >= 0', primary: false, unique: false, notNull: false, increment: false, comment: '' },
          { id: 'f5', name: 'created', type: 'TIMESTAMP', default: 'CURRENT_TIMESTAMP', check: '', primary: false, unique: false, notNull: false, increment: false, comment: '' },
        ],
      },
      {
        id: 't-ord',
        name: 'orders',
        x: 400,
        y: 80,
        color: '#175e7a',
        comment: '',
        indices: [],
        fields: [
          { id: 'o1', name: 'id', type: 'BIGINT', default: '', check: '', primary: true, unique: false, notNull: true, increment: true, comment: '' },
          { id: 'o2', name: 'customer_id', type: 'INTEGER', default: '', check: '', primary: false, unique: false, notNull: true, increment: false, comment: '' },
          { id: 'o3', name: 'cust_email', type: 'VARCHAR', size: 200, default: '', check: '', primary: false, unique: false, notNull: false, increment: false, comment: '' },
        ],
      },
    ],
    relationships: [
      { id: 'r1', name: 'fk_orders_customer', startTableId: 't-ord', startFieldId: 'o2', endTableId: 't-cust', endFieldId: 'f1', cardinality: 'many_to_one', updateConstraint: 'No action', deleteConstraint: 'Cascade' },
      { id: 'r2', name: '', startTableId: 't-ord', startFieldId: 'o2', endTableId: 't-cust', endFieldId: 'f1', fields: [{ startFieldId: 'o2', endFieldId: 'f1' }, { startFieldId: 'o3', endFieldId: 'f2' }], cardinality: 'one_to_one', updateConstraint: 'Cascade', deleteConstraint: 'Set null' },
      { id: 'r3', name: 'gone', startTableId: 't-ord', startFieldId: 'o2', endTableId: 't-missing', endFieldId: 'x', cardinality: 'many_to_one', updateConstraint: 'No action', deleteConstraint: 'No action' },
    ],
    notes: [{ id: 0, x: 10, y: 400, title: 'Todo', content: 'Add payments', color: '#fcf7ac', height: 88 }],
    subjectAreas: [{ id: 0, name: 'Sales', x: 50, y: 20, width: 700, height: 300, color: '#175e7a' }],
    enums: [{ name: 'status', values: ['new', 'paid'] }],
    types: [{ name: 'address', fields: [{ name: 'city', type: 'TEXT' }], comment: '' }],
  }
  // An older export: numeric ids, `references` and translated cardinality labels.
  const OLDER = {
    tables: [
      { id: 0, name: 'a', x: 0, y: 0, color: '#6360f7', comment: '', indices: [], fields: [{ id: 0, name: 'id', type: 'INT', default: '', check: '', primary: true, unique: false, notNull: true, increment: false, comment: '' }] },
      { id: 1, name: 'b', x: 300, y: 0, color: '#6360f7', comment: '', indices: [], fields: [{ id: 0, name: 'a_id', type: 'INT', default: 5, check: '', primary: false, unique: false, notNull: false, increment: false, comment: '' }] },
    ],
    references: [{ id: 0, name: 'b_a_id_fk', startTableId: 1, startFieldId: 0, endTableId: 0, endFieldId: 0, cardinality: 'One to one', updateConstraint: 'No action', deleteConstraint: 'Restrict' }],
    notes: [],
    areas: [],
  }

  it('reads tables, fields, indexes, relationships, enums and the diagram', () => {
    const text = JSON.stringify(NEWER)
    expect(isDrawDb(text)).toBe(true)
    expect(modelFormatOf('shop.json', text)).toBe('drawdb')
    const m = tablesFromDrawDb(text)
    expect(m.database).toBe('postgres')
    expect(m.enums).toEqual({ status: ['new', 'paid'] })
    const [customers, orders] = m.tables
    expect(customers!.columns.map((c) => [c.name, c.dataType, c.nullable, c.defaultValue, c.isIdentity])).toEqual([
      ['id', 'integer', false, null, true],
      ['email', 'varchar(200)', false, null, false],
      ['status', 'status', true, "'new'", false],
      ['credit', 'decimal(10,2)', true, '0', false],
      ['created', 'timestamp', true, 'CURRENT_TIMESTAMP', false],
    ])
    expect(customers!.comment).toBe('People')
    expect(customers!.checks).toEqual([{ expression: 'credit >= 0', column: 'credit' }])
    // A primary key that is also marked unique is no second index.
    expect(customers!.indexes.map((i) => [i.name, i.columns, i.unique])).toEqual([
      ['customers_pkey', ['id'], true],
      ['customers_email_key', ['email'], true],
      ['customers_email_idx', ['email'], false],
    ])
    expect(orders!.foreignKeys).toEqual([
      { name: 'fk_orders_customer', columns: ['customer_id'], refTable: 'customers', refColumns: ['id'], onDelete: 'CASCADE', onUpdate: undefined },
      { name: 'orders_customer_id_cust_email_fkey', columns: ['customer_id', 'cust_email'], refTable: 'customers', refColumns: ['id', 'email'], onDelete: 'SET NULL', onUpdate: 'CASCADE', cardinality: 'zero-or-one' },
    ])
    expect(m.leftOut).toEqual({ brokenRelationships: 1, customTypes: 1 })
    expect(m.positions).toEqual({ '.customers': { x: 100, y: 50 }, '.orders': { x: 400, y: 80 } })
    expect(m.colors).toEqual({ '.customers': '#ff9159', '.orders': '#175e7a' })
    expect(m.notes).toEqual([{ id: 'drawdb-note-0', text: 'Todo\nAdd payments', x: 10, y: 400 }])
    expect(m.boxes).toEqual([{ id: 'drawdb-area-0', title: 'Sales', x: 50, y: 20, w: 700, h: 300 }])
    // The model reads back from its DBML.
    expect(parseDbml(toDbml(m.tables, { enums: m.enums })).errors).toEqual([])
  })

  it('reads older exports, and leaves other JSON to be data', () => {
    const m = readModelFile('old.ddb', new TextEncoder().encode(JSON.stringify(OLDER)))
    expect(m.tables[1]!.foreignKeys).toEqual([{ name: 'b_a_id_fk', columns: ['a_id'], refTable: 'a', refColumns: ['id'], onDelete: 'RESTRICT', onUpdate: undefined, cardinality: 'zero-or-one' }])
    expect(m.tables[1]!.columns[0]!.defaultValue).toBe('5')
    expect(isDrawDb('[{"id": 1, "name": "x"}]')).toBe(false)
    expect(isDrawDb('{"tables": "nope"}')).toBe(false)
    expect(modelFormatOf('data.json', '{"rows": [1, 2]}')).toBeUndefined()
  })
})

/** A MySQL Workbench document the way Workbench writes one: GRT values, links by id. */
function workbenchModel(): Uint8Array {
  const v = (key: string, type: string, value: string | number) => `<value type="${type}" key="${key}">${value}</value>`
  const link = (key: string, id: string) => `<link type="object" struct-name="GrtObject" key="${key}">${id}</link>`
  const column = (id: string, name: string, type: string, extra: { length?: number; precision?: number; scale?: number; notNull?: boolean; auto?: boolean; def?: string; flags?: string[]; params?: string; comment?: string } = {}) => `
    <value type="object" struct-name="db.mysql.Column" id="${id}">
      ${v('autoIncrement', 'int', extra.auto ? 1 : 0)}
      ${v('datatypeExplicitParams', 'string', extra.params ?? '')}
      ${v('defaultValue', 'string', extra.def ?? '')}
      ${v('defaultValueIsNull', 'int', extra.def === undefined && !extra.notNull ? 1 : 0)}
      <value type="list" content-type="string" key="flags">${(extra.flags ?? []).map((f) => `<value type="string">${f}</value>`).join('')}</value>
      ${v('isNotNull', 'int', extra.notNull ? 1 : 0)}
      ${v('length', 'int', extra.length ?? -1)}
      ${v('precision', 'int', extra.precision ?? -1)}
      ${v('scale', 'int', extra.scale ?? -1)}
      <link type="object" struct-name="db.SimpleDatatype" key="simpleType">com.mysql.rdbms.mysql.datatype.${type}</link>
      ${v('comment', 'string', extra.comment ?? '')}
      ${v('name', 'string', name)}
    </value>`
  const indexColumn = (column: string, length = 0) => `<value type="object" struct-name="db.mysql.IndexColumn" id="ic-${column}-${length}">${v('columnLength', 'int', length)}${v('descend', 'int', 0)}<link type="object" struct-name="db.Column" key="referencedColumn">${column}</link></value>`
  const index = (id: string, name: string, kind: string, columns: string[], length = 0) => `
    <value type="object" struct-name="db.mysql.Index" id="${id}">
      <value type="list" content-type="object" key="columns">${columns.map((c) => indexColumn(c, length)).join('')}</value>
      ${v('indexType', 'string', kind)}${v('isPrimary', 'int', kind === 'PRIMARY' ? 1 : 0)}${v('unique', 'int', kind === 'UNIQUE' ? 1 : 0)}${v('name', 'string', name)}
    </value>`
  const xml = `<?xml version="1.0"?>
<data grt_format="2.0" document_type="MySQL Workbench Model" version="1.4.4">
  <value type="object" struct-name="workbench.Document" id="doc">
    <value type="list" content-type="object" content-struct-name="workbench.physical.Model" key="physicalModels">
      <value type="object" struct-name="workbench.physical.Model" id="pm">
        <value type="object" struct-name="db.mysql.Catalog" id="cat" key="catalog">
          <value type="list" content-type="object" key="schemata">
            <value type="object" struct-name="db.mysql.Schema" id="s1">
              ${v('name', 'string', 'shop')}
              <value type="list" content-type="object" key="views"><value type="object" struct-name="db.mysql.View" id="v1">${v('name', 'string', 'v')}</value></value>
              <value type="list" content-type="object" key="routines"/>
              <value type="list" content-type="object" key="tables">
                <value type="object" struct-name="db.mysql.Table" id="t1">
                  ${v('name', 'string', 'customer')}
                  ${v('comment', 'string', 'People &amp; companies')}
                  <value type="list" content-type="object" key="columns">
                    ${column('c1', 'customer_id', 'smallint', { notNull: true, auto: true, flags: ['UNSIGNED'] })}
                    ${column('c2', 'email', 'varchar', { length: 50, notNull: true, comment: 'Login' })}
                    ${column('c3', 'active', 'tinyint', { length: 1, notNull: true, def: "'1'" })}
                    ${column('c4', 'last_update', 'timestamp_f', { notNull: true, def: 'CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' })}
                    ${column('c5', 'rating', 'enum', { params: "('G', 'PG')", def: "'G'" })}
                    ${column('c6', 'balance', 'decimal', { precision: 5, scale: 2, def: "'0.00'" })}
                  </value>
                  <value type="list" content-type="object" key="indices">
                    ${index('i1', 'PRIMARY', 'PRIMARY', ['c1'])}
                    ${index('i2', 'idx_email', 'UNIQUE', ['c2'])}
                    ${index('i3', 'idx_email_prefix', 'INDEX', ['c2'], 10)}
                  </value>
                  <value type="list" content-type="object" key="foreignKeys"/>
                  <value type="list" content-type="object" key="triggers"><value type="object" struct-name="db.mysql.Trigger" id="tr1">${v('name', 'string', 'tr')}</value></value>
                </value>
                <value type="object" struct-name="db.mysql.Table" id="t2">
                  ${v('name', 'string', 'payment')}
                  <value type="list" content-type="object" key="columns">
                    ${column('p1', 'payment_id', 'int', { notNull: true, auto: true })}
                    ${column('p2', 'customer_id', 'smallint', { notNull: true, flags: ['UNSIGNED'] })}
                  </value>
                  <value type="list" content-type="object" key="indices">${index('i4', 'PRIMARY', 'PRIMARY', ['p1'])}${index('i5', 'idx_fk_customer_id', 'INDEX', ['p2'])}</value>
                  <value type="list" content-type="object" key="foreignKeys">
                    <value type="object" struct-name="db.mysql.ForeignKey" id="fk1">
                      <link type="object" struct-name="db.mysql.Table" key="referencedTable">t1</link>
                      <value type="list" content-type="object" key="columns"><link type="object">p2</link></value>
                      <value type="list" content-type="object" key="referencedColumns"><link type="object">c1</link></value>
                      ${v('deleteRule', 'string', 'RESTRICT')}${v('updateRule', 'string', 'CASCADE')}${v('many', 'int', 1)}${v('name', 'string', 'fk_payment_customer')}
                    </value>
                  </value>
                </value>
              </value>
            </value>
            <value type="object" struct-name="db.mysql.Schema" id="s2">${v('name', 'string', 'empty')}<value type="list" content-type="object" key="tables"/></value>
          </value>
        </value>
        <value type="list" content-type="object" key="diagrams">
          <value type="object" struct-name="workbench.physical.Diagram" id="d1">
            ${v('name', 'string', 'EER Diagram')}
            <value type="object" struct-name="workbench.physical.Layer" id="root" key="rootLayer"/>
            <value type="list" content-type="object" key="layers">
              <value type="object" struct-name="workbench.physical.Layer" id="L1">${v('name', 'string', 'Billing')}${v('left', 'real', 300)}${v('top', 'real', 100)}${v('width', 'real', 400)}${v('height', 'real', 300)}</value>
            </value>
            <value type="list" content-type="object" key="figures">
              <value type="object" struct-name="workbench.physical.TableFigure" id="f1">${link('table', 't1')}${link('layer', 'root')}${v('left', 'real', 100)}${v('top', 'real', 50)}${v('width', 'real', 120)}${v('height', 'real', 150)}${v('color', 'string', '#98BFDA')}</value>
              <value type="object" struct-name="workbench.physical.TableFigure" id="f2">${link('table', 't2')}${link('layer', 'L1')}${v('left', 'real', 20)}${v('top', 'real', 30)}${v('width', 'real', 120)}${v('height', 'real', 75)}${v('color', 'string', '#FFAA00')}</value>
              <value type="object" struct-name="workbench.model.NoteFigure" id="n1">${link('layer', 'root')}${v('left', 'real', 100)}${v('top', 'real', 500)}${v('text', 'string', 'Check the tax rules')}</value>
            </value>
          </value>
        </value>
      </value>
    </value>
  </value>
</data>`
  return zipSync({ 'document.mwb.xml': strToU8(xml), lock: strToU8('') })
}

describe('MySQL Workbench models', () => {
  it('reads schemas, tables, columns with their flags, indexes, foreign keys and the diagram', () => {
    const m = tablesFromMwb(workbenchModel())
    expect(m.database).toBe('mysql')
    // One schema with tables: the model's database, its tables need no schema.
    expect(m.tables.map((t) => [t.schema, t.name])).toEqual([
      [undefined, 'customer'],
      [undefined, 'payment'],
    ])
    const customer = m.tables[0]!
    expect(customer.comment).toBe('People & companies')
    expect(customer.columns.map((c) => [c.name, c.dataType, c.nullable, c.defaultValue, c.isIdentity])).toEqual([
      ['customer_id', 'smallint unsigned', false, null, true],
      ['email', 'varchar(50)', false, null, false],
      ['active', 'tinyint(1)', false, '1', false],
      ['last_update', 'timestamp', false, 'CURRENT_TIMESTAMP', false],
      ['rating', "enum('G','PG')", true, "'G'", false],
      ['balance', 'decimal(5,2)', true, '0', false],
    ])
    expect(customer.primaryKey).toEqual(['customer_id'])
    expect(customer.indexes.map((i) => [i.name, i.columns, i.unique, i.definition])).toEqual([
      ['PRIMARY', ['customer_id'], true, undefined],
      ['idx_email', ['email'], true, undefined],
      ['idx_email_prefix', ['email'], false, 'CREATE INDEX `idx_email_prefix` ON `customer` (`email`(10))'],
    ])
    expect(m.tables[1]!.foreignKeys).toEqual([{ name: 'fk_payment_customer', columns: ['customer_id'], refTable: 'customer', refColumns: ['customer_id'], onDelete: 'RESTRICT', onUpdate: 'CASCADE' }])
    expect(m.leftOut).toEqual({ views: 1, triggers: 1 })
    // Spread to the app's table size; a figure on a layer sits where the layer puts it.
    expect(Object.keys(m.positions)).toEqual(['.customer', '.payment'])
    expect(m.positions['.customer']).toEqual({ x: 0, y: 0 })
    expect(m.positions['.payment']!.x).toBeGreaterThan(m.positions['.customer']!.x + 240)
    expect(m.colors).toEqual({ '.customer': '#98BFDA', '.payment': '#FFAA00' })
    expect(m.boxes).toHaveLength(1)
    expect(m.boxes[0]).toMatchObject({ id: 'L1', title: 'Billing' })
    expect(m.notes).toEqual([expect.objectContaining({ id: 'n1', text: 'Check the tax rules' })])
    // Prisma can be made from it: types stay MySQL's.
    expect(toPrisma(m.tables, { database: 'mysql' })).toMatch(/customer_id\s+Int\s+@id @default\(autoincrement\(\)\) @db\.UnsignedSmallInt/)
  })

  it('says what is wrong with a file that is not a Workbench model', () => {
    expect(() => tablesFromMwb(strToU8('not a zip'))).toThrow(/not a zip/)
    expect(() => tablesFromMwb(zipSync({ 'other.txt': strToU8('x') }))).toThrow(/document\.mwb\.xml/)
    expect(() => readModelFile('notes.txt', strToU8('hello'))).toThrow(/not a model/)
  })
})

describe('Prisma schemas opened as models', () => {
  it('takes the provider as the model database', () => {
    const m = readModelFile('schema.prisma', strToU8('datasource db {\n  provider = "mysql"\n}\n\nmodel a {\n  id Int @id\n  tags String[]\n}\n'))
    expect(m.database).toBe('mysql')
    expect(m.tables.map((t) => t.name)).toEqual(['a'])
    expect(m.leftOut).toEqual({ scalarLists: 1 })
  })
})

import { describe, expect, it } from 'vitest'
import { applyDezignSave, assembleDezignProject, detectDezignEncoding, parseDbml, parseDezignXml, readDezign, saveToDezign, serializeDezignXml, toDbml, type DezignFile, type TableInfo } from '../src/index.js'

// Hand-written models in DeZign's layout (no file from a real project is kept in the repository).
const attr = (id: string, name: string, type: string, extra = '', more = '') =>
  `<ATTR>\n<NAME>${name}</NAME>\n<ID>${id}</ID>\n<DESC></DESC>\n<DOMAINID></DOMAINID>\n<DT>\n<DTLISTNAME>${type}</DTLISTNAME>\n${extra}<SD>1</SD>\n<INC>1</INC>\n</DT>\n${more}</ATTR>`
const notNull = '<NNCON>\n<VALUE>1</VALUE>\n<CONTYPE>5</CONTYPE>\n</NNCON>\n'

const customer = `<ENT>
<NAME>customer</NAME>
<ID>10</ID>
<SCHEMA>shop</SCHEMA>
<DESC>Z\xe1kazn\xedk s p\xf8\xedli\x9a \x9elu\x9dou\xe8k\xfdm jm\xe9nem</DESC>
<PKCON>
<NAME>PK_customer</NAME>
<CONTYPE>3</CONTYPE>
<ATTRIBUTEIDS>
<ATTRIBUTEID>A1</ATTRIBUTEID>
</ATTRIBUTEIDS>
</PKCON>
<ATTRIBUTES>
${attr('A1', 'id', 'BIGINT', '<AN>1</AN>\n', notNull)}
${attr('A2', 'email', 'CHARACTER VARYING', '<LE>120</LE>\n', notNull)}
${attr('A3', 'credit', 'NUMERIC', '<LE>10</LE>\n<PR>2</PR>\n', '<DEFCON>\n<VALUE>0</VALUE>\n</DEFCON>\n<CCON>\n<VALUE>credit &gt;= 0</VALUE>\n</CCON>\n')}
<ATTR>
<NAME>country</NAME>
<ID>A4</ID>
<DOMAINID>D1</DOMAINID>
<DT>
<DTLISTNAME></DTLISTNAME>
</DT>
</ATTR>
</ATTRIBUTES>
<CONSTRAINTS>
<CONSTRAINT>
<NAME>TUC_customer_1</NAME>
<CONTYPE>2</CONTYPE>
<ATTRIBUTEIDS>
<ATTRIBUTEID>A2</ATTRIBUTEID>
</ATTRIBUTEIDS>
</CONSTRAINT>
</CONSTRAINTS>
</ENT>`

const invoice = `<ENT>
<NAME>invoice</NAME>
<ID>20</ID>
<SCHEMA>shop</SCHEMA>
<DESC></DESC>
<PKCON>
<ATTRIBUTEIDS>
<ATTRIBUTEID>B1</ATTRIBUTEID>
</ATTRIBUTEIDS>
</PKCON>
<ATTRIBUTES>
${attr('B1', 'id', 'BIGSERIAL', '', notNull)}
${attr('B2', 'customer_id', 'BIGINT', '', notNull)}
${attr('B3', 'issued', 'DATE')}
</ATTRIBUTES>
<INDEXES>
<INDEX>
<NAME>IDX_invoice_PK</NAME>
<AUTOIDXTYPE>1</AUTOIDXTYPE>
<IDXCOLS>
<IDXCOL>
<IDXCOLATTRID>B1</IDXCOLATTRID>
</IDXCOL>
</IDXCOLS>
</INDEX>
<INDEX>
<NAME>IDX_invoice_1</NAME>
<INDEXTYPE>UNIQUE</INDEXTYPE>
<AUTOIDXTYPE>0</AUTOIDXTYPE>
<IDXCOLS>
<IDXCOL>
<IDXCOLATTRID>B2</IDXCOLATTRID>
</IDXCOL>
<IDXCOL>
<IDXCOLATTRID>B3</IDXCOLATTRID>
</IDXCOL>
</IDXCOLS>
</INDEX>
</INDEXES>
</ENT>`

const domain = `<DOMAIN>
<NAME>country_code</NAME>
<ID>D1</ID>
<DT>
<DTLISTNAME>CHARACTER</DTLISTNAME>
<LE>2</LE>
</DT>
</DOMAIN>`

const rel = (id: string, name: string, pairs: string, rules = '<UPDATERULE>2</UPDATERULE>\n<DELETERULE>1</DELETERULE>') => `<REL>
<NAME>${name}</NAME>
<ID>${id}</ID>
<PARENTOBJECTID>10</PARENTOBJECTID>
<CHILDOBJECTID>20</CHILDOBJECTID>
<VIRTUALREL>0</VIRTUALREL>
${rules}
<CONSTRAINT>
<NAME>FK_${name}</NAME>
<CONTYPE>4</CONTYPE>
</CONSTRAINT>
<PAIRS>
${pairs}</PAIRS>
</REL>`
const pair = '<PAIR>\n<KEYID>A1</KEYID>\n<FOREIGNKEYID>B2</FOREIGNKEYID>\n</PAIR>\n'

const control = (id: string, diagram: string, l: number, t: number) => `<ENTC>\n<ID>${id}</ID>\n<DIAGRAMID>${diagram}</DIAGRAMID>\n<W>120</W>\n<H>44</H>\n<L>${l}</L>\n<T>${t}</T>\n</ENTC>`
const diagram = (id: string, main: 0 | 1) => `<DIAGRAM>\n<ID>${id}</ID>\n<NAME>d${id}</NAME>\n<ISMAINDIAGRAM>${main}</ISMAINDIAGRAM>\n</DIAGRAM>`

// The settings block repeats DeZign's own malformed form for empty values.
const settings = `<PROJECTSETTINGS>
<COMMONSETTINGS>
<PROJECTNAME></PROJECTNAME>
<PROJECTNAME /></PROJECTNAME />
<FILEFORMATVERSION>140</FILEFORMATVERSION>
</COMMONSETTINGS>
</PROJECTSETTINGS>`

const dez = `<?xml version="1.0" encoding="iso-8859-1"?><dezign>
<VERSION>
${settings}
<DATADICT>
<DBID>postgresql16</DBID>
<DOMAINS>
${domain}
</DOMAINS>
<ENTITIES>
${customer}
${invoice}
</ENTITIES>
<VIEWS>
<VIEW>
<NAME>v_open</NAME>
</VIEW>
</VIEWS>
<RELATIONSHIPS>
${rel('30', 'customer_invoice', pair)}
${rel('31', 'drawn_only', '', '')}
</RELATIONSHIPS>
</DATADICT>
<DIAGRAMS>
${diagram('1', 1)}
${diagram('2', 0)}
<CONTROLS>
<ENTITYCONTROLS>
${control('10', '1', 100, 50)}
${control('20', '1', 400, 250)}
${control('10', '2', 900, 900)}
</ENTITYCONTROLS>
</CONTROLS>
</DIAGRAMS>
</VERSION>
<VERSION>
<VERSIONINFO>
<VERSIONNUMBER>1</VERSIONNUMBER>
</VERSIONINFO>
<DATADICT>
<DBID>postgresql12</DBID>
<ENTITIES>
</ENTITIES>
</DATADICT>
</VERSION>
</dezign>`

describe('DeZign for Databases models', () => {
  it('keeps every byte through parse and serialize, including the malformed empty settings', () => {
    expect(serializeDezignXml(parseDezignXml(dez))).toBe(dez)
    expect(() => parseDezignXml('<dezign><A></B></dezign>')).toThrow(/closes/)
  })

  it('reads tables, columns, keys, constraints and relationships of the working version', () => {
    const model = readDezign(dez)
    expect(model.formatVersion).toBe('140')
    expect(model.targetDatabase).toBe('postgresql16')
    expect(model.tables.map((t) => `${t.schema}.${t.name}`)).toEqual(['shop.customer', 'shop.invoice'])
    const [c, i] = model.tables
    expect(c!.columns.map((x) => [x.name, x.dataType, x.nullable, x.isPrimaryKey, x.isIdentity, x.defaultValue])).toEqual([
      ['id', 'bigint', false, true, true, null],
      ['email', 'character varying(120)', false, false, false, null],
      ['credit', 'numeric(10,2)', true, false, false, '0'],
      ['country', 'character(2)', true, false, false, null],
    ])
    expect(c!.primaryKey).toEqual(['id'])
    expect(c!.indexes).toEqual([{ name: 'TUC_customer_1', columns: ['email'], unique: true, primary: false, constraint: true }])
    // The automatic index on the primary key is not a second index.
    expect(i!.indexes).toEqual([{ name: 'IDX_invoice_1', columns: ['customer_id', 'issued'], unique: true, primary: false }])
    expect(i!.foreignKeys).toEqual([{ name: 'FK_customer_invoice', columns: ['customer_id'], refSchema: 'shop', refTable: 'customer', refColumns: ['id'], onUpdate: 'CASCADE', onDelete: 'RESTRICT' }])
  })

  it('says what it left out instead of dropping it silently', () => {
    expect(readDezign(dez).leftOut).toEqual({ domains: 1, views: 1, procedures: 0, sequences: 0, triggers: 0, checks: 1, relationshipsWithoutColumns: 1, subdiagrams: 1 })
  })

  it('decodes Windows-1250 text under the Latin-1 declaration', () => {
    expect(detectDezignEncoding(dez)).toBe('windows-1250')
    expect(readDezign(dez).tables[0]!.comment).toBe('Zákazník s příliš žluťoučkým jménem')
    expect(detectDezignEncoding('<A>caf\xe9 \xe0 la cr\xe8me, se\xf1or</A>')).toBe('windows-1252')
    expect(detectDezignEncoding('<A>\xc5\x99e\xc5\xa1en\xc3\xad</A>')).toBe('utf-8')
    expect(detectDezignEncoding('<A>plain</A>')).toBe('windows-1252')
    // á í ý č alone don't tell the code pages apart: the caller's language decides.
    const ambiguous = '<dezign><VERSION><DATADICT><ENTITIES><ENT><NAME>t</NAME><DESC>plat\xed v\xe8as</DESC></ENT></ENTITIES></DATADICT></VERSION></dezign>'
    expect(readDezign(ambiguous).tables[0]!.comment).toBe('platí vèas')
    expect(readDezign(ambiguous, { fallbackEncoding: 'windows-1250' }).tables[0]!.comment).toBe('platí včas')
  })

  it('takes positions from the main diagram and spreads them for bigger tables', () => {
    expect(readDezign(dez).positions).toEqual({ 'shop.customer': { x: 0, y: 0 }, 'shop.invoice': { x: 300, y: 200 } })
    // Tables twice as wide and (32 + 22 × 4 rows) / 44 px = 2.7× as tall on average (median of 2.73 and 2.23).
    const spread = readDezign(dez, { node: { width: 240, header: 32, row: 22 } }).positions
    expect(spread['shop.invoice']!.x).toBe(600)
    expect(spread['shop.invoice']!.y).toBeGreaterThan(400)
  })

  it('lists every diagram with its tables and their places', () => {
    const { diagrams } = readDezign(dez)
    expect(diagrams.map((d) => [d.id, d.name, d.main, d.tables])).toEqual([
      ['1', 'd1', true, ['shop.customer', 'shop.invoice']],
      ['2', 'd2', false, ['shop.customer']],
    ])
    expect(diagrams[1]!.positions).toEqual({ 'shop.customer': { x: 0, y: 0 } })
    expect(diagrams[1]!.layout).toMatchObject({ originX: 900, originY: 900 })
  })

  it('becomes DBML that reads back the same', () => {
    const model = readDezign(dez)
    const dbml = toDbml(model.tables)
    expect(dbml).toContain('Table shop.customer {')
    expect(dbml).toContain('Ref: shop.invoice.customer_id > shop.customer.id [delete: restrict, update: cascade]')
    const back = parseDbml(dbml)
    expect(back.errors).toEqual([])
    expect(back.tables.map((t) => t.columns.map((c) => `${c.name} ${c.dataType}`))).toEqual(model.tables.map((t) => t.columns.map((c) => `${c.name} ${c.dataType}`)))
    expect(back.tables[1]!.foreignKeys[0]).toMatchObject({ columns: ['customer_id'], refTable: 'customer', refColumns: ['id'] })
  })

  it('reads a folder project (.dezproj with one file per object)', () => {
    const xml = (body: string) => `<?xml version="1.0" encoding="iso-8859-1"?>\r\n${body}`
    const files = [
      { path: 'Shop.dezproj', text: xml(settings) },
      { path: 'Shop.dds', text: xml('<DATADICT>\n<DBID>postgresql16</DBID>\n</DATADICT>') },
      { path: 'Shop.ddp', text: xml('<DisplayPreferences>\n</DisplayPreferences>') },
      { path: 'data dictionary\\entities\\shop.invoice.xml', text: xml(invoice) },
      { path: 'data dictionary/entities/shop.customer.xml', text: xml(customer) },
      { path: 'data dictionary/domains/country_code.xml', text: xml(domain) },
      { path: 'data dictionary/relationships/customer_invoice.xml', text: xml(rel('30', 'customer_invoice', pair)) },
      { path: 'diagrams/1.xml', text: xml(diagram('1', 1)) },
      { path: 'diagrams/diagramobjects/entitycontrols/1-10.xml', text: xml(control('10', '1', 100, 50)) },
      { path: 'diagrams/diagramobjects/entitycontrols/1-20.xml', text: xml(control('20', '1', 400, 250)) },
      { path: 'archived versions/x.xml', text: xml('<VERSION>\n<VERSIONINFO>\n</VERSIONINFO>\n</VERSION>') },
    ]
    const model = readDezign(assembleDezignProject(files))
    expect(model.formatVersion).toBe('140')
    expect(model.tables.map((t) => t.name)).toEqual(['customer', 'invoice'])
    expect(model.tables[1]!.foreignKeys).toHaveLength(1)
    expect(model.tables[0]!.columns[3]!.dataType).toBe('character(2)')
    expect(Object.keys(model.positions)).toEqual(['shop.customer', 'shop.invoice'])
    expect(() => assembleDezignProject(files.slice(1))).toThrow(/dezproj/)
  })

  it('rejects files that are not DeZign models', () => {
    expect(() => readDezign('<project><table/></project>')).toThrow(/not a DeZign/)
  })
})

describe('saving back into a DeZign project', () => {
  const viaDbml = (tables: TableInfo[]) => parseDbml(toDbml(tables)).tables
  const single: DezignFile[] = [{ path: 'shop.dez', text: dez }]
  const xml = (body: string) => `<?xml version="1.0" encoding="iso-8859-1"?>\r\n${body.replaceAll('\n', '\r\n')}\r\n`
  const folder: DezignFile[] = [
    { path: 'Shop.dezproj', text: xml(settings) },
    { path: 'Shop.dds', text: xml('<DATADICT>\n<DBID>postgresql16</DBID>\n</DATADICT>') },
    { path: 'data dictionary/entities/shop.customer.xml', text: xml(customer) },
    { path: 'data dictionary/entities/shop.invoice.xml', text: xml(invoice) },
    { path: 'data dictionary/domains/country_code.xml', text: xml(domain) },
    { path: 'data dictionary/relationships/customer_invoice.xml', text: xml(rel('30', 'customer_invoice', pair)) },
    { path: 'diagrams/1.xml', text: xml(diagram('1', 1)) },
    { path: 'diagrams/diagramobjects/entitycontrols/entc-1-10.xml', text: xml(control('10', '1', 100, 50)) },
    { path: 'diagrams/diagramobjects/entitycontrols/entc-1-20.xml', text: xml(control('20', '1', 400, 250)) },
  ]
  const model = (files: DezignFile[]) => viaDbml(readDezign(files.length > 1 ? assembleDezignProject(files) : files[0]!.text).tables)
  let seq = 0
  const save = (files: DezignFile[], edit: (tables: TableInfo[]) => TableInfo[] | void, positions?: Record<string, { x: number; y: number }>) => {
    const tables = model(files)
    const target = viaDbml(edit(tables) ?? tables)
    seq = 0
    return saveToDezign(files, model(files), target, { normalize: viaDbml, positions, newId: () => `NEW-${++seq}` })
  }
  const changedLines = (a: string, b: string) => {
    const before = new Set(a.split('\n'))
    return b.split('\n').filter((l) => !before.has(l))
  }
  const column = (name: string, dataType: string, more: Partial<TableInfo['columns'][number]> = {}) => ({ name, ordinal: 99, dataType, nullable: true, isPrimaryKey: false, isIdentity: false, ...more })

  it('writes nothing when the model was not edited', () => {
    expect(save(single, () => {})).toEqual({ files: [], deleted: [], changes: [] })
    expect(save(folder, () => {})).toEqual({ files: [], deleted: [], changes: [] })
  })

  it('renames a column by touching one line and keeps its id, checks and everything else', () => {
    const r = save(single, (t) => void (t[0]!.columns[2]!.name = 'balance'))
    expect(r.changes).toEqual([{ kind: 'rename_column', table: 'customer', name: 'credit → balance' }])
    expect(changedLines(dez, r.files[0]!.text)).toEqual(['<NAME>balance</NAME>'])
    expect(r.files[0]!.text).toContain('<VALUE>credit &gt;= 0</VALUE>')
    expect(r.files[0]!.text.length - dez.length).toBe('balance'.length - 'credit'.length)
  })

  it('changes type, nullability, default and comment in place, in the file\'s code page', () => {
    const r = save(single, (t) => {
      Object.assign(t[0]!.columns[1]!, { dataType: 'varchar(200)', nullable: true, defaultValue: "'x'", comment: 'Přihlašovací e-mail <"hlavní">' })
      t[0]!.comment = 'Odběratel'
    })
    expect(r.changes).toEqual([{ kind: 'alter_table', table: 'customer' }, { kind: 'alter_column', table: 'customer', name: 'email' }])
    const out = r.files[0]!.text
    expect(out).toContain('<DTLISTNAME>VARCHAR</DTLISTNAME>\n<LE>200</LE>')
    expect(out).toContain('<DESC>P\xf8ihla\x9aovac\xed e-mail &lt;&quot;hlavn\xed&quot;&gt;</DESC>')
    expect(out).toContain('<DESC>Odb\xecratel</DESC>')
    const email = readDezign(out).tables[0]!.columns[1]!
    expect(email).toMatchObject({ dataType: 'varchar(200)', nullable: true, defaultValue: "'x'", comment: 'Přihlašovací e-mail <"hlavní">' })
    // The archived version in the same file is untouched.
    expect(out.slice(out.indexOf('<VERSIONINFO>'))).toBe(dez.slice(dez.indexOf('<VERSIONINFO>')))
  })

  it('adds and drops columns, keeping keys and indexes consistent', () => {
    const r = save(single, (t) => {
      t[1]!.columns = t[1]!.columns.filter((c) => c.name !== 'issued')
      t[1]!.indexes = []
      t[1]!.columns.push(column('total', 'numeric(12,2)', { nullable: false, defaultValue: '0' }))
    })
    expect(r.changes.map((c) => `${c.kind} ${c.name}`)).toEqual(['drop_column issued', 'add_column total', 'drop_index customer_id, issued'])
    const invoiceAfter = readDezign(r.files[0]!.text).tables[1]!
    expect(invoiceAfter.columns.map((c) => `${c.name} ${c.dataType} ${c.nullable} ${c.defaultValue}`)).toEqual(['id bigserial false null', 'customer_id bigint false null', 'total numeric(12,2) false 0'])
    expect(invoiceAfter.indexes).toEqual([])
    expect(invoiceAfter.foreignKeys).toHaveLength(1)
    // The new column is a copy of a neighbour with its own ids.
    expect(r.files[0]!.text).toContain('<ID>NEW-1</ID>')
    expect(r.files[0]!.text).not.toContain('<ATTRIBUTEID>B3</ATTRIBUTEID>')
  })

  it('adds a table with a relationship, a place in the diagram and a connector', () => {
    const r = save(
      single,
      (t) => [
        ...t,
        { schema: 'shop', name: 'payment', type: 'table', comment: 'Platba', columns: [column('id', 'bigint', { nullable: false, isPrimaryKey: true }), column('invoice_id', 'bigint', { nullable: false })], primaryKey: ['id'], foreignKeys: [{ name: 'x', columns: ['invoice_id'], refSchema: 'shop', refTable: 'invoice', refColumns: ['id'], onDelete: 'CASCADE' }], indexes: [{ name: 'payment_invoice', columns: ['invoice_id'], unique: false, primary: false }] },
      ],
      { 'shop.payment': { x: 700, y: 100 } },
    )
    expect(r.changes.map((c) => c.kind)).toEqual(['add_table', 'add_relationship'])
    const after = readDezign(r.files[0]!.text)
    const payment = after.tables[2]!
    expect(payment).toMatchObject({ schema: 'shop', name: 'payment', comment: 'Platba', primaryKey: ['id'] })
    expect(payment.foreignKeys).toEqual([{ name: 'invoice_payment', columns: ['invoice_id'], refSchema: 'shop', refTable: 'invoice', refColumns: ['id'], onDelete: 'CASCADE' }])
    expect(payment.indexes.map((ix) => ix.columns)).toEqual([['invoice_id']])
    // Positions are diagram coordinates: 700,100 from the origin of the main diagram (100,50).
    expect(after.positions['shop.payment']).toEqual({ x: 700, y: 100 })
    expect(after.positions['shop.customer']).toEqual({ x: 0, y: 0 })
    // This file numbers its objects (10, 20, 30, 31): new ones continue the numbering.
    expect(r.files[0]!.text).toMatch(/<RELATIONSHIPCONNECTORS>\s*<RELC>\s*<ID>33<\/ID>\s*<DIAGRAMID>1<\/DIAGRAMID>/)
    expect(r.files[0]!.text).toMatch(/<ENTC>\s*<ID>32<\/ID>\s*<DIAGRAMID>1<\/DIAGRAMID>\s*<W>120<\/W>\s*<H>44<\/H>\s*<L>800<\/L>\s*<T>150<\/T>/)
  })

  it('drops a table with its relationships and diagram objects, and changes relationship rules', () => {
    const dropped = save(single, (t) => t.filter((x) => x.name !== 'invoice'))
    expect(dropped.changes).toEqual([{ kind: 'drop_table', table: 'invoice' }])
    const out = dropped.files[0]!.text
    expect(out).not.toContain('<NAME>invoice</NAME>')
    expect(out).not.toContain('<NAME>customer_invoice</NAME>')
    // The relationship that never had columns belongs to the dropped table too; the control of the kept table stays.
    expect(out).not.toContain('drawn_only')
    expect(out.match(/<ENTC>/g)).toHaveLength(2)

    const ruled = save(single, (t) => void (t[1]!.foreignKeys[0]!.onDelete = 'SET NULL'))
    expect(ruled.changes).toEqual([{ kind: 'alter_relationship', table: 'invoice', name: 'customer' }])
    expect(changedLines(dez, ruled.files[0]!.text)).toEqual(['<DELETERULE>3</DELETERULE>'])
  })

  it('renames a table without losing its relationships', () => {
    const r = save(single, (t) => {
      t[0]!.name = 'client'
      for (const fk of t[1]!.foreignKeys) fk.refTable = 'client'
    })
    expect(r.changes).toEqual([{ kind: 'rename_table', table: 'client', name: 'customer → client' }])
    // The key's name is somebody's own here (no name template), so it stays.
    expect(changedLines(dez, r.files[0]!.text)).toEqual(['<NAME>client</NAME>'])
    expect(readDezign(r.files[0]!.text).tables[1]!.foreignKeys[0]).toMatchObject({ refTable: 'client', refColumns: ['id'] })
  })

  it('moves tables that were moved in the diagram and nothing else', () => {
    const r = save(single, () => {}, { 'shop.customer': { x: 0, y: 0 }, 'shop.invoice': { x: 500, y: 200 } })
    expect(r.changes).toEqual([{ kind: 'move_table', table: 'invoice' }])
    expect(changedLines(dez, r.files[0]!.text)).toEqual(['<L>600</L>'])
  })

  it('puts a table on another diagram and moves tables there', () => {
    seq = 0
    const tables = model(single)
    const r = saveToDezign(single, tables, model(single), { normalize: viaDbml, diagrams: { '2': { tables: ['shop.customer', 'shop.invoice'], positions: { 'shop.customer': { x: 40, y: 0 }, 'shop.invoice': { x: 300, y: 120 } } } } })
    expect(r.changes).toEqual([{ kind: 'move_table', table: 'invoice' }, { kind: 'move_table', table: 'customer' }])
    const second = readDezign(r.files[0]!.text).diagrams[1]!
    expect(second.tables).toEqual(['shop.customer', 'shop.invoice'])
    // The diagram's origin was the customer at 900,900: it moved 40 right, the invoice went to 300,120 from there.
    expect(r.files[0]!.text).toMatch(/<ID>10<\/ID>\s*<DIAGRAMID>2<\/DIAGRAMID>\s*<W>120<\/W>\s*<H>44<\/H>\s*<L>940<\/L>\s*<T>900<\/T>/)
    expect(r.files[0]!.text).toMatch(/<ID>20<\/ID>\s*<DIAGRAMID>2<\/DIAGRAMID>\s*<W>120<\/W>\s*<H>44<\/H>\s*<L>1200<\/L>\s*<T>1020<\/T>/)
    // The main diagram is not touched.
    expect(readDezign(r.files[0]!.text).positions).toEqual(readDezign(dez).positions)
  })

  it('works on a folder project: one file per touched object, files named like their neighbours', () => {
    const r = save(folder, (t) => {
      t[0]!.columns[1]!.comment = 'Kontakt'
      t[0]!.name = 'client'
      for (const fk of t[1]!.foreignKeys) fk.refTable = 'client'
      return [...t, { schema: 'shop', name: 'payment', type: 'table', comment: null, columns: [column('id', 'bigint', { nullable: false, isPrimaryKey: true }), column('invoice_id', 'bigint')], primaryKey: ['id'], foreignKeys: [{ name: 'x', columns: ['invoice_id'], refSchema: 'shop', refTable: 'invoice', refColumns: ['id'] }], indexes: [] }]
    })
    expect(r.deleted).toEqual(['data dictionary/entities/shop.customer.xml'])
    expect(r.files.map((f) => f.path).sort()).toEqual([
      'data dictionary/entities/shop.client.xml',
      'data dictionary/entities/shop.payment.xml',
      'data dictionary/relationships/invoice_payment.xml',
      'diagrams/diagramobjects/entitycontrols/entc-1-31.xml',
      'diagrams/diagramobjects/relationshipconnectors/relc-1-32.xml',
    ])
    // New files look like DeZign's: declaration, CRLF, one object.
    const payment = r.files.find((f) => f.path.endsWith('shop.payment.xml'))!.text
    expect(payment.startsWith('<?xml version="1.0" encoding="iso-8859-1"?>\r\n<ENT>\r\n<NAME>payment</NAME>\r\n<ID>31</ID>')).toBe(true)
    expect(payment.endsWith('</ENT>\r\n')).toBe(true)
    expect(payment).not.toMatch(/[^\r]\n/)
    const after = readDezign(assembleDezignProject(applyDezignSave(folder, r)))
    expect(after.tables.map((t) => t.name)).toEqual(['client', 'invoice', 'payment'])
    expect(after.tables[1]!.foreignKeys[0]!.refTable).toBe('client')
    expect(after.tables[2]!.foreignKeys[0]!.refTable).toBe('invoice')
    expect(after.leftOut.domains).toBe(1)
  })

  it('refuses a result that would not read back as edited', () => {
    // A column typed with something the file cannot hold round-trips differently: nothing is returned.
    expect(() => saveToDezign(single, model(single), model(single), { normalize: () => [] })).toThrow(/could not be written safely/)
  })
})

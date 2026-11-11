import { describe, expect, it } from 'vitest'
import { diagramsAsLoaded, mutate, mutateDiagrams, random } from './dezign-fuzz.js'

// More chains for a long local run: DBM_FUZZ_CHAINS=500 npx vitest run --root packages/core test/dezign.test.ts
const CHAINS = Number(process.env.DBM_FUZZ_CHAINS) || 0
import { applyDezignSave, assembleDezignProject, createScript, detectDezignEncoding, dezignDriver, dezignIntegrity, getDialect, listDezignVersions, newDezignProject, parseDbml, parseDezignXml, readDezign, saveToDezign, serializeDezignXml, toDbml, type DezignFile, type TableInfo } from '../src/index.js'

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

const control = (id: string, diagram: string, l: number, t: number, brush = '0,16119285') => `<ENTC>\n<ID>${id}</ID>\n<DIAGRAMID>${diagram}</DIAGRAMID>\n<W>120</W>\n<H>44</H>\n<L>${l}</L>\n<T>${t}</T>\n<BRUSH>${brush}</BRUSH>\n</ENTC>`
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
<TEXTAREAS>
<TEXTAR>
<NAME>TextArea1</NAME>
<ID>T1</ID>
<TEXT>Prodej</TEXT>
</TEXTAR>
</TEXTAREAS>
<GROUPBOXES>
<GROUPBOX>
<NAME>GroupBox1</NAME>
<ID>G1</ID>
<OBJECTCAPTION>Fakturace</OBJECTCAPTION>
</GROUPBOX>
</GROUPBOXES>
<SEQUENCES>
<SEQUENCE>
<NAME>invoice_no</NAME>
<SCHEMANAME>shop</SCHEMANAME>
<INCREMENT>1</INCREMENT>
<SEED>1000</SEED>
<MAX></MAX>
<CYCLE></CYCLE>
</SEQUENCE>
</SEQUENCES>
<VIEWS>
<VIEW>
<NAME>v_open</NAME>
<SCHEMA>shop</SCHEMA>
<CODE>CREATE VIEW %viewname% AS
SELECT id FROM shop.invoice WHERE issued IS NULL;</CODE>
</VIEW>
</VIEWS>
<RELATIONSHIPS>
${rel('30', 'customer_invoice', pair)}
${rel('31', 'drawn_only', '', '')}
</RELATIONSHIPS>
</DATADICT>
<DIAGRAMS>
<DisplayPreferences>
<DEFENTCOLOR>16119285</DEFENTCOLOR>
</DisplayPreferences>
${diagram('1', 1)}
${diagram('2', 0)}
<CONTROLS>
<ENTITYCONTROLS>
${control('10', '1', 100, 50)}
${control('20', '1', 400, 250, '0,8454143')}
${control('10', '2', 900, 900)}
</ENTITYCONTROLS>
<TEXTAREACONTROLS>
<TEXTC>
<ID>T1</ID>
<DIAGRAMID>1</DIAGRAMID>
<W>200</W>
<H>30</H>
<L>90</L>
<T>10</T>
</TEXTC>
</TEXTAREACONTROLS>
<GROUPBOXESCONTROLS>
<GROUPBOXC>
<ID>G1</ID>
<DIAGRAMID>1</DIAGRAMID>
<W>500</W>
<H>300</H>
<L>80</L>
<T>30</T>
</GROUPBOXC>
</GROUPBOXESCONTROLS>
</CONTROLS>
</DIAGRAMS>
</VERSION>
<VERSION>
<VERSIONINFO>
<VERSIONNUMBER>1</VERSIONNUMBER>
<VERSIONLABEL>Prvn\xed vyd\xe1n\xed</VERSIONLABEL>
<VERSIONDATE>2026-01-15</VERSIONDATE>
<VERSIONCOMMENTS>before invoices</VERSIONCOMMENTS>
</VERSIONINFO>
<DATADICT>
<DBID>postgresql12</DBID>
<ENTITIES>
${customer.replace(attr('A3', 'credit', 'NUMERIC', '<LE>10</LE>\n<PR>2</PR>\n', '<DEFCON>\n<VALUE>0</VALUE>\n</DEFCON>\n<CCON>\n<VALUE>credit &gt;= 0</VALUE>\n</CCON>\n'), '')}
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
    // The column follows the project's domain; its type is the domain's.
    expect(c!.columns[3]!.domain).toBe('country_code')
    expect(readDezign(dez).domains).toEqual([{ name: 'country_code', dataType: 'character(2)' }])
    expect(toDbml(model.tables)).toContain("country character(2) [domain: 'country_code']")
    expect(c!.primaryKey).toEqual(['id'])
    expect(c!.indexes).toEqual([{ name: 'TUC_customer_1', columns: ['email'], unique: true, primary: false, constraint: true }])
    // The automatic index on the primary key is not a second index.
    expect(i!.indexes).toEqual([{ name: 'IDX_invoice_1', columns: ['customer_id', 'issued'], unique: true, primary: false }])
    expect(i!.foreignKeys).toEqual([{ name: 'FK_customer_invoice', columns: ['customer_id'], refSchema: 'shop', refTable: 'customer', refColumns: ['id'], onUpdate: 'CASCADE', onDelete: 'RESTRICT' }])
  })

  it('says what it left out instead of dropping it silently', () => {
    expect(readDezign(dez).leftOut).toEqual({ domains: 1, views: 1, procedures: 0, sequences: 1, triggers: 0, checks: 0, relationshipsWithoutColumns: 1, subdiagrams: 1 })
    // The column's check constraint is part of the model.
    expect(readDezign(dez).tables[0]!.checks).toEqual([{ expression: 'credit >= 0' }])
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
    // Colors other than the project's default (Delphi BGR 0x80FFFF = light yellow) and the diagram's text areas.
    expect(diagrams[0]!.colors).toEqual({ 'shop.invoice': '#ffff80' })
    expect(diagrams[0]!.notes).toEqual([{ id: 'T1', text: 'Prodej', x: -10, y: -40 }])
    expect(diagrams[1]!.notes).toEqual([])
    expect(diagrams[0]!.boxes).toEqual([{ id: 'G1', title: 'Fakturace', x: -20, y: -20, w: 500, h: 300 }])
    expect(diagrams[1]!.layout).toMatchObject({ originX: 900, originY: 900 })
  })

  it('keeps views and sequences as the SQL the project has for them', () => {
    expect(readDezign(dez).sqlObjects).toEqual([
      { kind: 'sequence', name: 'invoice_no', schema: 'shop', sql: 'CREATE SEQUENCE shop.invoice_no INCREMENT BY 1 START WITH 1000' },
      { kind: 'view', name: 'v_open', schema: 'shop', sql: 'CREATE VIEW shop.v_open AS\nSELECT id FROM shop.invoice WHERE issued IS NULL' },
    ])
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

  it('lists the versions archived in a project and reads one', () => {
    expect(listDezignVersions(dez, { fallbackEncoding: 'windows-1250' })).toEqual([{ number: '1', label: 'První vydání', date: '2026-01-15', comments: 'before invoices' }])
    const old = readDezign(dez, { archived: 0 })
    expect(old.targetDatabase).toBe('postgresql12')
    // The archived version has one table, without the credit column the working model has.
    expect(old.tables.map((t) => `${t.name}: ${t.columns.map((c) => c.name).join(', ')}`)).toEqual(['customer: id, email, country'])
    expect(() => readDezign(dez, { archived: 3 })).toThrow(/archived version/)
    // The head of a folder project's archived file is enough for the list.
    expect(listDezignVersions('<?xml version="1.0"?>\r\n<VERSION>\r\n<VERSIONINFO>\r\n<VERSIONNUMBER>7</VERSIONNUMBER>\r\n<VERSIONLABEL>a &amp; b</VERSIONLABEL>\r\n</VERSIONINFO>\r\n<PROJECTSETTINGS>')).toEqual([{ number: '7', label: 'a & b', date: '', comments: '' }])
  })

  it('rejects files that are not DeZign models', () => {
    expect(() => readDezign('<project><table/></project>')).toThrow(/not a DeZign/)
    expect(() => readDezign('<dezign><VERSION>\n<FILEFORMATVERSIONNUMBER>30</FILEFORMATVERSIONNUMBER>\n<DBID>postgresql7</DBID>\n</VERSION></dezign>')).toThrow(/file format 30, older than/)
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

  it('keeps, gives and takes away domains', () => {
    // Untouched, the domain column is not written at all.
    expect(save(single, () => {}).files).toEqual([])
    const given = save(single, (t) => void t[1]!.columns.push(column('ship_to', 'character(2)', { domain: 'country_code' })))
    expect(given.changes).toEqual([{ kind: 'add_column', table: 'invoice', name: 'ship_to' }])
    expect(given.files[0]!.text).toMatch(/<NAME>ship_to<\/NAME>\s*<ID>NEW-1<\/ID>\s*<DESC><\/DESC>\s*<DOMAINID>D1<\/DOMAINID>\s*<DT>\s*<DTLISTNAME>CHARACTER<\/DTLISTNAME>\s*<LE>2<\/LE>/)
    expect(readDezign(given.files[0]!.text).tables[1]!.columns.at(-1)).toMatchObject({ name: 'ship_to', dataType: 'character(2)', domain: 'country_code' })

    // A type of its own takes the column out of the domain.
    const own = save(single, (t) => void Object.assign(t[0]!.columns[3]!, { dataType: 'varchar(3)', domain: undefined }))
    expect(own.changes).toEqual([{ kind: 'alter_column', table: 'customer', name: 'country' }])
    expect(readDezign(own.files[0]!.text).tables[0]!.columns[3]).toMatchObject({ dataType: 'varchar(3)' })
    expect(readDezign(own.files[0]!.text).tables[0]!.columns[3]!.domain).toBeUndefined()

    // A domain and another type at once, or a domain the project does not have, is said so and nothing is written.
    expect(() => save(single, (t) => void (t[0]!.columns[3]!.dataType = 'varchar(3)'))).toThrow(/follows the domain "country_code", whose type is character\(2\)/)
    expect(() => save(single, (t) => void (t[0]!.columns[1]!.domain = 'email'))).toThrow(/no domain "email" \(it has: country_code\)/)
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

  it('writes changed check constraints: a column check that changed becomes a table check', () => {
    const r = save(single, (t) => {
      t[0]!.checks = [{ expression: 'credit >= 0 and credit < 1000000', name: 'credit_range' }]
      t[1]!.checks = [{ expression: 'issued > DATE \'2020-01-01\'' }]
    })
    expect(r.changes.map((c) => `${c.kind} ${c.table}`)).toEqual(['drop_check customer', 'add_check customer', 'add_check invoice'])
    const out = r.files[0]!.text
    expect(out).not.toContain('<VALUE>credit &gt;= 0</VALUE>')
    expect(out).toMatch(/<NAME>credit_range<\/NAME>\s*<ID>[^<]+<\/ID>\s*<VALUE>credit &gt;= 0 and credit &lt; 1000000<\/VALUE>\s*<CONLEVEL>2<\/CONLEVEL>\s*<CONTYPE>1<\/CONTYPE>\s*<ATTRIBUTEIDS>\s*<ATTRIBUTEID>A3<\/ATTRIBUTEID>/)
    const after = readDezign(out).tables
    expect(after[0]!.checks).toEqual([{ expression: 'credit >= 0 and credit < 1000000', name: 'credit_range' }])
    expect(after[1]!.checks).toEqual([{ expression: "issued > DATE '2020-01-01'", name: 'TCC_invoice_1' }])
    // The unique constraint that shares the list with the new check is still there.
    expect(after[0]!.indexes).toHaveLength(1)
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
    expect(r.changes).toEqual([{ kind: 'add_to_diagram', table: 'invoice', name: 'd2' }, { kind: 'move_table', table: 'customer' }])
    // Both ends of the relationship are on the diagram now: its line is drawn there too.
    expect(r.files[0]!.text).toMatch(/<RELC>\s*<ID>30<\/ID>\s*<DIAGRAMID>2<\/DIAGRAMID>/)
    const second = readDezign(r.files[0]!.text).diagrams[1]!
    expect(second.tables).toEqual(['shop.customer', 'shop.invoice'])
    // The diagram's origin was the customer at 900,900: it moved 40 right, the invoice went to 300,120 from there.
    expect(r.files[0]!.text).toMatch(/<ID>10<\/ID>\s*<DIAGRAMID>2<\/DIAGRAMID>\s*<W>120<\/W>\s*<H>44<\/H>\s*<L>940<\/L>\s*<T>900<\/T>/)
    expect(r.files[0]!.text).toMatch(/<ID>20<\/ID>\s*<DIAGRAMID>2<\/DIAGRAMID>\s*<W>120<\/W>\s*<H>44<\/H>\s*<L>1200<\/L>\s*<T>1020<\/T>/)
    // The main diagram is not touched.
    expect(readDezign(r.files[0]!.text).positions).toEqual(readDezign(dez).positions)
  })

  it('reports the notes of a diagram that shows no table, and empty notes', () => {
    const lonely = dez.replace("<TEXTC>\n<ID>T1</ID>\n<DIAGRAMID>1</DIAGRAMID>", "<TEXTC>\n<ID>T1</ID>\n<DIAGRAMID>3</DIAGRAMID>").replace(diagram('2', 0), `${diagram('2', 0)}\n${diagram('3', 0)}`).replace('<TEXT>Prodej</TEXT>', '<TEXT></TEXT>')
    const third = readDezign(lonely).diagrams[2]!
    expect(third).toMatchObject({ id: '3', tables: [], notes: [{ id: 'T1', text: '', x: 90, y: 10 }] })
    // Sent back as loaded, nothing is taken away.
    const tables = model([{ path: 'shop.dez', text: lonely }])
    expect(saveToDezign([{ path: 'shop.dez', text: lonely }], tables, tables, { normalize: viaDbml, diagrams: diagramsAsLoaded(readDezign(lonely)) }).changes).toEqual([])
  })

  it('saves the text and place of an edited text area', () => {
    const tables = model(single)
    const r = saveToDezign(single, tables, model(single), { normalize: viaDbml, diagrams: { '1': { notes: [{ id: 'T1', text: 'Prodej a fakturace', x: 40, y: -40 }] } } })
    expect(r.changes).toEqual([{ kind: 'alter_note', table: 'Prodej a fakturace' }])
    expect(changedLines(dez, r.files[0]!.text)).toEqual(['<TEXT>Prodej a fakturace</TEXT>', '<L>140</L>'])
  })

  it('makes a new diagram, and takes a table off a diagram together with its relationship lines', () => {
    const tables = model(single)
    seq = 0
    const made = saveToDezign(single, tables, model(single), { normalize: viaDbml, diagrams: { 'new:1': { name: 'Fakturace', exact: true, tables: ['shop.customer', 'shop.invoice'], positions: { 'shop.customer': { x: 0, y: 0 }, 'shop.invoice': { x: 400, y: 0 } } } } })
    expect(made.changes).toEqual([
      { kind: 'add_diagram', table: 'Fakturace' },
      { kind: 'add_to_diagram', table: 'customer', name: 'Fakturace' },
      { kind: 'add_to_diagram', table: 'invoice', name: 'Fakturace' },
    ])
    const afterMade = [{ path: 'shop.dez', text: made.files[0]!.text }]
    // Objects are numbered in this file (…, 30, 31): the diagram is 32.
    const third = readDezign(afterMade[0]!.text).diagrams[2]!
    expect(third).toMatchObject({ id: '32', name: 'Fakturace', main: false, tables: ['shop.customer', 'shop.invoice'], positions: { 'shop.invoice': { x: 400, y: 0 } } })
    expect(afterMade[0]!.text).toMatch(/<RELC>\s*<ID>30<\/ID>\s*<DIAGRAMID>32<\/DIAGRAMID>/)
    expect(dezignIntegrity(afterMade[0]!.text)).toEqual([])

    // The invoice leaves the new diagram: its control and the line go, the table stays in the model and on the main diagram.
    const left = saveToDezign(afterMade, model(afterMade), model(afterMade), { normalize: viaDbml, diagrams: { '32': { exact: true, tables: ['shop.customer'] } } })
    expect(left.changes).toEqual([{ kind: 'remove_from_diagram', table: 'invoice', name: 'Fakturace' }])
    const out = left.files[0]!.text
    expect(out).not.toMatch(/<DIAGRAMID>32<\/DIAGRAMID>\s*<W>\d+<\/W>[\s\S]{0,80}<ID>20<\/ID>/)
    expect(out).not.toMatch(/<RELC>\s*<ID>30<\/ID>\s*<DIAGRAMID>32<\/DIAGRAMID>/)
    expect(readDezign(out).diagrams.map((d) => d.tables.length)).toEqual([2, 1, 1])
    expect(readDezign(out).tables).toHaveLength(2)
    expect(dezignIntegrity(out)).toEqual([])
    // Without `exact` a shorter list takes nothing away.
    expect(saveToDezign(afterMade, model(afterMade), model(afterMade), { normalize: viaDbml, diagrams: { '32': { tables: ['shop.customer'] } } }).changes).toEqual([])
  })

  it('adds, removes and recolors what is on a diagram', () => {
    const tables = model(single)
    seq = 0
    const r = saveToDezign(single, tables, model(single), {
      normalize: viaDbml,
      newId: () => `NEW-${++seq}`,
      diagrams: { '1': { notes: [{ id: 'fresh', text: 'Fakturace\nod roku 2026', x: 300, y: 400 }], colors: { 'shop.customer': '#cfe0f7', 'shop.invoice': null, 'shop.unknown': '#ffffff' } } },
    })
    // The old text area is not in the list any more; the new one is; the customer gets a color and the invoice loses its own.
    expect(r.changes).toEqual([
      { kind: 'drop_note', table: 'Prodej' },
      { kind: 'add_note', table: 'Fakturace' },
      { kind: 'color_table', table: 'customer' },
      { kind: 'color_table', table: 'invoice' },
    ])
    const out = r.files[0]!.text
    expect(out).not.toContain('<TEXT>Prodej</TEXT>')
    expect(out).toMatch(/<TEXTAR>\s*<NAME>TextArea1<\/NAME>\s*<ID>32<\/ID>\s*<TEXT>Fakturace\nod roku 2026<\/TEXT>/)
    const after = readDezign(out).diagrams[0]!
    expect(after.notes).toEqual([{ id: '32', text: 'Fakturace\nod roku 2026', x: 300, y: 400 }])
    // #cfe0f7 as a Delphi color is 0xF7E0CF; the invoice went back to the fill the other tables have.
    expect(after.colors).toEqual({ 'shop.customer': '#cfe0f7' })
    expect(out).toContain('<BRUSH>0,16244943</BRUSH>')
    expect(dezignIntegrity(out)).toEqual([])
    // Saying the same again changes nothing.
    const again = saveToDezign([{ path: 'shop.dez', text: out }], tables, tables, { normalize: viaDbml, diagrams: { '1': { notes: after.notes, colors: { 'shop.customer': '#cfe0f7' } } } })
    expect(again.changes).toEqual([])
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

  // 2 projects × 25 chains × 6 edits, each saved twice and read back: seconds on a slow CI runner.
  it('survives chains of random edits: each save reads back as edited, keeps every reference valid and is final', { timeout: 120_000 }, () => {
    const counts: Record<string, number> = {}
    for (const [label, start] of [['file', single], ['folder', folder]] as const) {
      for (let seed = 1; seed <= (CHAINS || 25); seed++) {
        const rnd = random(seed)
        let files = start
        for (let step = 0; step < 6; step++) {
          const base = model(files)
          const edited = model(files)
          const op = mutate(edited, rnd, seed * 10 + step)
          const target = viaDbml(edited)
          const where = `${label} seed ${seed} step ${step} (${op})`
          let saved
          try {
            saved = saveToDezign(files, base, target, { normalize: viaDbml })
          } catch (err) {
            throw new Error(`${where}: ${err instanceof Error ? err.message : String(err)}`)
          }
          files = applyDezignSave(files, saved)
          expect(dezignIntegrity(files.length > 1 ? assembleDezignProject(files) : files[0]!.text), where).toEqual([])
          // Saving what was just saved changes nothing.
          const again = saveToDezign(files, model(files), model(files), { normalize: viaDbml })
          expect(again.files.length + again.deleted.length + again.changes.length, where).toBe(0)
          counts[op] = (counts[op] ?? 0) + 1
        }
      }
    }
    // Every kind of edit took part.
    expect(Object.keys(counts).filter((k) => k !== 'nothing').length).toBeGreaterThanOrEqual(14)
  })

  it('drops a supertype together with its subtype cluster', () => {
    // The invoice hangs on a subtype cluster of the customer instead of on the customer itself.
    const clustered = dez
      .replace('<RELATIONSHIPS>', '<SUBCATEGORIES>\n<SUBCAT>\n<NAME>kinds</NAME>\n<ID>40</ID>\n<AOID>10</AOID>\n</SUBCAT>\n</SUBCATEGORIES>\n<SUBCATEGORYCONNECTIONS>\n<SUBCATEGORYCONNECTION>\n<ID>41</ID>\n<PARENTOBJECTID>10</PARENTOBJECTID>\n<CHILDOBJECTID>40</CHILDOBJECTID>\n</SUBCATEGORYCONNECTION>\n</SUBCATEGORYCONNECTIONS>\n<RELATIONSHIPS>')
      .replace('<ID>30</ID>\n<PARENTOBJECTID>10</PARENTOBJECTID>', '<ID>30</ID>\n<PARENTOBJECTID>40</PARENTOBJECTID>')
      .replace('</ENTITYCONTROLS>', '</ENTITYCONTROLS>\n<SUBCATEGORYCONTROLS>\n<SUBCATC>\n<ID>40</ID>\n<DIAGRAMID>1</DIAGRAMID>\n</SUBCATC>\n</SUBCATEGORYCONTROLS>\n<SUBCATEGORYCONNECTORS>\n<SUBCATEGORYCONNECTOR>\n<ID>41</ID>\n<DIAGRAMID>1</DIAGRAMID>\n</SUBCATEGORYCONNECTOR>\n</SUBCATEGORYCONNECTORS>')
    const files = [{ path: 'shop.dez', text: clustered }]
    expect(dezignIntegrity(clustered)).toEqual([])
    expect(model(files)[1]!.foreignKeys[0]).toMatchObject({ refTable: 'customer' })
    const r = save(files, (t) => t.filter((x) => x.name !== 'customer').map((x) => ({ ...x, foreignKeys: [] })))
    const out = r.files[0]!.text
    expect(dezignIntegrity(out)).toEqual([])
    for (const gone of ['<SUBCAT>', '<SUBCATEGORYCONNECTION>', '<SUBCATC>', '<SUBCATEGORYCONNECTOR>', 'customer_invoice']) expect(out).not.toContain(gone)
    expect(readDezign(out).tables.map((t) => t.name)).toEqual(['invoice'])
  })

  it('drops a supertype together with its subtype cluster', () => {
    // party (10) is the supertype; cluster 50 hangs off it through link 51, and person (20) is its subtype.
    const ent = (id: string, name: string, attrId: string) => `<ENT>\n<NAME>${name}</NAME>\n<ID>${id}</ID>\n<PKCON>\n<ATTRIBUTEIDS>\n<ATTRIBUTEID>${attrId}</ATTRIBUTEID>\n</ATTRIBUTEIDS>\n</PKCON>\n<ATTRIBUTES>\n${attr(attrId, 'id', 'INTEGER', '', notNull)}\n</ATTRIBUTES>\n</ENT>`
    const file = `<?xml version="1.0" encoding="iso-8859-1"?><dezign>
<VERSION>
<DATADICT>
<DBID>postgresql16</DBID>
<ENTITIES>
${ent('10', 'party', 'P1')}
${ent('20', 'person', 'Q1')}
${ent('30', 'other', 'R1')}
</ENTITIES>
<SUBCATEGORIES>
<SUBCAT>
<NAME>SubCategory1</NAME>
<ID>50</ID>
<AOID>10</AOID>
</SUBCAT>
</SUBCATEGORIES>
<RELATIONSHIPS>
<REL>
<NAME>party_person</NAME>
<ID>60</ID>
<PARENTOBJECTID>50</PARENTOBJECTID>
<CHILDOBJECTID>20</CHILDOBJECTID>
<RELTYPE>2</RELTYPE>
<PAIRS>
<PAIR>
<KEYID>P1</KEYID>
<FOREIGNKEYID>Q1</FOREIGNKEYID>
</PAIR>
</PAIRS>
</REL>
</RELATIONSHIPS>
<SUBCATEGORYCONNECTIONS>
<SUBCATEGORYCONNECTION>
<ID>51</ID>
<PARENTOBJECTID>10</PARENTOBJECTID>
<CHILDOBJECTID>50</CHILDOBJECTID>
</SUBCATEGORYCONNECTION>
</SUBCATEGORYCONNECTIONS>
</DATADICT>
<DIAGRAMS>
<CONTROLS>
<SUBCATEGORYCONTROLS>
<SUBCATC>
<ID>50</ID>
</SUBCATC>
</SUBCATEGORYCONTROLS>
<SUBCATEGORYCONNECTORS>
<SUBCATEGORYCONNECTOR>
<ID>51</ID>
</SUBCATEGORYCONNECTOR>
</SUBCATEGORYCONNECTORS>
</CONTROLS>
</DIAGRAMS>
</VERSION>
</dezign>`
    const files = [{ path: 'm.dez', text: file }]
    expect(model(files)[1]!.foreignKeys).toHaveLength(1)
    const r = save(files, (t) => t.filter((x) => x.name !== 'party').map((x) => ({ ...x, foreignKeys: [] })))
    expect(r.changes).toEqual([{ kind: 'drop_table', table: 'party' }])
    const out = r.files[0]!.text
    for (const gone of ['<SUBCAT>', '<SUBCATC>', '<SUBCATEGORYCONNECTION>', '<SUBCATEGORYCONNECTOR>', '<REL>', 'party']) expect(out).not.toContain(gone)
    expect(dezignIntegrity(out)).toEqual([])
    expect(readDezign(out).tables.map((t) => t.name)).toEqual(['person', 'other'])
  })

  it('survives chains of random diagram edits: tables joining and leaving diagrams, new diagrams, notes, colors', { timeout: 120_000 }, () => {
    const done: Record<string, number> = {}
    for (const [label, start] of [['file', single], ['folder', folder]] as const) {
      for (let seed = 1; seed <= (CHAINS || 20); seed++) {
        const rnd = random(seed * 31)
        let files = start
        const binary = () => (files.length > 1 ? assembleDezignProject(files) : files[0]!.text)
        const asIs = () => diagramsAsLoaded(readDezign(binary()))
        for (let step = 0; step < 6; step++) {
          const tables = model(files)
          const wanted = asIs()
          const op = mutateDiagrams(wanted, tables.map((t) => `${t.schema ?? ''}.${t.name}`), rnd, seed * 10 + step)
          const where = `${label} seed ${seed} step ${step} (${op})`
          let saved
          try {
            saved = saveToDezign(files, tables, model(files), { normalize: viaDbml, diagrams: wanted })
          } catch (err) {
            throw new Error(`${where}: ${err instanceof Error ? err.message : String(err)}`)
          }
          files = applyDezignSave(files, saved)
          expect(dezignIntegrity(binary()), where).toEqual([])
          // The model itself is untouched by diagram edits, and sending the new state back changes nothing.
          expect(model(files), where).toEqual(tables)
          const again = saveToDezign(files, tables, model(files), { normalize: viaDbml, diagrams: asIs() })
          expect(again.changes, where).toEqual([])
          done[op] = (done[op] ?? 0) + 1
        }
      }
    }
    expect(Object.keys(done).filter((k) => k !== 'nothing')).toHaveLength(8)
  })

  it('survives chains that mix model and diagram edits, as a working session does', { timeout: 600_000 }, () => {
    for (const [label, start] of [['file', single], ['folder', folder]] as const) {
      for (let seed = 1; seed <= (CHAINS || 15); seed++) {
        const rnd = random(seed * 977)
        let files = start
        const binary = () => (files.length > 1 ? assembleDezignProject(files) : files[0]!.text)
        for (let step = 0; step < 8; step++) {
          const base = model(files)
          const edited = model(files)
          const ops = [rnd() < 0.7 ? mutate(edited, rnd, seed * 10 + step) : 'nothing']
          const target = viaDbml(edited)
          const wanted = diagramsAsLoaded(readDezign(binary()))
          // Diagrams are told about the model as it is after the edit: a renamed or dropped table is not on them by its old name.
          const keys = target.map((t) => `${t.schema ?? ''}.${t.name}`)
          for (const w of Object.values(wanted)) if (w.tables) w.tables = w.tables.filter((k) => keys.includes(k))
          if (rnd() < 0.6) ops.push(mutateDiagrams(wanted, keys, rnd, seed * 10 + step))
          const where = `${label} seed ${seed} step ${step} (${ops.join(' + ')})`
          let saved
          try {
            saved = saveToDezign(files, base, target, { normalize: viaDbml, diagrams: wanted })
          } catch (err) {
            throw new Error(`${where}: ${err instanceof Error ? err.message : String(err)}`)
          }
          files = applyDezignSave(files, saved)
          expect(dezignIntegrity(binary()), where).toEqual([])
          const again = saveToDezign(files, model(files), model(files), { normalize: viaDbml, diagrams: diagramsAsLoaded(readDezign(binary())) })
          expect(again.changes, where).toEqual([])
        }
      }
    }
  })

  it('finds references that point nowhere', () => {
    expect(dezignIntegrity(dez)).toEqual([])
    expect(dezignIntegrity(dez.replace('<KEYID>A1</KEYID>', '<KEYID>A9</KEYID>').replace('<ATTRIBUTEID>A2</ATTRIBUTEID>', '<ATTRIBUTEID>zz</ATTRIBUTEID>'))).toEqual([
      'entity 10: CONSTRAINT lists unknown attribute zz',
      'relationship 30: key A9 is not in the parent',
    ])
  })

  it('refuses a result that would not read back as edited', () => {
    // A column typed with something the file cannot hold round-trips differently: nothing is returned.
    expect(() => saveToDezign(single, model(single), model(single), { normalize: () => [] })).toThrow(/could not be written safely/)
  })
})

describe('what a database needs from a DeZign model', () => {
  // A MySQL model: an ENUM with its values, defaults typed without quotes, and a column that follows a domain
  // whose check says `value` for the column.
  const file = `<?xml version="1.0" encoding="iso-8859-1"?><dezign>
<VERSION>
${settings}
<DATADICT>
<DBID>mysql8</DBID>
<DOMAINS>
<DOMAIN>
<NAME>grade</NAME>
<ID>D9</ID>
<DT>
<DTLISTNAME>CHAR</DTLISTNAME>
<LE>1</LE>
</DT>
<CCON>
<VALUE>value IS NULL OR value IN ('A','B')</VALUE>
</CCON>
</DOMAIN>
</DOMAINS>
<ENTITIES>
<ENT>
<NAME>Users</NAME>
<ID>10</ID>
<ATTRIBUTES>
${attr('U1', 'id', 'INT', '<LE>11</LE>\n', notNull)}
${attr('U2', 'kind', 'ENUM', '', '<DEFCON>\n<VALUE>free</VALUE>\n</DEFCON>\n').replace('<INC>1</INC>', "<INC>1</INC>\n<ITMS>'admin','free'</ITMS>")}
${attr('U3', 'visits', 'INT', '', '<DEFCON>\n<VALUE>0</VALUE>\n</DEFCON>\n')}
${attr('U4', 'since', 'VARCHAR', '<LE>30</LE>\n', '<DEFCON>\n<VALUE>CURRENT_USER</VALUE>\n</DEFCON>\n')}
${attr('U5', 'Grade', 'CHAR', '<LE>1</LE>\n', "<CCON>\n<VALUE>value IS NULL OR value IN ('A','B')</VALUE>\n</CCON>\n").replace('<DOMAINID></DOMAINID>', '<DOMAINID>D9</DOMAINID>')}
</ATTRIBUTES>
</ENT>
</ENTITIES>
</DATADICT>
</VERSION>
</dezign>`

  it('reads the values of an ENUM, quotes a word typed as a text default, and keeps a domain check on its column', () => {
    const model = readDezign(file)
    const [users] = model.tables
    expect(users!.columns.map((c) => [c.name, c.dataType, c.defaultValue])).toEqual([
      ['id', 'int(11)', null],
      ['kind', "enum('admin','free')", "'free'"],
      ['visits', 'int', '0'],
      ['since', 'varchar(30)', 'CURRENT_USER'],
      ['Grade', 'char(1)', null],
    ])
    expect(users!.checks).toEqual([{ expression: "value IS NULL OR value IN ('A','B')", column: 'Grade' }])
    expect(dezignDriver(model.targetDatabase)).toBe('mysql')
    expect([dezignDriver('postgresql16'), dezignDriver('mssqlserver2022'), dezignDriver('oracle12'), dezignDriver('dbindependent')]).toEqual(['postgres', 'mssql', 'oracle', undefined])
    // DBML keeps all of it.
    const text = toDbml(model.tables)
    expect(text).toContain("kind enum('admin','free') [default: 'free']")
    expect(text).toContain("check: `value IS NULL OR value IN ('A','B')`")
    expect(parseDbml(text).tables[0]!.checks).toEqual(users!.checks)
    expect(parseDbml(text).tables[0]!.columns[1]!.dataType).toBe("enum('admin','free')")
  })

  it('writes DDL for its own database as the model has it, and for another one translated', () => {
    const { tables, targetDatabase } = readDezign(file)
    const from = dezignDriver(targetDatabase)
    const mysql = createScript(tables, getDialect('mysql'), { translateTypes: true, from })
    expect(mysql).toContain("`kind` enum('admin','free') DEFAULT 'free'")
    expect(mysql).toContain('`id` int(11) NOT NULL')
    expect(mysql).toContain("CHECK (`Grade` IS NULL OR `Grade` IN ('A','B'))")
    const postgres = createScript(tables, getDialect('postgres'), { translateTypes: true, from })
    expect(postgres).toContain(`"kind" varchar(255) DEFAULT 'free'`)
    expect(postgres).toContain('"id" integer NOT NULL')
    expect(postgres).toContain(`CHECK ("Grade" IS NULL OR "Grade" IN ('A','B'))`)
  })

  it('saves a changed list of ENUM values', () => {
    const viaDbml = (tables: TableInfo[]) => parseDbml(toDbml(tables)).tables
    const base = viaDbml(readDezign(file).tables)
    const target = structuredClone(base)
    target[0]!.columns[1]!.dataType = "enum('admin','free','premium')"
    const saved = saveToDezign([{ path: 'm.dez', text: file }], base, target, { normalize: viaDbml })
    expect(saved.changes.map((c) => c.kind)).toEqual(['alter_column'])
    expect(saved.files[0]!.text).toContain("<DTLISTNAME>ENUM</DTLISTNAME>")
    expect(saved.files[0]!.text).toContain("<ITMS>'admin','free','premium'</ITMS>")
    expect(readDezign(saved.files[0]!.text).tables[0]!.columns[1]!.dataType).toBe("enum('admin','free','premium')")
  })
})

describe('a new DeZign project from a model made here', () => {
  const dbml = `
Table shop.customers {
  id bigint [pk, increment]
  email varchar(120) [not null, unique, note: 'Přihlašovací e-mail']
  active boolean [not null, default: true]

  checks {
    \`email <> ''\` [name: 'email_filled']
  }

  Note: 'Zákazníci obchodu'
}
Table shop.orders {
  id bigint [pk]
  customer_id bigint [not null, ref: > shop.customers.id]
  placed timestamp

  indexes {
    (customer_id, placed) [name: 'orders_by_customer']
  }
}
Ref: shop.orders.customer_id > shop.customers.id [delete: cascade]
`
  const tables = parseDbml(dbml.replace(/\n  customer_id bigint \[not null, ref: > shop.customers.id\]/, '\n  customer_id bigint [not null]')).tables
  let n = 0
  const make = (database?: 'postgres' | 'mssql' | 'mysql') => {
    n = 0
    return newDezignProject(tables, { database, newId: () => `ID-${++n}`, today: '2026-11-10', positions: { 'shop.orders': { x: 500, y: 60 } } })
  }

  it('holds the whole model and passes the reference check', () => {
    const file = make()
    expect(file.startsWith('<?xml version="1.0" encoding="iso-8859-1"?><dezign>\n<VERSION>\n<PROJECTSETTINGS>')).toBe(true)
    expect(dezignIntegrity(file)).toEqual([])
    const model = readDezign(file)
    expect(model).toMatchObject({ formatVersion: '140', targetDatabase: 'postgresql16', encoding: 'windows-1250' })
    const [customers, orders] = model.tables
    expect(customers).toMatchObject({ schema: 'shop', name: 'customers', comment: 'Zákazníci obchodu', primaryKey: ['id'], checks: [{ expression: "email <> ''", name: 'email_filled' }] })
    expect(customers!.columns.map((c) => `${c.name} ${c.dataType}${c.nullable ? '' : ' not null'}${c.isIdentity ? ' identity' : ''}${c.defaultValue ? ` = ${c.defaultValue}` : ''}`)).toEqual(['id bigint not null identity', 'email varchar(120) not null', 'active boolean not null = true'])
    expect(customers!.columns[1]!.comment).toBe('Přihlašovací e-mail')
    expect(customers!.indexes).toEqual([{ name: 'ux_customers_email', columns: ['email'], unique: true, primary: false, constraint: true }])
    expect(orders!.foreignKeys).toEqual([{ name: 'customers_orders', columns: ['customer_id'], refSchema: 'shop', refTable: 'customers', refColumns: ['id'], onDelete: 'CASCADE' }])
    expect(orders!.indexes).toEqual([{ name: 'orders_by_customer', columns: ['customer_id', 'placed'], unique: false, primary: false }])
    // The table somebody placed is where they put it; the other one sits on the grid; the relationship is drawn.
    expect(model.positions).toEqual({ 'shop.customers': { x: 0, y: 0 }, 'shop.orders': { x: 460, y: 20 } })
    expect(file).toMatch(/<RELATIONSHIPCONNECTORS>\s*<RELC>/)
    // The same model through DBML again is the same model.
    expect(parseDbml(toDbml(model.tables)).errors).toEqual([])
  })

  it('is made for the chosen database, with its types', () => {
    const mssql = readDezign(make('mssql'))
    expect(mssql.targetDatabase).toBe('mssqlserver2022')
    expect(mssql.tables[0]!.columns[2]!.dataType).toBe('bit')
    expect(readDezign(make('mysql')).targetDatabase).toBe('mysql8')
  })

  it('can be opened and saved into like any other project', () => {
    const files = [{ path: 'new.dez', text: make() }]
    const viaDbml = (t: TableInfo[]) => parseDbml(toDbml(t)).tables
    const base = viaDbml(readDezign(files[0]!.text).tables)
    expect(saveToDezign(files, base, viaDbml(readDezign(files[0]!.text).tables), { normalize: viaDbml }).changes).toEqual([])
    const edited = viaDbml(readDezign(files[0]!.text).tables)
    edited[1]!.columns.push({ name: 'total', ordinal: 9, dataType: 'numeric(12,2)', nullable: true, isPrimaryKey: false, isIdentity: false })
    const saved = saveToDezign(files, base, viaDbml(edited), { normalize: viaDbml })
    expect(saved.changes).toEqual([{ kind: 'add_column', table: 'orders', name: 'total' }])
    expect(readDezign(saved.files[0]!.text).tables[1]!.columns.map((c) => c.name)).toEqual(['id', 'customer_id', 'placed', 'total'])
  })

  it('writes an empty model as an empty project', () => {
    const file = newDezignProject([], { newId: () => 'X', today: '2026-11-10' })
    expect(dezignIntegrity(file)).toEqual([])
    expect(() => readDezign(file)).not.toThrow()
    expect(readDezign(file).tables).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { diagramsAsLoaded, mutate, mutateDiagrams, random } from './dezign-fuzz.js'

// More chains for a long local run: DBM_FUZZ_CHAINS=500 npx vitest run --root packages/core test/dezign.test.ts
const CHAINS = Number(process.env.DBM_FUZZ_CHAINS) || 0
import { applyDezignSave, archiveDezignVersion, assembleDezignProject, dezignAsFolder, dezignDomainsOfModel, withDezignDomains, compareSchemas, createScript, detectDezignEncoding, dezignDriver, dezignFolderAsVersion, dezignIntegrity, dezignMigrationOptions, dezignWrapScript, generateMigration, getDialect, unquotedNames, listDezignVersions, newDezignProject, parseDbml, parseDezignXml, readDezign, saveToDezign, serializeDezignXml, toDbml, type DezignFile, type TableInfo } from '../src/index.js'

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
    expect(readDezign(dez).leftOut).toEqual({ domains: 1, views: 1, procedures: 0, sequences: 1, triggers: 0, checks: 0, relationshipsWithoutColumns: 1, subdiagrams: 1, objectNotes: 0 })
    // DeZign's "Notes" next to a description: a table's and a column's are the model's remarks, a relationship's
    // are counted (kept in the file).
    const noted = dez.replace('<NAME>customer</NAME>', '<NAME>customer</NAME>\n<NOTE>Ask the owner before changing</NOTE>').replace(/(<REL>\n<NAME>customer_invoice<\/NAME>\n)/, '$1<NOTE>Billing</NOTE>\n')
    expect(readDezign(noted).leftOut.objectNotes).toBe(1)
    expect(readDezign(noted).tables[0]!.remarks).toBe('Ask the owner before changing')
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
    // A sequence that starts at 0 needs a minimum to match: databases default it to 1.
    expect(readDezign(dez.replace('<SEED>1000</SEED>', '<SEED>0</SEED>')).sqlObjects[0]!.sql).toBe('CREATE SEQUENCE shop.invoice_no INCREMENT BY 1 START WITH 0 MINVALUE 0')
  })

  it('becomes DBML that reads back the same', () => {
    const model = readDezign(dez)
    const dbml = toDbml(model.tables)
    expect(dbml).toContain('Table shop.customer {')
    expect(dbml).toContain('Ref FK_customer_invoice: shop.invoice.customer_id > shop.customer.id [delete: restrict, update: cascade]')
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

  // What DeZign archives of a folder project, and what it writes for "Save project as → Single file".
  it('turns a folder project into the one VERSION element of a single-file project, holding the same model', () => {
    const version = dezignFolderAsVersion(folder, '<VERSIONINFO>\n<VERSIONNUMBER>3</VERSIONNUMBER>\n</VERSIONINFO>')
    expect(version.startsWith('<VERSION>\r\n<VERSIONINFO>\r\n<VERSIONNUMBER>3</VERSIONNUMBER>\r\n</VERSIONINFO>\r\n<PROJECTSETTINGS>')).toBe(true)
    const single = readDezign(`<?xml version="1.0" encoding="iso-8859-1"?><dezign>\r\n${version}</dezign>`, { archived: 0 })
    const assembled = readDezign(assembleDezignProject(folder))
    expect(single.tables).toEqual(assembled.tables)
    expect(single.positions).toEqual(assembled.positions)
    expect(single.targetDatabase).toBe('postgresql16')
    expect(dezignIntegrity(`<dezign>\n${version}</dezign>`)).toEqual([])
    // A part of the project that is not known here stops it: a snapshot that leaves something out is no snapshot.
    expect(() => dezignFolderAsVersion([...folder, { path: 'data dictionary/somethingnew/x.xml', text: xml('<X>\n</X>') }])).toThrow(/somethingnew/)
  })

  // As DeZign 14.9.3 archives (checked byte for byte against its own files, project path apart).
  it('archives the project as a version DeZign lists, and it reads back as the model it was', () => {
    // (The fixture already has version 1.)
    const one = archiveDezignVersion(single, { label: 'Před úpravami', comments: 'Řádek 1\nŘádek 2 & další', date: '2026-11-11 18:00:00', id: 'V-1' })
    expect(one.number).toBe(2)
    const text = one.files[0]!.text
    expect(text).toMatch(/<\/VERSION><VERSION>\n<VERSIONINFO>\n<VERSIONID>V-1<\/VERSIONID>\n<VERSIONNUMBER>2<\/VERSIONNUMBER>/)
    const listed = listDezignVersions(text)
    expect(listed).toContainEqual({ number: '2', label: 'Před úpravami', date: '2026-11-11 18:00:00', comments: 'Řádek 1\nŘádek 2 & další' })
    // The working model stays what it was; the archived one is a copy of it.
    expect(readDezign(text).tables).toEqual(readDezign(single[0]!.text).tables)
    expect(readDezign(text, { archived: listed.findIndex((v) => v.number === '2') }).tables).toEqual(readDezign(single[0]!.text).tables)
    const two = archiveDezignVersion([{ path: 'shop.dez', text }], { date: '2026-11-12 09:30:00', id: 'V-2' })
    expect(two.number).toBe(3)
    expect(listDezignVersions(two.files[0]!.text).map((v) => v.number).sort()).toEqual(['1', '2', '3'])
    expect(dezignIntegrity(two.files[0]!.text)).toEqual(dezignIntegrity(single[0]!.text))

    // A folder project: a file of its own in "archived versions", numbered past the ones it has.
    const f = archiveDezignVersion(folder, { date: '2026-11-11 18:00:00', id: 'V-3' }, [1, 4])
    expect(f.number).toBe(5)
    expect(f.files.map((x) => x.path)).toEqual(['archived versions/V-3.xml'])
    const body = f.files[0]!.text
    expect(body.startsWith('<?xml version="1.0" encoding="iso-8859-1"?><VERSION>\r\n<VERSIONINFO>')).toBe(true)
    expect(listDezignVersions(body)[0]).toMatchObject({ number: '5', label: 'Version 2026-11-11 18:00:00' })
    expect(readDezign(`<dezign>\n${body.replace(/^<\?xml[^>]*\?>/, '')}\n</dezign>`, { archived: 0 }).tables).toEqual(readDezign(assembleDezignProject(folder)).tables)
  })

  // DISPLAYLEVEL and VISIBLEATTR as DeZign 14.9.3 wrote them when they were set in its Diagram menu.
  it('reads and writes what a diagram\'s tables show: display level, data types, hidden columns', () => {
    const shown = (text: string) => dez.replace('<NAME>d2</NAME>\n<ISMAINDIAGRAM>0</ISMAINDIAGRAM>', `<NAME>d2</NAME>\n<ISMAINDIAGRAM>0</ISMAINDIAGRAM>\n${text}`)
    const text = shown('<DISPLAYLEVEL>2</DISPLAYLEVEL>\n<VISIBLEATTR>4</VISIBLEATTR>').replace('<BRUSH>0,16119285</BRUSH>\n</ENTC>', '<BRUSH>0,16119285</BRUSH>\n<HIDDENATTR>A2,\r\nA3</HIDDENATTR>\n</ENTC>')
    expect(text).toContain('<VISIBLEATTR>4<')
    const d2 = readDezign(text).diagrams.find((d) => d.name === 'd2')!
    expect(d2.display).toEqual({ columns: 'primary', types: 'domain' })
    const main = readDezign(text).diagrams.find((d) => d.main)!
    expect(main.display).toEqual({ columns: 'all', types: 'type', hidden: { 'shop.customer': ['email', 'credit'] } })
    const files: DezignFile[] = [{ path: 'shop.dez', text }]
    const r = saveToDezign(files, model(files), model(files), { normalize: viaDbml, diagrams: { [d2.id]: { display: { columns: 'keys', types: 'none' } }, [main.id]: { display: { hidden: { 'shop.customer': ['credit'] } } } } })
    expect(r.changes.map((c) => c.kind)).toEqual(['diagram_display', 'diagram_display'])
    const after = readDezign(r.files[0]!.text)
    expect(after.diagrams.find((d) => d.name === 'd2')!.display).toEqual({ columns: 'keys', types: 'none' })
    expect(after.diagrams.find((d) => d.main)!.display.hidden).toEqual({ 'shop.customer': ['credit'] })
    expect(r.files[0]!.text).toContain('<HIDDENATTR>A3</HIDDENATTR>')
    // Asked for what it is already: nothing to write.
    expect(saveToDezign(r.files, model(r.files), model(r.files), { normalize: viaDbml, diagrams: { [d2.id]: { display: { columns: 'keys', types: 'none' } } } }).files).toEqual([])
  })

  it('renames a diagram and takes one out with everything drawn on it, never the main one', () => {
    const d2 = readDezign(dez).diagrams.find((d) => !d.main)!
    const main = readDezign(dez).diagrams.find((d) => d.main)!
    const renamed = saveToDezign(single, model(single), model(single), { normalize: viaDbml, diagrams: { [d2.id]: { name: 'Fakturace' } } })
    expect(renamed.changes).toEqual([{ kind: 'rename_diagram', table: 'Fakturace', name: 'd2' }])
    expect(readDezign(renamed.files[0]!.text).diagrams.map((d) => d.name)).toContain('Fakturace')
    const gone = saveToDezign(single, model(single), model(single), { normalize: viaDbml, diagrams: { [d2.id]: { remove: true }, [main.id]: { remove: true } } })
    expect(gone.changes).toEqual([{ kind: 'drop_diagram', table: 'd2' }])
    const out = gone.files[0]!.text
    expect(readDezign(out).diagrams.map((d) => d.id)).toEqual([main.id])
    expect(out).not.toMatch(new RegExp(`<DIAGRAMID>${d2.id}</DIAGRAMID>`))
    expect(readDezign(out).tables).toEqual(readDezign(dez).tables)
    expect(dezignIntegrity(out)).toEqual(dezignIntegrity(dez))
    // A folder project loses the diagram's files.
    const fd = readDezign(assembleDezignProject(folder)).diagrams
    if (fd.length > 1) {
      const f = saveToDezign(folder, model(folder), model(folder), { normalize: viaDbml, diagrams: { [fd.find((d) => !d.main)!.id]: { remove: true } } })
      expect(f.deleted.length).toBeGreaterThan(0)
    }
  })

  it('saves group boxes: moved, resized and renamed, a new one, and one taken away', () => {
    const main = readDezign(dez).diagrams.find((d) => d.main)!
    expect(main.boxes.map((b) => b.title)).toEqual(['Fakturace'])
    const box = main.boxes[0]!
    const r = saveToDezign(single, model(single), model(single), { normalize: viaDbml, newId: () => 'GB-NEW', diagrams: { [main.id]: { boxes: [{ ...box, title: 'Faktury', x: box.x + 100, w: box.w + 50 }, { id: 'new', title: 'Sklad', x: 10, y: 600, w: 300, h: 200 }] } } })
    expect(r.changes.map((c) => `${c.kind} ${c.table}`)).toEqual(['alter_box Faktury', 'add_box Sklad'])
    const after = readDezign(r.files[0]!.text).diagrams.find((d) => d.main)!
    expect(after.boxes.map((b) => b.title)).toEqual(['Faktury', 'Sklad'])
    expect(after.boxes[0]!.w).toBeGreaterThan(box.w)
    expect(after.boxes[1]).toMatchObject({ x: 10, y: 600, w: 300, h: 200 })
    expect(dezignIntegrity(r.files[0]!.text)).toEqual(dezignIntegrity(dez))
    const gone = saveToDezign(r.files, model(r.files), model(r.files), { normalize: viaDbml, diagrams: { [main.id]: { boxes: [] } } })
    expect(gone.changes.map((c) => c.kind)).toEqual(['drop_box', 'drop_box'])
    expect(gone.files[0]!.text).not.toMatch(/<GROUPBOX>/)
    // The same list again: nothing to write.
    expect(saveToDezign(r.files, model(r.files), model(r.files), { normalize: viaDbml, diagrams: { [main.id]: { boxes: after.boxes } } }).files).toEqual([])
  })

  it('changes a domain\'s type with the columns that follow it, and makes a new domain', () => {
    const before = model(single)
    const target = viaDbml(model(single))
    for (const table of target) for (const c of table.columns) if (c.domain === 'country_code') c.dataType = 'character(3)'
    target[0]!.columns.push(column('balance', 'numeric(12,2)', { domain: 'money_t' }))
    const r = saveToDezign(single, before, viaDbml(target), { normalize: viaDbml, newId: () => 'D-NEW', domains: [{ name: 'country_code', dataType: 'character(3)' }, { name: 'money_t', dataType: 'numeric(12,2)', comment: 'Částka' }] })
    expect(r.changes.slice(0, 2)).toEqual([
      { kind: 'alter_domain', table: 'country_code', name: 'character(3)' },
      { kind: 'add_domain', table: 'money_t', name: 'numeric(12,2)' },
    ])
    const after = readDezign(r.files[0]!.text)
    expect(after.domains).toEqual([{ name: 'country_code', dataType: 'character(3)' }, { name: 'money_t', dataType: 'numeric(12,2)' }])
    expect(after.tables.flatMap((t) => t.columns).filter((c) => c.domain).map((c) => `${c.name} ${c.dataType} ${c.domain}`)).toEqual(['country character(3) country_code', 'balance numeric(12,2) money_t'])
    expect(dezignIntegrity(r.files[0]!.text)).toEqual(dezignIntegrity(dez))
    // The same domains again: nothing to write.
    expect(saveToDezign(r.files, model(r.files), model(r.files), { normalize: viaDbml, domains: [{ name: 'country_code', dataType: 'character(3)' }] }).files).toEqual([])
  })

  // As DeZign's "Save project as → Folder based" (checked byte for byte against DeZign 14.9.3's own, project path apart).
  it('turns a single-file project into a folder project that holds the same model', () => {
    const files = dezignAsFolder(dez, 'Shop')
    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining(['Shop.dezproj', 'Shop.dds', 'data dictionary/entities/10.xml', 'data dictionary/domains/D1.xml', 'diagrams/1.xml', 'diagrams/diagramobjects/entitycontrols/1-10.xml']))
    expect(files.every((f) => /^<\?xml version="1.0" encoding="iso-8859-1"\?>\n</.test(f.text) || f.path.startsWith('archived versions/'))).toBe(true)
    expect(files.find((f) => f.path === 'Shop.dds')!.text).toBe('<?xml version="1.0" encoding="iso-8859-1"?>\n<DATADICT>\n<DBID>postgresql16</DBID>\n</DATADICT>\n')
    const folder = readDezign(assembleDezignProject(files.filter((f) => !f.path.startsWith('archived versions/'))))
    expect(folder.tables).toEqual(readDezign(dez).tables)
    expect(folder.diagrams.map((d) => [d.name, d.tables, d.positions])).toEqual(readDezign(dez).diagrams.map((d) => [d.name, d.tables, d.positions]))
    // The archived version goes along, as a file of its own.
    expect(files.filter((f) => f.path.startsWith('archived versions/')).length).toBe(listDezignVersions(dez).length)
    expect(() => dezignAsFolder(dez.replace('</DATADICT>', '<SOMETHINGNEW>\n<X>\n</X>\n</SOMETHINGNEW>\n</DATADICT>'), 'Shop')).toThrow(/SOMETHINGNEW/)
  })

  it("writes a view's code into the project, under DeZign's placeholders, and nothing else", () => {
    const withId = dez.replace('<NAME>v_open</NAME>\n', '<NAME>v_open</NAME>\n<ID>40</ID>\n')
    const view = readDezign(withId).sqlObjects.find((o) => o.kind === 'view')!
    expect([view.id, view.code]).toEqual(['40', 'CREATE VIEW %viewname% AS\nSELECT id FROM shop.invoice WHERE issued IS NULL;'])
    const files: DezignFile[] = [{ path: 'shop.dez', text: withId }]
    const code = 'CREATE VIEW %viewname% AS\nSELECT id, total\nFROM shop.invoice\nWHERE issued IS NULL AND total > 0'
    const r = saveToDezign(files, model(files), model(files), { normalize: viaDbml, views: [{ id: '40', code }] })
    expect(r.changes).toEqual([{ kind: 'alter_view', table: 'v_open' }])
    expect(changedLines(withId, r.files[0]!.text)).toEqual(['SELECT id, total', 'FROM shop.invoice', 'WHERE issued IS NULL AND total &gt; 0</CODE>'])
    const after = readDezign(r.files[0]!.text).sqlObjects.find((o) => o.kind === 'view')!
    expect(after.sql).toBe('CREATE VIEW shop.v_open AS\nSELECT id, total\nFROM shop.invoice\nWHERE issued IS NULL AND total > 0')
    // The same code again, an unknown id or an empty code: nothing to write.
    expect(saveToDezign(r.files, model(r.files), model(r.files), { normalize: viaDbml, views: [{ id: '40', code: `${code}\n` }, { id: '99', code }, { id: '40', code: ' ' }] }).files).toEqual([])
  })

  it("writes a view's code into its own file of a folder project, with the project's line ends", () => {
    const view = '<VIEW>\n<NAME>v_open</NAME>\n<ID>40</ID>\n<SCHEMA>shop</SCHEMA>\n<DESC></DESC>\n<CODE>CREATE VIEW %viewname% AS\nSELECT 1</CODE>\n</VIEW>'
    const files = [...folder, { path: 'data dictionary/views/shop.v_open.xml', text: xml(view) }]
    // The file's CRLF line ends are not part of the code the model holds.
    expect(readDezign(assembleDezignProject(files)).sqlObjects.find((o) => o.kind === 'view')!.code).toBe('CREATE VIEW %viewname% AS\nSELECT 1')
    const r = saveToDezign(files, model(files), model(files), { normalize: viaDbml, views: [{ id: '40', code: 'CREATE VIEW %viewname% AS\nSELECT 2' }] })
    expect(r.files.map((f) => f.path)).toEqual(['data dictionary/views/shop.v_open.xml'])
    expect(r.files[0]!.text).toBe(xml(view.replace('SELECT 1', 'SELECT 2')))
  })

  it('a relationship whose key joins the child\'s primary key becomes identifying (DeZign draws it solid), and back', () => {
    const typed = dez.replace('<CHILDOBJECTID>20</CHILDOBJECTID>\n', '<CHILDOBJECTID>20</CHILDOBJECTID>\n<RELTYPE>1</RELTYPE>\n')
    expect(typed).not.toBe(dez)
    const files: DezignFile[] = [{ path: 'shop.dez', text: typed }]
    const identifying = save(files, (t) => {
      const invoice = t.find((x) => x.foreignKeys.length)!
      invoice.primaryKey = [...invoice.primaryKey, ...invoice.foreignKeys[0]!.columns]
      for (const c of invoice.columns) if (invoice.primaryKey.includes(c.name)) Object.assign(c, { isPrimaryKey: true, nullable: false })
    })
    expect(identifying.changes.map((c) => c.kind)).toContain('alter_relationship')
    expect(identifying.files[0]!.text).toMatch(/<REL>\s*<NAME>customer_invoice<\/NAME>[\s\S]*?<RELTYPE>0<\/RELTYPE>/)
    // Taken out of the key again: non-identifying.
    const back = save(identifying.files, (t) => {
      const invoice = t.find((x) => x.foreignKeys.length)!
      invoice.primaryKey = invoice.primaryKey.filter((k) => !invoice.foreignKeys[0]!.columns.includes(k))
      for (const c of invoice.columns) if (!invoice.primaryKey.includes(c.name)) c.isPrimaryKey = false
    })
    expect(back.files[0]!.text).toMatch(/<REL>\s*<NAME>customer_invoice<\/NAME>[\s\S]*?<RELTYPE>1<\/RELTYPE>/)
  })

  it("writes the project's scripts around CREATE and ALTER into its settings, in a file and in a folder", () => {
    const scripts = { create: ['SET search_path = shop;', '-- done\nANALYZE;'] as [string, string], alter: ['BEGIN;', 'COMMIT;'] as [string, string] }
    for (const files of [single, folder]) {
      const r = saveToDezign(files, model(files), model(files), { normalize: viaDbml, scripts })
      expect(r.changes.filter((c) => c.kind === 'project_scripts').length).toBe(4)
      // In a folder project only the project file changes.
      if (files === folder) expect(r.files.map((f) => f.path)).toEqual(['Shop.dezproj'])
      const after = applyDezignSave(files, r)
      const read = readDezign(files === folder ? assembleDezignProject(after) : after[0]!.text)
      expect(read.scripting.around).toEqual({ create: ['SET search_path = shop;', '-- done\nANALYZE;'], alter: ['BEGIN;', 'COMMIT;'] })
      // The same scripts again: nothing to write.
      expect(saveToDezign(after, model(after), model(after), { normalize: viaDbml, scripts }).files).toEqual([])
    }
  })

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
        { schema: 'shop', name: 'payment', type: 'table', comment: 'Platba', columns: [column('id', 'bigint', { nullable: false, isPrimaryKey: true }), column('invoice_id', 'bigint', { nullable: false })], primaryKey: ['id'], foreignKeys: [{ name: 'fk_payment_invoice_id', columns: ['invoice_id'], refSchema: 'shop', refTable: 'invoice', refColumns: ['id'], onDelete: 'CASCADE' }], indexes: [{ name: 'payment_invoice', columns: ['invoice_id'], unique: false, primary: false }] },
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

  // Found by DeZign 14.9.3 itself: "'' is not a valid integer value", and the project did not open.
  it('gives a new table\'s diagram object the header colour of its diagram, never an empty number', () => {
    const colored: DezignFile[] = [{ path: 'shop.dez', text: dez.replace(/(<BRUSH>[^<]*<\/BRUSH>\n)(<\/ENTC>)/g, '$1<HEADERCOLOR>16446189</HEADERCOLOR>\n$2') }]
    expect(colored[0]!.text.match(/<HEADERCOLOR>16446189</g)!.length).toBeGreaterThan(1)
    const r = save(colored, (t) => [...t, { schema: 'shop', name: 'payment', type: 'table', comment: null, columns: [column('id', 'bigint', { nullable: false, isPrimaryKey: true })], primaryKey: ['id'], foreignKeys: [], indexes: [] }])
    const out = r.files[0]!.text
    expect(out.match(/<HEADERCOLOR>16446189</g)).toHaveLength(colored[0]!.text.match(/<HEADERCOLOR>16446189</g)!.length + 1)
    expect(out).not.toContain('<HEADERCOLOR></HEADERCOLOR>')
  })

  // In every format before DeZign 14 that id is the number 1; DeZign does not open a file with text in a number's place.
  it('gives the constraint of a first relationship the id its file format uses', () => {
    const bare = (format: string): DezignFile[] => [{ path: 'shop.dez', text: dez.replace('<FILEFORMATVERSION>140<', `<FILEFORMATVERSION>${format}<`).replace(/<REL>[\s\S]*?<\/REL>\n/g, '').replace(/<RELC>[\s\S]*?<\/RELC>\n/g, '') }]
    const constraintId = (format: string) => {
      expect(bare(format)[0]!.text).not.toContain('<REL>')
      const r = save(bare(format), (t) => [...t, { schema: 'shop', name: 'payment', type: 'table', comment: null, columns: [column('id', 'bigint', { nullable: false, isPrimaryKey: true }), column('invoice_id', 'bigint', { nullable: false })], primaryKey: ['id'], foreignKeys: [{ name: 'fk_payment_invoice_id', columns: ['invoice_id'], refSchema: 'shop', refTable: 'invoice', refColumns: ['id'] }], indexes: [] }])
      expect(readDezign(r.files[0]!.text).tables.find((t) => t.name === 'payment')!.foreignKeys).toHaveLength(1)
      const [, rel, constraint] = /<REL>[\s\S]*?<ID>([^<]*)<\/ID>[\s\S]*?<CONSTRAINT>[\s\S]*?<ID>([^<]*)<\/ID>/.exec(r.files[0]!.text)!
      return { rel, constraint }
    }
    expect(constraintId('60').constraint).toBe('1')
    const now = constraintId('140')
    expect(now.constraint).toBe(`${now.rel}-FK`)
  })

  // DeZign works in one Windows code page. A character reference is no way around it: 14.9.3 showed `&#345;`
  // as typed and saved it as `&amp;#345;`.
  it('writes a character the file\'s code page lacks as its plain letter, never as a character reference', () => {
    // (ñ as windows-1252 bytes, more of them than the fixture has Czech letters, makes this a Western file.)
    const western: DezignFile[] = [{ path: 'shop.dez', text: dez.replace('<TEXT>Prodej</TEXT>', `<TEXT>Se\xf1or ${'\xf1'.repeat(60)}</TEXT>`) }]
    expect(readDezign(western[0]!.text).encoding).toBe('windows-1252')
    const r = save(western, (t) => void t[0]!.columns.push(column('note', 'varchar(20)', { comment: 'Žluťoučký kůň & ł' })))
    const out = r.files[0]!.text
    expect(out).not.toContain('&#')
    // Ž and ý are in the Western code page too; ť, č, ů and ň are not, and ł has no plain letter.
    expect(out).toContain('<DESC>\x8elutou\x63k\xfd kun &amp; ?</DESC>')
    expect(readDezign(out).tables[0]!.columns.at(-1)!.comment).toBe('Žlutoucký kun & ?')
  })

  // Node 24.5 reads windows-1252 as ISO-8859-1 (0x80–0x9F as control characters): the reader has its own table.
  it('reads and writes the Western code page\'s own characters (€ „ “ – Š ž)', () => {
    const western: DezignFile[] = [{ path: 'shop.dez', text: dez.replace('<TEXT>Prodej</TEXT>', `<TEXT>\x80 \x84a\x93 \x96 \x8a\x9e ${'\xf1'.repeat(60)}</TEXT>`) }]
    const model = readDezign(western[0]!.text)
    expect(model.encoding).toBe('windows-1252')
    expect(model.diagrams.flatMap((d) => d.notes.map((n) => n.text)).join(' ')).toContain('€ „a“ – Šž')
    const r = save(western, (t) => void t[0]!.columns.push(column('price_note', 'varchar(20)', { comment: 'Cena v € – „přibližně“' })))
    expect(r.files[0]!.text).toContain('<DESC>Cena v \x80 \x96 \x84pribli\x9en\xec\x93</DESC>'.replace('\xec', 'e'))
  })

  // Projects that came to DeZign 14 from an older version: numbers for tables, `ATTR-<table>-<n>-<token>` for columns.
  // DeZign 14.9.3 renumbered plain numbers written there, and the new relationship lost its columns.
  it('gives new columns and indexes ids of the project\'s own kind', () => {
    const token = 'D5609BB05BCDF7D9'
    let indexes = 0
    const text = dez
      .replace(/(<(?:ID|ATTRIBUTEID|KEYID|FOREIGNKEYID|IDXCOLATTRID)>)([AB])(\d)/g, (_, tag: string, table: string, n: string) => `${tag}ATTR-${table === 'A' ? 10 : 20}-${n}-${token}`)
      .replace(/(<INDEX>\n<NAME>[^<]*<\/NAME>\n)/g, (_, head: string) => `${head}<ID>IDX-20-${++indexes}-${token}</ID>\n`)
    const styled: DezignFile[] = [{ path: 'shop.dez', text }]
    expect(indexes).toBeGreaterThan(1)
    expect(readDezign(styled[0]!.text).tables.map((t) => t.foreignKeys.length)).toEqual(readDezign(dez).tables.map((t) => t.foreignKeys.length))
    const r = save(styled, (t) => {
      t[0]!.columns.push(column('note', 'varchar(20)'))
      t[0]!.indexes.push({ name: 'customer_note', columns: ['note'], unique: false, primary: false })
      return [...t, { schema: 'shop', name: 'payment', type: 'table', comment: null, columns: [column('id', 'bigint', { nullable: false, isPrimaryKey: true }), column('invoice_id', 'bigint', { nullable: false })], primaryKey: ['id'], foreignKeys: [{ name: 'fk_payment_invoice_id', columns: ['invoice_id'], refSchema: 'shop', refTable: 'invoice', refColumns: ['id'] }], indexes: [] }]
    })
    const out = r.files[0]!.text
    const columns = [...out.matchAll(/<ATTR>\s*<NAME>([^<]*)<\/NAME>\s*<ID>([^<]*)<\/ID>/g)].map((m) => `${m[1]}=${m[2]}`)
    const payment = /<ENT>\s*<NAME>payment<\/NAME>\s*<ID>([^<]*)<\/ID>/.exec(out)![1]!
    expect(columns).toEqual(expect.arrayContaining([expect.stringMatching(/^note=ATTR-10-\d+-\w+$/), expect.stringMatching(new RegExp(`^id=ATTR-${payment}-1-\\w+$`)), expect.stringMatching(new RegExp(`^invoice_id=ATTR-${payment}-2-\\w+$`))]))
    expect(out).toMatch(new RegExp(`<FOREIGNKEYID>ATTR-${payment}-2-\\w+</FOREIGNKEYID>`))
    expect(out).toMatch(/<INDEX>\s*<NAME>customer_note<\/NAME>[\s\S]*?<ID>IDX-10-\d+-\w+<\/ID>/)
    expect(readDezign(out).tables.find((t) => t.name === 'payment')!.foreignKeys).toHaveLength(1)
  })

  it('does not hand a copied column or table the labels, custom properties or character set of its neighbour', () => {
    const labelled: DezignFile[] = [{ path: 'shop.dez', text: dez.replace(/(<ATTR>\n<NAME>[^<]*<\/NAME>\n<ID>[^<]*<\/ID>\n)/g, '$1<OBJLABELS>Personal data\n</OBJLABELS>\n<CHARSET>utf8mb4</CHARSET>\n').replace(/(<ENT>\n<NAME>[^<]*<\/NAME>\n<ID>[^<]*<\/ID>\n)/g, '$1<OBJLABELS>Core\n</OBJLABELS>\n') }]
    const count = (text: string, tag: string) => text.split(`<${tag}>`).length - 1
    const before = { labels: count(labelled[0]!.text, 'OBJLABELS'), charsets: count(labelled[0]!.text, 'CHARSET') }
    expect(before.labels).toBeGreaterThan(3)
    const r = save(labelled, (t) => {
      t[0]!.columns.push(column('note', 'varchar(20)'))
      return [...t, { schema: 'shop', name: 'payment', type: 'table', comment: null, columns: [column('id', 'bigint', { nullable: false, isPrimaryKey: true })], primaryKey: ['id'], foreignKeys: [], indexes: [] }]
    })
    expect(r.changes.map((c) => c.kind).sort()).toEqual(['add_column', 'add_table'])
    expect({ labels: count(r.files[0]!.text, 'OBJLABELS'), charsets: count(r.files[0]!.text, 'CHARSET') }).toEqual(before)
  })

  it('takes the lines from views to a dropped table out with it (DeZign 14.5 draws views)', () => {
    const link = (id: string, table: string) => `<VIEWCONNECTION>\n<NAME></NAME>\n<ID>${id}</ID>\n<PARENTOBJECTID>V1</PARENTOBJECTID>\n<CHILDOBJECTID>${table}</CHILDOBJECTID>\n</VIEWCONNECTION>`
    const line = (id: string) => `<VIEWCONNECTOR>\n<ID>${id}</ID>\n<DIAGRAMID>1</DIAGRAMID>\n</VIEWCONNECTOR>`
    const text = dez
      .replace('<NAME>v_open</NAME>', '<NAME>v_open</NAME>\n<ID>V1</ID>')
      .replace('</VIEWS>', `</VIEWS>\n<VIEWCONNECTIONS>\n${link('VC1', '10')}\n${link('VC2', '20')}\n</VIEWCONNECTIONS>`)
      .replace('</ENTITYCONTROLS>', `</ENTITYCONTROLS>\n<VIEWCONNECTORS>\n${line('VC1')}\n${line('VC2')}\n</VIEWCONNECTORS>`)
    expect(dezignIntegrity(text)).toEqual(dezignIntegrity(dez))
    const r = save([{ path: 'shop.dez', text }], (t) => t.filter((x) => x.name !== 'invoice'))
    const out = r.files[0]!.text
    expect(out).toContain('<ID>VC1</ID>')
    expect(out).not.toContain('VC2')
    expect(dezignIntegrity(out)).toEqual(dezignIntegrity(dez))
    // A line left without its table is a broken reference.
    expect(dezignIntegrity(text.replace('<CHILDOBJECTID>20</CHILDOBJECTID>\n</VIEWCONNECTION>', '<CHILDOBJECTID>99</CHILDOBJECTID>\n</VIEWCONNECTION>')).some((p) => p.startsWith('view connection VC2'))).toBe(true)
  })

  // Formats before DeZign 14: numbers for everything, and counters DeZign takes its next id from.
  it('moves the id counters of an older file on when it hands out higher ids, and only then', () => {
    const text = dez
      .replace(/(<(?:ID|ATTRIBUTEID|KEYID|FOREIGNKEYID|IDXCOLATTRID)>)[AB](\d)/g, '$1$2')
      .replace('<DBID>postgresql16</DBID>', '<DBID>postgresql16</DBID>\n<LASTID>31</LASTID>')
      .replace(/(<ENT>\n<NAME>[^<]*<\/NAME>\n<ID>[^<]*<\/ID>\n)/g, '$1<ATTRLASTID>1</ATTRLASTID>\n')
    const old: DezignFile[] = [{ path: 'shop.dez', text }]
    expect(save(old, () => {})).toEqual({ files: [], deleted: [], changes: [] })
    const r = save(old, (t) => {
      t[0]!.columns.push(column('note', 'varchar(20)'))
      return [...t, { schema: 'shop', name: 'payment', type: 'table', comment: null, columns: [column('id', 'bigint', { nullable: false, isPrimaryKey: true })], primaryKey: ['id'], foreignKeys: [], indexes: [] }]
    })
    const out = r.files[0]!.text
    const counter = (table: string) => new RegExp(`<NAME>${table}</NAME>\\n<ID>\\d+</ID>\\n<ATTRLASTID>(\\d+)</ATTRLASTID>`).exec(out)![1]
    const added = /<NAME>note<\/NAME>\s*<ID>(\d+)<\/ID>/.exec(out)![1]
    expect(counter('customer')).toBe(added)
    expect(counter('invoice')).toBe('1')
    const payment = /<NAME>payment<\/NAME>\n<ID>(\d+)<\/ID>/.exec(out)![1]!
    expect(Number(/<LASTID>(\d+)<\/LASTID>/.exec(out)![1])).toBeGreaterThanOrEqual(Number(payment))
  })

  it('reads a column\'s collation, keeps it in DBML and scripts, and writes a new, changed or removed one', () => {
    // (After the type, before the constraints: where DeZign keeps it.)
    const withCollation = dez.replace(/(<NAME>email<\/NAME>[\s\S]*?<\/DT>\n)/, '$1<COLLATE>Czech_CI_AS</COLLATE>\n')
    // DeZign's own templates have COLLATE for SQL Server and MySQL and none for PostgreSQL: a PostgreSQL project
    // that still holds one (from the database it was first made for) does not get it into its scripts.
    expect(model([{ path: 'shop.dez', text: withCollation }])[0]!.columns.some((c) => c.collation)).toBe(false)
    const collated: DezignFile[] = [{ path: 'shop.dez', text: withCollation.replace('<DBID>postgresql16</DBID>', '<DBID>mssqlserver2022</DBID>') }]
    const tables = model(collated)
    const email = tables[0]!.columns.find((c) => c.name === 'email')!
    expect(email.collation).toBe('Czech_CI_AS')
    expect(toDbml(tables)).toContain("collate: 'Czech_CI_AS'")
    expect(createScript(tables, getDialect('mssql'))).toMatch(/\[email\] [\w ]+(\(\d+\))? COLLATE Czech_CI_AS/)
    // Another database has other collations: the translated script leaves it out.
    expect(createScript(tables, getDialect('postgres'), { translateTypes: true, from: 'mssql' })).not.toContain('COLLATE')
    expect(save(collated, () => {})).toEqual({ files: [], deleted: [], changes: [] })
    const r = save(collated, (t) => {
      t[0]!.columns.find((c) => c.name === 'email')!.collation = 'C'
      t[0]!.columns.push(column('code', 'varchar(10)', { collation: 'C' }))
    })
    expect(r.changes.map((c) => `${c.kind} ${c.name}`)).toEqual(['alter_column email', 'add_column code'])
    expect(r.files[0]!.text).toMatch(/<NAME>email<\/NAME>[\s\S]*?<\/DT>\n<COLLATE>C<\/COLLATE>\n<NNCON>|<NAME>email<\/NAME>[\s\S]*?<\/DT>\n<COLLATE>C<\/COLLATE>\n<\/ATTR>/)
    expect(model(r.files).flatMap((t) => t.columns).filter((c) => c.collation === 'C').map((c) => c.name)).toEqual(['email', 'code'])
    const gone = save(r.files, (t) => void delete t[0]!.columns.find((c) => c.name === 'email')!.collation)
    expect(gone.files[0]!.text.match(/<COLLATE>/g)).toHaveLength(1)
  })

  // DeZign: an attribute inherited from a package cannot be edited in its table and follows the package.
  it('takes a column whose definition changed out of its attribute package, and leaves one that only got a comment', () => {
    const packaged: DezignFile[] = [{ path: 'shop.dez', text: dez.replace(/(<NAME>(email|credit)<\/NAME>\n<ID>[^<]*<\/ID>\n)/g, '$1<PKGNAME>Audit</PKGNAME>\n<PKGITEM>$2</PKGITEM>\n') }]
    expect(packaged[0]!.text.match(/<PKGNAME>/g)!.length).toBeGreaterThanOrEqual(2)
    const r = save(packaged, (t) => {
      t[0]!.columns.find((c) => c.name === 'email')!.dataType = 'varchar(200)'
      t[0]!.columns.find((c) => c.name === 'credit')!.comment = 'Kredit zákazníka'
    })
    expect(r.changes).toEqual([
      { kind: 'alter_column', table: 'customer', name: 'email', detached: 'Audit' },
      { kind: 'alter_column', table: 'customer', name: 'credit' },
    ])
    const out = r.files[0]!.text
    expect(out.match(/<PKGNAME>/g)!.length).toBe(packaged[0]!.text.match(/<PKGNAME>/g)!.length - 1)
    expect(out.match(/<PKGITEM>/g)!.length).toBe(out.match(/<PKGNAME>/g)!.length)
    expect(out).toMatch(/<NAME>credit<\/NAME>\n<ID>[^<]*<\/ID>\n<PKGNAME>Audit<\/PKGNAME>\n<PKGITEM>credit<\/PKGITEM>/)
  })

  it('does not copy UNSIGNED, ZEROFILL or a relationship\'s cardinality from the neighbour a new one is made like', () => {
    const marked = dez.replace(/(<DTLISTNAME>BIGINT<\/DTLISTNAME>\n)/g, '$1<UNS>1</UNS>\n<ZF>1</ZF>\n').replace(/<UPDATERULE>/g, '<CARDINALITY>3</CARDINALITY>\n<UPDATERULE>')
    expect(marked.match(/<UNS>1</g)!.length).toBeGreaterThan(0)
    expect(marked).toContain('<CARDINALITY>3<')
    const files: DezignFile[] = [{ path: 'shop.dez', text: marked }]
    const r = save(files, (t) => {
      t[1]!.columns.push(column('amount', 'bigint'))
      return [...t, { schema: 'shop', name: 'payment', type: 'table', comment: null, columns: [column('id', 'bigint', { nullable: false, isPrimaryKey: true }), column('invoice_id', 'bigint')], primaryKey: ['id'], foreignKeys: [{ name: 'fk_payment_invoice_id', columns: ['invoice_id'], refSchema: 'shop', refTable: 'invoice', refColumns: ['id'] }], indexes: [] }]
    })
    const out = r.files[0]!.text
    const attr = (name: string) => new RegExp(`<NAME>${name}</NAME>[\\s\\S]*?</DT>`).exec(out)![0]
    expect(attr('amount')).not.toContain('<UNS>1<')
    expect(attr('invoice_id')).not.toContain('<ZF>1<')
    const rel = /<REL>\s*<NAME>invoice_payment<\/NAME>[\s\S]*?<\/REL>/.exec(out)?.[0] ?? /<REL>[\s\S]*?<CHILDOBJECTID>NEW-\d+<\/CHILDOBJECTID>[\s\S]*?<\/REL>/.exec(out)![0]
    expect(rel).toContain('<CARDINALITY>0</CARDINALITY>')
  })

  it('writes the Notes of tables and columns (remarks) apart from their descriptions', () => {
    const r = save(single, (t) => {
      t[0]!.remarks = 'Ask the owner\nbefore changing'
      t[0]!.columns[1]!.remarks = 'Unique per shop'
      t[0]!.columns.push(column('vip', 'boolean', { remarks: 'Set by sales' }))
    })
    expect(r.changes.map((c) => c.kind)).toEqual(['alter_table', 'alter_column', 'add_column'])
    const after = readDezign(r.files[0]!.text).tables[0]!
    expect(after.remarks).toBe('Ask the owner\nbefore changing')
    expect(after.columns.filter((c) => c.remarks).map((c) => `${c.name}: ${c.remarks}`)).toEqual(['email: Unique per shop', 'vip: Set by sales'])
    expect(after.comment).toBe(readDezign(dez).tables[0]!.comment)
    // In the model text: `Remarks:` for the table, `remarks:` for a column, and back again.
    const dbml = toDbml(readDezign(r.files[0]!.text).tables)
    expect(dbml).toContain("remarks: 'Unique per shop'")
    expect(dbml).toContain("Remarks: '''Ask the owner\nbefore changing'''")
    expect(parseDbml(dbml).tables[0]!.remarks).toBe('Ask the owner\nbefore changing')
    expect(save(r.files, () => {})).toEqual({ files: [], deleted: [], changes: [] })
  })

  // CARDINALITY in the order of DeZign's dialog: 0 zero or more, 1 one or more, 2 zero or one, 3 exactly one.
  it('reads a relationship\'s cardinality, keeps it in DBML, and writes a changed one', () => {
    const one = dez.replace(/<UPDATERULE>/, '<CARDINALITY>3</CARDINALITY>\n<UPDATERULE>')
    const files: DezignFile[] = [{ path: 'shop.dez', text: one }]
    const invoice = readDezign(one).tables.find((t) => t.name === 'invoice')!
    expect(invoice.foreignKeys[0]!.cardinality).toBe('exactly-one')
    const dbml = toDbml(readDezign(one).tables)
    expect(dbml.split('\n').filter((l) => l.startsWith('Ref')).join('\n')).toMatch(/shop\.invoice\.customer_id - shop\.customer\.id \[[^\]]*cardinality: 'exactly one'/)
    expect(parseDbml(dbml).tables.find((t) => t.name === 'invoice')!.foreignKeys[0]!.cardinality).toBe('exactly-one')
    expect(parseDbml("Table a {\n  id int [pk]\n}\nTable b {\n  id int [pk]\n  a_id int\n}\nRef: b.a_id - a.id").tables[1]!.foreignKeys[0]!.cardinality).toBe('zero-or-one')
    expect(save(files, () => {})).toEqual({ files: [], deleted: [], changes: [] })
    const r = save(files, (t) => void (t.find((x) => x.name === 'invoice')!.foreignKeys[0]!.cardinality = 'zero-or-one'))
    expect(r.changes.map((c) => c.kind)).toEqual(['alter_relationship'])
    expect(r.files[0]!.text).toContain('<CARDINALITY>2</CARDINALITY>')
    const back = save(r.files, (t) => void delete t.find((x) => x.name === 'invoice')!.foreignKeys[0]!.cardinality)
    expect(back.files[0]!.text).toContain('<CARDINALITY>0</CARDINALITY>')
    // (Never in a script.)
    expect(createScript(readDezign(one).tables, getDialect('postgres'))).not.toMatch(/cardinality/i)
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
      return [...t, { schema: 'shop', name: 'payment', type: 'table', comment: null, columns: [column('id', 'bigint', { nullable: false, isPrimaryKey: true }), column('invoice_id', 'bigint')], primaryKey: ['id'], foreignKeys: [{ name: 'payment_of_invoice', columns: ['invoice_id'], refSchema: 'shop', refTable: 'invoice', refColumns: ['id'] }], indexes: [] }]
    })
    expect(r.deleted).toEqual(['data dictionary/entities/shop.customer.xml'])
    expect(r.files.map((f) => f.path).sort()).toEqual([
      'data dictionary/entities/shop.client.xml',
      'data dictionary/entities/shop.payment.xml',
      'data dictionary/relationships/payment_of_invoice.xml',
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
    // Every kind of edit took part, a changed primary key too.
    if (process.env.DBM_FUZZ_COUNTS) console.log(JSON.stringify(counts))
    expect(Object.keys(counts).filter((k) => k !== 'nothing').length).toBeGreaterThanOrEqual(14)
    expect((counts.extendKey ?? 0) + (counts.shrinkKey ?? 0)).toBeGreaterThan(0)
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

describe('scripts as DeZign itself writes them', () => {
  // A PostgreSQL project with a domain it keeps as a type, its own name templates, names in capitals, a key
  // without a name and a named relationship.
  const project = (convertDomains: '0' | '1') => `<?xml version="1.0" encoding="iso-8859-1"?><dezign>
<VERSION>
${settings}
<DATADICT>
<DBID>postgresql16</DBID>
<DDSETTINGS>
<CONVERTDOMAINS>${convertDomains}</CONVERTDOMAINS>
<PKCONNAMETEMPLATE>%table%_PK</PKCONNAMETEMPLATE>
</DDSETTINGS>
<DOMAINS>
<DOMAIN>
<NAME>TECH_ID</NAME>
<ID>D1</ID>
<DT>
<DTLISTNAME>BIGINT</DTLISTNAME>
</DT>
</DOMAIN>
<DOMAIN>
<NAME>FLAG</NAME>
<ID>D2</ID>
<DT>
<DTLISTNAME>CHAR</DTLISTNAME>
<LE>1</LE>
</DT>
<DEFCON>
<VALUE>N</VALUE>
</DEFCON>
<CCON>
<VALUE>value IN ('Y','N')</VALUE>
</CCON>
</DOMAIN>
</DOMAINS>
<ENTITIES>
<ENT>
<NAME>Customer</NAME>
<ID>10</ID>
<SCHEMA>Sales</SCHEMA>
<PKCON>
<NAME>Customer_PK</NAME>
<ATTRIBUTEIDS>
<ATTRIBUTEID>C1</ATTRIBUTEID>
</ATTRIBUTEIDS>
</PKCON>
<ATTRIBUTES>
${attr('C1', 'Id', 'BIGINT', '', notNull).replace('<DOMAINID></DOMAINID>', '<DOMAINID>D1</DOMAINID>')}
${attr('C2', 'isActive', 'CHAR', '<LE>1</LE>\n', "<CCON>\n<VALUE>value IN ('Y','N')</VALUE>\n</CCON>\n").replace('<DOMAINID></DOMAINID>', '<DOMAINID>D2</DOMAINID>')}
${attr('C3', 'unit price', 'NUMERIC', '<LE>8</LE>\n')}
</ATTRIBUTES>
<CONSTRAINTS>
<CONSTRAINT>
<NAME>Customer_1TUC</NAME>
<CONTYPE>2</CONTYPE>
<ATTRIBUTEIDS>
<ATTRIBUTEID>C2</ATTRIBUTEID>
</ATTRIBUTEIDS>
</CONSTRAINT>
</CONSTRAINTS>
</ENT>
<ENT>
<NAME>Invoice</NAME>
<ID>20</ID>
<SCHEMA>Sales</SCHEMA>
<PKCON>
<NAME></NAME>
<ATTRIBUTEIDS>
<ATTRIBUTEID>I1</ATTRIBUTEID>
</ATTRIBUTEIDS>
</PKCON>
<ATTRIBUTES>
${attr('I1', 'Id', 'BIGINT', '', notNull)}
${attr('I2', 'CustomerId', 'BIGINT', '', notNull).replace('<DOMAINID></DOMAINID>', '<DOMAINID>D1</DOMAINID>')}
</ATTRIBUTES>
</ENT>
</ENTITIES>
<RELATIONSHIPS>
${rel('30', 'Customer_Invoice', '<PAIR>\n<KEYID>C1</KEYID>\n<FOREIGNKEYID>I2</FOREIGNKEYID>\n</PAIR>\n').replace('<PARENTOBJECTID>10</PARENTOBJECTID>', '<PARENTOBJECTID>10</PARENTOBJECTID>')}
</RELATIONSHIPS>
</DATADICT>
</VERSION>
</dezign>`
  const scriptOf = (file: string, driver: 'postgres' | 'mssql', extra: TableInfo[] = []) => {
    const model = readDezign(file)
    // As the app has it: the model as DBML text, names as DeZign's scripts create them.
    const tables = [...parseDbml(toDbml(model.tables)).tables, ...extra]
    return createScript(unquotedNames(tables, driver), getDialect(driver), { translateTypes: true, from: dezignDriver(model.targetDatabase), ...dezignMigrationOptions(model.scripting, driver) })
  }

  it('reads what the project decides about its scripts', () => {
    const model = readDezign(project('0'))
    expect(model.scripting.primaryKeys).toEqual({ names: { 'sales.customer': 'Customer_PK', 'sales.invoice': '' }, template: '%table%_PK' })
    expect(model.scripting.uniqueConstraints).toEqual(['customer_1tuc'])
    expect(model.scripting.uniqueIndexes).toEqual([])
    expect(model.scripting.domains).toEqual([
      { name: 'TECH_ID', dataType: 'bigint', defaultValue: null, check: null, notNull: false },
      { name: 'FLAG', dataType: 'char(1)', defaultValue: "'N'", check: "value IN ('Y','N')", notNull: false },
    ])
    // A project that converts its domains has none for the database.
    expect(readDezign(project('1')).scripting.domains).toEqual([])
    // The relationship and the unique constraint keep their names in the model's text.
    const text = toDbml(model.tables)
    expect(text).toContain('Ref FK_Customer_Invoice: Sales.Invoice.CustomerId > Sales.Customer.Id')
    expect(text).toContain("isActive [unique, name: 'Customer_1TUC']")
    expect(parseDbml(text).tables[1]!.foreignKeys[0]!.name).toBe('FK_Customer_Invoice')
  })

  it('writes PostgreSQL the way DeZign does: bare names, domains as types, the project\'s constraint names', () => {
    const sql = scriptOf(project('0'), 'postgres')
    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS "sales"')
    expect(sql).toContain('CREATE DOMAIN tech_id AS bigint;')
    expect(sql).toContain("CREATE DOMAIN flag AS char(1) DEFAULT 'N' CHECK (value IN ('Y','N'));")
    // Columns are typed by their domain and take its default and check from it; a name that can't be bare keeps its quotes.
    // The project's unique constraint is a constraint of the table, under its name.
    expect(sql).toContain('CREATE TABLE "sales"."customer" (\n  "id" tech_id NOT NULL,\n  "isactive" flag,\n  "unit price" numeric(8),\n  CONSTRAINT "customer_pk" PRIMARY KEY ("id"),\n  CONSTRAINT "customer_1tuc" UNIQUE ("isactive")\n)')
    // A key the project leaves unnamed is unnamed; the foreign key has the name the project gives its constraint.
    expect(sql).toContain('  "customerid" tech_id NOT NULL,\n  PRIMARY KEY ("id")\n)')
    expect(sql).toContain('ADD CONSTRAINT "fk_customer_invoice" FOREIGN KEY ("customerid") REFERENCES "sales"."customer" ("id")')
    // A table made here gets its key named by the project's template, and what it makes unique is a constraint,
    // as it will be in the project once saved.
    const added = parseDbml("Table Sales.Payment {\n  Id bigint [pk]\n  a int\n  b int\n  indexes {\n    (a, b) [unique, name: 'payment_pair']\n  }\n}").tables
    const withNew = scriptOf(project('0'), 'postgres', added)
    expect(withNew).toContain('CONSTRAINT "payment_pk" PRIMARY KEY ("id")')
    expect(withNew).toContain('CONSTRAINT "payment_pair" UNIQUE ("a", "b")')
  })

  it('carries the types themselves where the database has no domains or the project converts them', () => {
    const converted = scriptOf(project('1'), 'postgres')
    expect(converted).not.toContain('CREATE DOMAIN')
    expect(converted).toContain(`"isactive" char(1) DEFAULT 'N'`)
    expect(converted).toContain(`CHECK ("isactive" IN ('Y','N'))`)
    const mssql = scriptOf(project('0'), 'mssql')
    expect(mssql).not.toContain('CREATE DOMAIN')
    // SQL Server keeps the case of a name: nothing is folded there.
    expect(mssql).toContain('CREATE TABLE [Sales].[Customer]')
    expect(mssql).toContain('CONSTRAINT [Customer_PK] PRIMARY KEY ([Id])')
  })

  it('finds no difference with a database whose columns are typed by the domains', () => {
    const model = readDezign(project('0'))
    const tables = unquotedNames(parseDbml(toDbml(model.tables)).tables, 'postgres')
    // What PostgreSQL reports after DeZign's own script: lower-case names, the domain as the column's type, no column default.
    const database: TableInfo[] = tables.map((t) => ({
      ...t,
      checks: [],
      columns: t.columns.map((c) => ({ ...c, dataType: c.domain ? c.domain.toLowerCase() : c.dataType, defaultValue: c.domain ? null : c.defaultValue, domain: undefined })),
    }))
    expect(compareSchemas(tables, database, { model: true })).toEqual([])
    // A column added to the model is added typed by its domain, and the domain is made if the database lacks it.
    const next = structuredClone(tables)
    next[1]!.columns.push({ name: 'paid', ordinal: 3, dataType: 'char(1)', nullable: true, defaultValue: "'N'", isPrimaryKey: false, isIdentity: false, domain: 'FLAG' })
    const migration = generateMigration(compareSchemas(next, database, { model: true }), getDialect('postgres'), database, dezignMigrationOptions(model.scripting, 'postgres'))
    expect(migration.statements).toEqual([
      `DO $dbm$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'flag') THEN CREATE DOMAIN flag AS char(1) DEFAULT 'N' CHECK (value IN ('Y','N')); END IF; END $dbm$`,
      'ALTER TABLE "sales"."invoice" ADD COLUMN "paid" flag',
    ])
  })
})

describe('the scripts a DeZign project puts around its scripts', () => {
  it('reads the begin and end database scripts and wraps a script in them', () => {
    const withScripts = dez.replace('<PROJECTNAME></PROJECTNAME>', '<PROJECTNAME></PROJECTNAME>\n<BEGINDATABASESCRIPT>SET search_path = shop;\nSET client_encoding = &apos;UTF8&apos;;</BEGINDATABASESCRIPT>\n<ENDDATABASESCRIPT>ANALYZE;</ENDDATABASESCRIPT>\n<BEGINALTERDATABASESCRIPT>BEGIN;</BEGINALTERDATABASESCRIPT>\n<ENDALTERDATABASESCRIPT>COMMIT;</ENDALTERDATABASESCRIPT>')
    const { scripting } = readDezign(withScripts)
    expect(scripting.around).toEqual({ create: ["SET search_path = shop;\nSET client_encoding = 'UTF8';", 'ANALYZE;'], alter: ['BEGIN;', 'COMMIT;'] })
    expect(dezignWrapScript('CREATE TABLE a (id int);\n', scripting, 'create')).toBe("SET search_path = shop;\nSET client_encoding = 'UTF8';\n\nCREATE TABLE a (id int);\n\nANALYZE;\n")
    expect(dezignWrapScript('ALTER TABLE a ADD b int;', scripting, 'alter')).toBe('BEGIN;\n\nALTER TABLE a ADD b int;\n\nCOMMIT;\n')
    // A project without them changes nothing.
    expect(readDezign(dez).scripting.around).toBeUndefined()
    expect(dezignWrapScript('SELECT 1;\n', readDezign(dez).scripting, 'create')).toBe('SELECT 1;\n')
  })
})

describe('what DeZign 14 keeps where', () => {
  it('reads "convert domains" and the name templates from the project settings', () => {
    const domainUse = `<DOMAINS>\n<DOMAIN>\n<NAME>CODE</NAME>\n<ID>D7</ID>\n<DT>\n<DTLISTNAME>VARCHAR</DTLISTNAME>\n<LE>40</LE>\n</DT>\n</DOMAIN>\n</DOMAINS>`
    const withSettings = (convert: string) =>
      `<?xml version="1.0" encoding="iso-8859-1"?><dezign>\n<VERSION>\n<PROJECTSETTINGS>\n<COMMONSETTINGS>\n<FILEFORMATVERSION>140</FILEFORMATVERSION>\n</COMMONSETTINGS>\n<NAMETEMPLATES>\n<PKCONNAMETEMPLATE>%table%_PK</PKCONNAMETEMPLATE>\n<TUCONNAMETEMPLATE>%table%_%counter%_UQ</TUCONNAMETEMPLATE>\n</NAMETEMPLATES>\n<GenDB_Options>\n<CONVERTDOMAINS>${convert}</CONVERTDOMAINS>\n</GenDB_Options>\n<UpdDB_Options>\n<CONVERTDOMAINS>0</CONVERTDOMAINS>\n</UpdDB_Options>\n</PROJECTSETTINGS>\n<DATADICT>\n<DBID>postgresql16</DBID>\n${domainUse}\n<ENTITIES>\n</ENTITIES>\n</DATADICT>\n</VERSION>\n</dezign>`
    // The setting of the Generate dialog decides, not the one of another dialog further down.
    expect(readDezign(withSettings('1')).scripting.domains).toEqual([])
    expect(readDezign(withSettings('')).scripting.domains.map((d) => d.name)).toEqual(['CODE'])
    expect(readDezign(withSettings('1')).nameTemplates).toEqual({ PKCONNAMETEMPLATE: '%table%_PK', TUCONNAMETEMPLATE: '%table%_%counter%_UQ' })
    expect(readDezign(withSettings('1')).scripting.primaryKeys.template).toBe('%table%_PK')
  })

  it('puts a new diagram with the other diagrams and keeps the fields of what it copies', () => {
    const viaDbml = (tables: TableInfo[]) => parseDbml(toDbml(tables)).tables
    const tables = viaDbml(readDezign(dez).tables)
    const saved = saveToDezign([{ path: 'shop.dez', text: dez }], tables, tables, { normalize: viaDbml, diagrams: { 'new:1': { name: 'Another', exact: true, tables: ['shop.customer'] } } }).files[0]!.text
    // Every DIAGRAM stands before the first control, as in the file it came from.
    expect(saved.lastIndexOf('<DIAGRAM>')).toBeLessThan(saved.indexOf('<ENTC>'))
    expect(saved.match(/<DIAGRAM>/g)).toHaveLength((dez.match(/<DIAGRAM>/g) ?? []).length + 1)
    expect(dezignIntegrity(saved)).toEqual([])
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

  // DeZign makes names from their templates again when it opens a project (seen in 14.9.3: `orders_by_customer`
  // came back as `IDX_orders_1`). Its own files keep a typed name as its own template.
  it('makes the model\'s domains in a new project, and its columns follow them there', () => {
    const dbml = withDezignDomains("Table shop.account {\n  id integer [pk]\n  balance numeric(12,2) [domain: 'money_t']\n  note text [domain: 'gone_t']\n}", [{ name: 'money_t', dataType: 'numeric(12,2)' }])
    expect(dezignDomainsOfModel(dbml)).toEqual([{ name: 'money_t', dataType: 'numeric(12,2)' }])
    const file = newDezignProject(parseDbml(dbml).tables, { domains: dezignDomainsOfModel(dbml) })
    const read = readDezign(file)
    expect(read.domains).toEqual([{ name: 'money_t', dataType: 'numeric(12,2)' }])
    // (A domain the model does not list: the column keeps its own type.)
    expect(read.tables[0]!.columns.map((c) => `${c.name} ${c.domain ?? '-'}`)).toEqual(['id -', 'balance money_t', 'note -'])
    expect(withDezignDomains(dbml, [])).not.toContain('Note domains')
  })

  it('writes a typed name as its own template, and a name the project\'s pattern gives with the pattern', () => {
    const file = make()
    const pair = (name: string) => new RegExp(`<NAME>${name}</NAME>\\s*<NAMETEMPLATE>([^<]*)</NAMETEMPLATE>`).exec(file)?.[1]
    expect(pair('orders_by_customer')).toBe('orders_by_customer')
    expect(pair('email_filled')).toBe('email_filled')
    expect(pair('PK_customers')).toBe('PK_%table%')
    expect(pair('customers_orders')).toBe('%parent%_%child%')
    // (The name the model has for a unique column is kept as well: scripts made here use it.)
    expect(pair('ux_customers_email')).toBe('ux_customers_email')
    const named = newDezignProject(parseDbml(`${dbml.replace(/\n  customer_id bigint \[not null, ref: > shop.customers.id\]/, '\n  customer_id bigint [not null]').replace('Ref: shop', 'Ref placed_by: shop')}`).tables, { today: '2026-11-10' })
    expect(named).toMatch(/<REL>\s*<NAME>placed_by<\/NAME>\s*<NAMETEMPLATE>placed_by<\/NAMETEMPLATE>/)
    expect(named).toMatch(/<CONSTRAINT>\s*<NAME>placed_by<\/NAME>\s*<NAMETEMPLATE>%relname%<\/NAMETEMPLATE>/)
    expect(readDezign(named).tables[1]!.foreignKeys[0]!.name).toBe('placed_by')
  })

  // DeZign names things from their patterns again when it opens a project: 14.9.3 turned `StateOrProvince_ZipCode`
  // into `StateOrProvince_renamed_ZipCode` after we renamed the table. The file now says what DeZign will say.
  it('names made from a pattern follow a renamed table; typed names stay', () => {
    const file = make()
    const viaDbml = (list: TableInfo[]) => parseDbml(toDbml(list)).tables
    const base = viaDbml(readDezign(file).tables)
    const target = viaDbml(readDezign(file).tables)
    target.find((t) => t.name === 'customers')!.name = 'clients'
    for (const t of target) for (const fk of t.foreignKeys) if (fk.refTable === 'customers') fk.refTable = 'clients'
    const saved = saveToDezign([{ path: 'm.dez', text: file }], base, viaDbml(target), { normalize: viaDbml })
    const out = saved.files[0]!.text
    expect(saved.changes.map((c) => c.kind)).toEqual(['rename_table'])
    expect(out).toMatch(/<REL>\s*<NAME>clients_orders<\/NAME>\s*<NAMETEMPLATE>%parent%_%child%<\/NAMETEMPLATE>/)
    expect(out).toMatch(/<CONSTRAINT>\s*<NAME>clients_orders<\/NAME>\s*<NAMETEMPLATE>%relname%<\/NAMETEMPLATE>/)
    expect(out).toContain('<NAME>PK_clients</NAME>')
    expect(out).toContain('<NAME>email_filled</NAME>')
    expect(out).not.toContain('customers_orders')
  })

  it('writes a new name of an index, a unique constraint, a check and a foreign key into the element that has it', () => {
    const file = make()
    const viaDbml = (list: TableInfo[]) => parseDbml(toDbml(list)).tables
    const base = viaDbml(readDezign(file).tables)
    const target = viaDbml(readDezign(file).tables)
    const [customers, orders] = [target.find((t) => t.name === 'customers')!, target.find((t) => t.name === 'orders')!]
    customers.checks![0]!.name = 'email_not_empty'
    customers.indexes.find((ix) => ix.unique && !ix.primary)!.name = 'uq_customer_mail'
    orders.indexes.find((ix) => !ix.unique && !ix.primary)!.name = 'orders_customer_placed'
    orders.foreignKeys[0]!.name = 'orders_customer_fk'
    const saved = saveToDezign([{ path: 'm.dez', text: file }], base, viaDbml(target), { normalize: viaDbml })
    expect(saved.changes.map((c) => `${c.kind} ${c.name}`).sort()).toEqual(['rename_check email_filled → email_not_empty', 'rename_index orders_by_customer → orders_customer_placed', 'rename_index ux_customers_email → uq_customer_mail', 'rename_relationship customers_orders → orders_customer_fk'])
    const out = saved.files[0]!.text
    for (const name of ['email_not_empty', 'uq_customer_mail', 'orders_customer_placed', 'orders_customer_fk']) expect(out).toMatch(new RegExp(`<NAME>${name}</NAME>\\s*<NAMETEMPLATE>${name}</NAMETEMPLATE>`))
    // The relationship itself keeps its name; nothing else in the file moved.
    expect(out).toMatch(/<REL>\s*<NAME>customers_orders<\/NAME>/)
    expect(out.split('\n').length).toBe(file.split('\n').length)
    const again = viaDbml(readDezign(out).tables)
    expect(again.find((t) => t.name === 'orders')!.foreignKeys[0]!.name).toBe('orders_customer_fk')
    expect(saveToDezign([{ path: 'm.dez', text: out }], again, again, { normalize: viaDbml }).changes).toEqual([])
  })

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
    // Shaped as DeZign 14 writes a project: its settings sections, and every constraint with the template it is named by.
    for (const section of ['NAMETEMPLATES', 'REPOSITORYSETTINGS', 'GenDB_DBParams', 'GenDB_Options', 'UpdDB_Options', 'MiscSettings']) expect(file, section).toContain(`<${section}>`)
    expect(file).toMatch(/<PKCON>\n<NAME>PK_customers<\/NAME>\n<NAMETEMPLATE>PK_%table%<\/NAMETEMPLATE>/)
    expect(file).toMatch(/<REL>\n<NAME>customers_orders<\/NAME>\n<NAMETEMPLATE>%parent%_%child%<\/NAMETEMPLATE>/)
    expect(file).toMatch(/<NNCON>\n<NAME>[^<]*<\/NAME>\n<NAMETEMPLATE>NN_%table%_%column%<\/NAMETEMPLATE>/)
    expect(file).not.toContain('<VIRTUALREL>')
    // Read back, the project says how its scripts are to be: key names by its template, domains kept.
    expect(model.nameTemplates.PKCONNAMETEMPLATE).toBe('PK_%table%')
    expect(model.scripting.primaryKeys).toMatchObject({ template: 'PK_%table%', names: { 'shop.customers': 'PK_customers' } })
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

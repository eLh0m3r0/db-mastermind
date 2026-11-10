import { describe, expect, it } from 'vitest'
import { assembleDezignProject, detectDezignEncoding, parseDbml, parseDezignXml, readDezign, serializeDezignXml, toDbml } from '../src/index.js'

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

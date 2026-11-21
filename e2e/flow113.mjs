// Models from other tools (Milestone 12, A2), all hand-written here in the tools' formats: a MySQL Workbench model
// given on the command line opens as a new unsaved model with its tables where Workbench drew them and a notice of
// what it left out, and Save makes a .dbml without touching the .mwb; a drawDB diagram handed to the app (macOS
// open-file) opens as a model with its note and subject area, while another .json is data to query; a Mermaid ER
// diagram comes in through the model's Import menu; a Prisma schema through Open model.
import { _electron as electron } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'

const out = process.argv[2] ?? tmpdir()
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui113-'))

// --- The files ---
const v = (key, type, value) => `<value type="${type}" key="${key}">${value}</value>`
const column = (id, name, type, { length = -1, notNull = false, auto = false, unsigned = false } = {}) =>
  `<value type="object" struct-name="db.mysql.Column" id="${id}">${v('autoIncrement', 'int', auto ? 1 : 0)}${v('defaultValueIsNull', 'int', notNull ? 0 : 1)}<value type="list" content-type="string" key="flags">${unsigned ? '<value type="string">UNSIGNED</value>' : ''}</value>${v('isNotNull', 'int', notNull ? 1 : 0)}${v('length', 'int', length)}<link type="object" struct-name="db.SimpleDatatype" key="simpleType">com.mysql.rdbms.mysql.datatype.${type}</link>${v('name', 'string', name)}</value>`
const primary = (id, col) => `<value type="object" struct-name="db.mysql.Index" id="${id}"><value type="list" content-type="object" key="columns"><value type="object" struct-name="db.mysql.IndexColumn" id="${id}-c">${v('columnLength', 'int', 0)}<link type="object" struct-name="db.Column" key="referencedColumn">${col}</link></value></value>${v('indexType', 'string', 'PRIMARY')}${v('isPrimary', 'int', 1)}${v('name', 'string', 'PRIMARY')}</value>`
const figure = (id, table, left, top, color) => `<value type="object" struct-name="workbench.physical.TableFigure" id="${id}"><link type="object" struct-name="db.Table" key="table">${table}</link><link type="object" struct-name="model.Layer" key="layer">root</link>${v('left', 'real', left)}${v('top', 'real', top)}${v('width', 'real', 150)}${v('height', 'real', 90)}${v('color', 'string', color)}</value>`
const mwbXml = `<?xml version="1.0"?>
<data grt_format="2.0" document_type="MySQL Workbench Model" version="1.4.4">
 <value type="object" struct-name="workbench.Document" id="doc">
  <value type="list" content-type="object" key="physicalModels">
   <value type="object" struct-name="workbench.physical.Model" id="pm">
    <value type="object" struct-name="db.mysql.Catalog" id="cat" key="catalog">
     <value type="list" content-type="object" key="schemata">
      <value type="object" struct-name="db.mysql.Schema" id="s1">${v('name', 'string', 'shop')}
       <value type="list" content-type="object" key="views"><value type="object" struct-name="db.mysql.View" id="v1">${v('name', 'string', 'big_orders')}</value></value>
       <value type="list" content-type="object" key="routines"><value type="object" struct-name="db.mysql.Routine" id="r1">${v('name', 'string', 'refresh')}</value></value>
       <value type="list" content-type="object" key="tables">
        <value type="object" struct-name="db.mysql.Table" id="t1">${v('name', 'string', 'customer')}
         <value type="list" content-type="object" key="columns">${column('c1', 'customer_id', 'smallint', { notNull: true, auto: true, unsigned: true })}${column('c2', 'email', 'varchar', { length: 50, notNull: true })}</value>
         <value type="list" content-type="object" key="indices">${primary('i1', 'c1')}</value>
        </value>
        <value type="object" struct-name="db.mysql.Table" id="t2">${v('name', 'string', 'payment')}
         <value type="list" content-type="object" key="columns">${column('p1', 'payment_id', 'int', { notNull: true, auto: true })}${column('p2', 'customer_id', 'smallint', { notNull: true, unsigned: true })}</value>
         <value type="list" content-type="object" key="indices">${primary('i2', 'p1')}</value>
         <value type="list" content-type="object" key="foreignKeys"><value type="object" struct-name="db.mysql.ForeignKey" id="fk1"><link type="object" struct-name="db.mysql.Table" key="referencedTable">t1</link><value type="list" content-type="object" key="columns"><link type="object">p2</link></value><value type="list" content-type="object" key="referencedColumns"><link type="object">c1</link></value>${v('deleteRule', 'string', 'RESTRICT')}${v('updateRule', 'string', 'CASCADE')}${v('many', 'int', 1)}${v('name', 'string', 'fk_payment_customer')}</value></value>
        </value>
       </value>
      </value>
     </value>
    </value>
    <value type="list" content-type="object" key="diagrams">
     <value type="object" struct-name="workbench.physical.Diagram" id="d1">${v('name', 'string', 'EER Diagram')}<value type="object" struct-name="workbench.physical.Layer" id="root" key="rootLayer"/>
      <value type="list" content-type="object" key="figures">${figure('f1', 't1', 40, 60, '#98BFDA')}${figure('f2', 't2', 400, 60, '#FFAA00')}</value>
     </value>
    </value>
   </value>
  </value>
 </value>
</data>`
const mwb = join(dir, 'shop.mwb')
writeFileSync(mwb, zipSync({ 'document.mwb.xml': strToU8(mwbXml), lock: strToU8('') }))
const mwbBytes = readFileSync(mwb)

const field = (id, name, type, extra = {}) => ({ id, name, type, default: '', check: '', primary: false, unique: false, notNull: false, increment: false, comment: '', ...extra })
const drawdb = join(dir, 'library.json')
writeFileSync(
  drawdb,
  JSON.stringify({
    title: 'Library',
    database: 'postgresql',
    tables: [
      { id: 'a', name: 'author', x: 60, y: 80, color: '#175e7a', comment: '', indices: [], fields: [field('a1', 'id', 'INTEGER', { primary: true, notNull: true, increment: true }), field('a2', 'name', 'VARCHAR', { size: 100, notNull: true })] },
      { id: 'b', name: 'book', x: 420, y: 80, color: '#ff9159', comment: 'In print', indices: [{ id: 0, name: 'book_title_idx', unique: false, fields: ['title'] }], fields: [field('b1', 'id', 'INTEGER', { primary: true, notNull: true, increment: true }), field('b2', 'author_id', 'INTEGER', { notNull: true }), field('b3', 'title', 'TEXT', { notNull: true })] },
    ],
    relationships: [{ id: 'r', name: 'book_author_fk', startTableId: 'b', startFieldId: 'b2', endTableId: 'a', endFieldId: 'a1', cardinality: 'many_to_one', updateConstraint: 'No action', deleteConstraint: 'Cascade' }],
    notes: [{ id: 0, x: 60, y: 360, title: 'Next', content: 'Add loans', color: '#fcf7ac', height: 88 }],
    subjectAreas: [{ id: 0, name: 'Catalogue', x: 20, y: 20, width: 700, height: 300, color: '#175e7a' }],
  }),
)
const data = join(dir, 'readings.json')
writeFileSync(data, JSON.stringify([{ id: 1, value: 3.5 }, { id: 2, value: 4.25 }]))
const mermaid = join(dir, 'clinic.mmd')
writeFileSync(mermaid, 'erDiagram\n  PATIENT ||--o{ VISIT : has\n  PATIENT {\n    int id PK\n    string name\n  }\n  VISIT {\n    int id PK\n    int patient_id FK\n    datetime at\n  }\n  DOCTOR }o--o{ PATIENT : treats\n  DOCTOR {\n    int id PK\n  }\n')
const prisma = join(dir, 'schema.prisma')
writeFileSync(prisma, 'datasource db {\n  provider = "postgresql"\n}\n\n/// A team\nmodel team {\n  id      Int      @id @default(autoincrement())\n  members member[]\n}\n\nmodel member {\n  id      Int  @id\n  team_id Int\n  team    team @relation(fields: [team_id], references: [id])\n}\n')

// --- The app ---
const app = await electron.launch({ args: ['apps/desktop', mwb], env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` (${detail})`}`)
  if (!ok) process.exitCode = 1
}
const modelText = () => win.locator('.cm-content:visible').first().innerText()
const node = (name) => win.locator(`.react-flow__node[data-id$=".${name}"]`)
const tab = (title) => win.getByRole('tab').filter({ hasText: title })
const handTheApp = (path) => app.evaluate(({ app }, path) => app.emit('open-file', { preventDefault() {} }, path), path)
try {
  // The Workbench model from the command line.
  await tab('shop.mwb').waitFor({ timeout: 20000 })
  await node('payment').waitFor({ timeout: 15000 })
  await win.getByText('MySQL Workbench model shop.mwb: 2 tables').waitFor({ timeout: 5000 })
  const notice = await win.getByText('Not taken from the file:').first().innerText()
  check('the notice counts what was left out', /views: 1/.test(notice) && /procedures and functions: 1/.test(notice), notice)
  const text = await modelText()
  check('the tables with MySQL types, keys and rules', /customer_id "smallint unsigned" \[pk, increment\]/.test(text) && /Ref fk_payment_customer: payment\.customer_id > customer\.customer_id \[delete: restrict, update: cascade\]/.test(text), text.slice(0, 300))
  const [a, b] = [await node('customer').boundingBox(), await node('payment').boundingBox()]
  check('the tables where Workbench drew them (side by side, spread to the app’s size)', !!a && !!b && b.x - a.x > a.width && Math.abs(a.y - b.y) < a.height / 4, JSON.stringify([a, b]))
  await win.screenshot({ path: `${out}/r113-mwb.png` })
  // Save asks where: a .dbml; the .mwb stays as it was.
  const saved = join(dir, 'shop.dbml')
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, saved)
  await win.locator('.cm-content:visible').first().click()
  await win.keyboard.press('ControlOrMeta+s')
  for (let i = 0; i < 50 && !existsSync(saved); i++) await win.waitForTimeout(200)
  check('Save makes a .dbml model', existsSync(saved) && /Table customer/.test(readFileSync(saved, 'utf8')))
  check('the .mwb is not changed', readFileSync(mwb).equals(mwbBytes))

  // A drawDB diagram handed to the app opens as a model; other JSON is data.
  await handTheApp(drawdb)
  await tab('library.json').waitFor({ timeout: 15000 })
  await node('book').waitFor({ timeout: 15000 })
  const lib = await modelText()
  check('drawDB: tables, the relationship with its action, the index', /Ref book_author_fk: book\.author_id > author\.id \[delete: cascade\]/.test(lib) && /title \[name: 'book_title_idx'\]/.test(lib), lib.slice(0, 400))
  check('drawDB: its note and subject area on the diagram', (await win.getByText('Add loans').count()) > 0 && (await win.getByText('Catalogue').count()) > 0)
  await win.screenshot({ path: `${out}/r113-drawdb.png` })
  await handTheApp(data)
  await win.waitForTimeout(4000)
  await tab('readings.json').waitFor({ timeout: 15000 })
  await win.waitForTimeout(1500)
  check('another .json is data to query: a query on it, not a model', (await win.locator('.cm-content:visible').first().innerText()).includes('read_json') && (await win.locator('.react-flow:visible').count()) === 0)

  // A Mermaid ER diagram through a new model's Import menu.
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, mermaid)
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('New model')
  await win.keyboard.press('Enter')
  await win.locator('[data-testid="model-import"]:visible').waitFor({ timeout: 10000 })
  await win.locator('[data-testid="model-import"]:visible').click()
  await win.getByRole('menuitem', { name: 'SQL, Prisma, Mermaid, drawDB or MySQL Workbench file…' }).click()
  await node('VISIT').waitFor({ timeout: 15000 })
  const clinic = await modelText()
  check('Mermaid: entities, attributes and the relationship on the FK column', /Table PATIENT/.test(clinic) && /Ref: VISIT\.patient_id > PATIENT\.id/.test(clinic), clinic.slice(0, 300))
  check('Mermaid: the many-to-many relationship is counted, not made up', (await win.getByText(/many-to-many relationships: 1/).count()) > 0)

  // A Prisma schema through Open model.
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, prisma)
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('Open model')
  await win.keyboard.press('Enter')
  await tab('schema.prisma').waitFor({ timeout: 15000 })
  const team = await modelText()
  check('Prisma: models, the relation and its /// comment', /Table team/.test(team) && /Ref: member\.team_id > team\.id/.test(team) && /Note: 'A team'/.test(team), team.slice(0, 300))
  await win.screenshot({ path: `${out}/r113-prisma.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  process.exitCode = 1
  await win.screenshot({ path: `${out}/r113-error.png` }).catch(() => {})
} finally {
  check('no page errors', errors.length === 0, JSON.stringify(errors.slice(0, 3)))
  await app.close()
}

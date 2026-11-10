// DeZign for Databases models: open a .dez and a folder project (.dezproj) as a model, with the source's layout.
// The models are written here; no real project is used.
import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'dbm-ui91-'))
const el = (tag, body) => `<${tag}>\n${body}\n</${tag}>`
const attr = (id, name, type, extra = '') => el('ATTR', `<NAME>${name}</NAME>\n<ID>${id}</ID>\n<DESC></DESC>\n<DOMAINID></DOMAINID>\n<DT>\n<DTLISTNAME>${type}</DTLISTNAME>\n<SD>1</SD>\n<INC>1</INC>\n</DT>\n${extra}`)
const ent = (id, name, desc, pk, attrs) => el('ENT', `<NAME>${name}</NAME>\n<ID>${id}</ID>\n<SCHEMA>shop</SCHEMA>\n<DESC>${desc}</DESC>\n<PKCON>\n<ATTRIBUTEIDS>\n<ATTRIBUTEID>${pk}</ATTRIBUTEID>\n</ATTRIBUTEIDS>\n</PKCON>\n<ATTRIBUTES>\n${attrs.join('\n')}\n</ATTRIBUTES>`)
const rel = (id, name, parent, child, key, fk) => el('REL', `<NAME>${name}</NAME>\n<ID>${id}</ID>\n<PARENTOBJECTID>${parent}</PARENTOBJECTID>\n<CHILDOBJECTID>${child}</CHILDOBJECTID>\n<UPDATERULE>0</UPDATERULE>\n<DELETERULE>2</DELETERULE>\n<PAIRS>\n<PAIR>\n<KEYID>${key}</KEYID>\n<FOREIGNKEYID>${fk}</FOREIGNKEYID>\n</PAIR>\n</PAIRS>`)
const entc = (id, l, t, brush = '0,16119285') => el('ENTC', `<ID>${id}</ID>\n<DIAGRAMID>1</DIAGRAMID>\n<W>240</W>\n<H>100</H>\n<L>${l}</L>\n<T>${t}</T>\n<BRUSH>${brush}</BRUSH>`)
const settings = el('PROJECTSETTINGS', el('COMMONSETTINGS', '<PROJECTNAME /></PROJECTNAME />\n<FILEFORMATVERSION>140</FILEFORMATVERSION>'))
const diagram = el('DIAGRAM', '<ID>1</ID>\n<NAME>Main</NAME>\n<ISMAINDIAGRAM>1</ISMAINDIAGRAM>')
const billing = el('DIAGRAM', '<ID>2</ID>\n<NAME>Billing</NAME>\n<ISMAINDIAGRAM>0</ISMAINDIAGRAM>')
// "Zákazník" in Windows-1250 bytes under DeZign's Latin-1 declaration.
const entities = [
  ent('10', 'customer', 'Z\xe1kazn\xedk, kter\xfd plat\xed \xf8\xe1dn\xec', 'A1', [attr('A1', 'id', 'BIGINT', '<NNCON>\n<VALUE>1</VALUE>\n</NNCON>'), attr('A2', 'name', 'TEXT')]),
  ent('20', 'invoice', '', 'B1', [attr('B1', 'id', 'BIGINT'), attr('B2', 'customer_id', 'BIGINT')]),
  ent('30', 'payment', '', 'C1', [attr('C1', 'id', 'BIGINT'), attr('C2', 'invoice_id', 'BIGINT')]),
]
const rels = [rel('40', 'customer_invoice', '10', '20', 'A1', 'B2'), rel('41', 'invoice_payment', '20', '30', 'B1', 'C2')]
// The invoice is light yellow in DeZign (BGR 0x80FFFF); a text area sits above the customer.
const controls = [entc('10', 0, 0), entc('20', 900, 0, '0,8454143'), entc('30', 900, 700)]
const textArea = el('TEXTAR', '<NAME>TextArea1</NAME>\n<ID>T1</ID>\n<TEXT>Prodej</TEXT>')
const textControl = el('TEXTC', '<ID>T1</ID>\n<DIAGRAMID>1</DIAGRAMID>\n<W>200</W>\n<H>30</H>\n<L>300</L>\n<T>300</T>')
// The Billing diagram shows two of the three tables, laid out differently.
const billingControls = [entc('20', 50, 50), entc('30', 50, 500)].map((c) => c.replace('<DIAGRAMID>1</DIAGRAMID>', '<DIAGRAMID>2</DIAGRAMID>'))
const head = '<?xml version="1.0" encoding="iso-8859-1"?>'
const dez = join(dir, 'shop.dez')
writeFileSync(dez, `${head}<dezign>\n<VERSION>\n${settings}\n<DATADICT>\n<DBID>postgresql16</DBID>\n<DOMAINS>\n</DOMAINS>\n<TEXTAREAS>\n${textArea}\n</TEXTAREAS>\n<ENTITIES>\n${entities.join('\n')}\n</ENTITIES>\n<VIEWS>\n<VIEW>\n<NAME>v</NAME>\n</VIEW>\n</VIEWS>\n<RELATIONSHIPS>\n${rels.join('\n')}\n</RELATIONSHIPS>\n</DATADICT>\n<DIAGRAMS>\n<DisplayPreferences>\n<DEFENTCOLOR>16119285</DEFENTCOLOR>\n</DisplayPreferences>\n${diagram}\n${billing}\n<CONTROLS>\n<ENTITYCONTROLS>\n${controls.join('\n')}\n${billingControls.join('\n')}\n</ENTITYCONTROLS>\n<TEXTAREACONTROLS>\n${textControl}\n</TEXTAREACONTROLS>\n</CONTROLS>\n</DIAGRAMS>\n</VERSION>\n<VERSION>\n<VERSIONINFO>\n<VERSIONNUMBER>1</VERSIONNUMBER>\n<VERSIONLABEL>First release</VERSIONLABEL>\n<VERSIONDATE>2026-01-15</VERSIONDATE>\n</VERSIONINFO>\n<DATADICT>\n<DBID>postgresql16</DBID>\n<ENTITIES>\n${entities.slice(0, 2).join('\n')}\n</ENTITIES>\n<RELATIONSHIPS>\n${rels[0]}\n</RELATIONSHIPS>\n</DATADICT>\n</VERSION>\n</dezign>\n`, 'latin1')
const before = readFileSync(dez)

const project = join(dir, 'ShopProject')
const put = (path, text) => { mkdirSync(join(project, path, '..'), { recursive: true }); writeFileSync(join(project, path), `${head}\r\n${text}`, 'latin1') }
put('Shop.dezproj', settings)
put('Shop.dds', el('DATADICT', '<DBID>postgresql16</DBID>'))
entities.forEach((e, i) => put(`data dictionary/entities/shop.e${i}.xml`, e))
rels.forEach((r, i) => put(`data dictionary/relationships/r${i}.xml`, r))
put('diagrams/1.xml', diagram)
controls.forEach((c, i) => put(`diagrams/diagramobjects/entitycontrols/1-${i}.xml`, c))
put('archived versions/old.xml', el('VERSION', `${el('VERSIONINFO', '<VERSIONNUMBER>4</VERSIONNUMBER>\n<VERSIONLABEL>Before payments</VERSIONLABEL>\n<VERSIONDATE>2026-02-01</VERSIONDATE>')}\n${el('DATADICT', `<DBID>postgresql16</DBID>\n${el('ENTITIES', entities.slice(0, 2).join('\n'))}`)}`))

const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' } })
const pick = (file) => app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, file)
const win = await app.firstWindow()
const openModel = async () => {
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('Open model')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(2500)
}
const positions = () => win.evaluate(() => Object.fromEntries([...document.querySelectorAll('.react-flow__node')].map((n) => [n.getAttribute('data-id'), /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(n.style.transform)?.slice(1).map(Number)])))
try {
  await win.waitForTimeout(800)
  await win.evaluate(() => window.mastermind.api.createSampleDatabase())
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Demo coffee shop/ }).first().click()
  await win.waitForTimeout(1500)

  await pick(dez)
  await openModel()
  const text = await win.locator('.cm-content:visible').first().innerText()
  const pos = await positions()
  console.log('dez tables:', await win.locator('.react-flow__node:not([data-id^="note:"])').count(), 'edges:', await win.locator('.react-flow__edge').count())
  const noteNode = win.locator('.react-flow__node[data-id^="note:"]')
  console.log('text area as a note:', await noteNode.count(), JSON.stringify(await noteNode.first().evaluate((n) => (n.querySelector('textarea')?.value ?? n.innerText).trim())), 'invoice colored:', await win.locator('.react-flow__node[data-id="shop.invoice"]').evaluate((n) => /series-4/.test(n.innerHTML)))
  console.log('dez dbml:', text.includes('Table shop.customer'), text.includes('Ref: shop.invoice.customer_id > shop.customer.id [delete: cascade]'), 'czech note:', text.includes('Zákazník, který platí řádně'))
  console.log('dez layout kept:', JSON.stringify(pos['shop.customer']), JSON.stringify(pos['shop.invoice']), JSON.stringify(pos['shop.payment']))
  console.log('toast:', await win.getByText(/Opened a DeZign for Databases model: 3 tables/).count(), await win.getByText(/views: 1/).count(), 'title:', await win.getByText('shop.dez', { exact: true }).count())
  console.log('source untouched by opening:', readFileSync(dez).equals(before))

  // The source's second diagram is a subject area with its own tables and layout.
  await win.getByTestId('model-area').selectOption({ label: 'Billing (2)' })
  await win.waitForTimeout(1500)
  const area = await positions()
  console.log('billing diagram:', Object.keys(area).sort().join(','), JSON.stringify(area['shop.invoice']), JSON.stringify(area['shop.payment']))
  await win.getByTestId('model-area').selectOption({ label: 'Whole model' })
  await win.waitForTimeout(1200)

  // Save with no edits writes nothing.
  await win.getByRole('button', { name: 'Save', exact: true }).click()
  await win.getByText(/Nothing to save/).waitFor({ timeout: 10000 })
  console.log('no-op save untouched:', readFileSync(dez).equals(before))

  // Edit in the DBML editor: rename a column, add a column; Save lists the changes and writes them into the .dez.
  const editor = win.locator('.cm-content:visible').first()
  const edited = (await editor.innerText()).replace('  name text', "  full_name text\n  vat_id varchar(20) [note: 'DIČ plátce']")
  await editor.click()
  await win.keyboard.press('Meta+a')
  await win.keyboard.insertText(edited)
  await win.waitForTimeout(900)
  await win.getByRole('button', { name: 'Save', exact: true }).click()
  await win.getByText(/Write these changes into shop\.dez\?/).waitFor({ timeout: 10000 })
  const listed = await win.locator('[role="dialog"], .fixed').filter({ hasText: 'Write these changes' }).last().innerText()
  console.log('confirm lists:', /renamed column: customer \(name → full_name\)/.test(listed), /new column: customer \(vat_id\)/.test(listed), 'draft warning:', /not been checked in DeZign/.test(listed))
  await win.getByRole('button', { name: 'Write to the DeZign file' }).click()
  await win.getByText(/Saved to shop\.dez/).waitFor({ timeout: 10000 })
  const after = readFileSync(dez, 'latin1')
  const beforeLines = new Set(before.toString('latin1').split('\n'))
  const changed = after.split('\n').filter((l) => !beforeLines.has(l))
  console.log('written:', after.includes('<NAME>full_name</NAME>'), after.includes('<NAME>vat_id</NAME>'), after.includes('<DESC>DI\xc8 pl\xe1tce</DESC>'), 'kept:', after.includes('<VIEW>'), after.includes('<PROJECTNAME /></PROJECTNAME />'), 'changed lines:', changed.length)
  const backupRoot = join(dir, 'data', 'dezign-backups')
  const backups = readdirSync(backupRoot)
  console.log('backup:', backups.length, readFileSync(join(backupRoot, backups[0], 'shop.dez')).equals(before))
  // Saving again right away: nothing to do, and the file is not touched.
  await win.getByRole('button', { name: 'Save', exact: true }).click()
  await win.getByText(/Nothing to save/).last().waitFor({ timeout: 10000 })
  console.log('second save untouched:', readFileSync(dez, 'latin1') === after)

  // What changed since a version archived in the project: the payment table came after "First release".
  await win.getByTestId('model-compare-versions').click()
  await win.getByText('v1 · First release · 2026-01-15').click()
  await win.getByRole('button', { name: 'Compare', exact: true }).click()
  await win.getByText(/Create table/).first().waitFor({ timeout: 20000 })
  console.log('compare with an archived version:', await win.getByText(/Changes since v1/).count() > 0, 'changes:', await win.getByText(/Create table/).count())

  await pick(join(project, 'Shop.dezproj'))
  await openModel()
  console.log('folder project versions:', JSON.stringify(await win.evaluate((p) => window.mastermind.api.listModelVersions(p), join(project, 'Shop.dezproj'))), (await win.evaluate(async (p) => (await window.mastermind.api.openModelVersion(p, 'old.xml')).text.match(/^Table /gm)?.length, join(project, 'Shop.dezproj'))), 'tables in it')
  const text2 = await win.locator('.cm-content:visible').first().innerText()
  console.log('project tables:', await win.locator('.react-flow__node:visible').count(), 'dbml:', text2.includes('Table shop.payment'), text2.includes('Ref: shop.payment.invoice_id > shop.invoice.id'))
  if (process.argv[2]) await win.screenshot({ path: join(process.argv[2], 'flow91.png') })

  // A real model from this machine (DBM_DEZ_FILE=…/x.dez or …/x.dezproj): counts and time only, nothing from its content.
  if (process.env.DBM_DEZ_FILE) {
    await pick(process.env.DBM_DEZ_FILE)
    // Diagrams of the tabs opened above stay mounted: wait for more tables than they have.
    const before = await win.locator('.react-flow__node').count()
    const started = Date.now()
    await win.keyboard.press('Meta+k')
    await win.keyboard.type('Open model')
    await win.keyboard.press('Enter')
    await win.waitForFunction((n) => document.querySelectorAll('.react-flow__node').length > n, before, { timeout: 120000 })
    const shown = Date.now() - started
    const said = await win.evaluate(() => (document.body.innerText.match(/Opened a DeZign for Databases model: \d+/g) ?? []).pop()?.replace(/\D+/, ''))
    console.log('local model: tables', said, '| diagram after', shown, 'ms | tables drawn', (await win.locator('.react-flow__node').count()) - before, '| dbml errors', await win.locator('.text-warning button').count())
  }
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
} finally {
  await app.close()
}

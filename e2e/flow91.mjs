// DeZign for Databases models: open a .dez and a folder project (.dezproj) as a model, with the source's layout.
// The models are written here; no real project is used.
import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'dbm-ui91-'))
const el = (tag, body) => `<${tag}>\n${body}\n</${tag}>`
const attr = (id, name, type, extra = '') => el('ATTR', `<NAME>${name}</NAME>\n<ID>${id}</ID>\n<DESC></DESC>\n<DOMAINID></DOMAINID>\n<DT>\n<DTLISTNAME>${type}</DTLISTNAME>\n<SD>1</SD>\n<INC>1</INC>\n</DT>\n${extra}`)
const ent = (id, name, desc, pk, attrs) => el('ENT', `<NAME>${name}</NAME>\n<ID>${id}</ID>\n<SCHEMA>shop</SCHEMA>\n<DESC>${desc}</DESC>\n<PKCON>\n<ATTRIBUTEIDS>\n<ATTRIBUTEID>${pk}</ATTRIBUTEID>\n</ATTRIBUTEIDS>\n</PKCON>\n<ATTRIBUTES>\n${attrs.join('\n')}\n</ATTRIBUTES>`)
const rel = (id, name, parent, child, key, fk) => el('REL', `<NAME>${name}</NAME>\n<ID>${id}</ID>\n<PARENTOBJECTID>${parent}</PARENTOBJECTID>\n<CHILDOBJECTID>${child}</CHILDOBJECTID>\n<UPDATERULE>0</UPDATERULE>\n<DELETERULE>2</DELETERULE>\n<PAIRS>\n<PAIR>\n<KEYID>${key}</KEYID>\n<FOREIGNKEYID>${fk}</FOREIGNKEYID>\n</PAIR>\n</PAIRS>`)
const entc = (id, l, t) => el('ENTC', `<ID>${id}</ID>\n<DIAGRAMID>1</DIAGRAMID>\n<W>240</W>\n<H>100</H>\n<L>${l}</L>\n<T>${t}</T>`)
const settings = el('PROJECTSETTINGS', el('COMMONSETTINGS', '<PROJECTNAME /></PROJECTNAME />\n<FILEFORMATVERSION>140</FILEFORMATVERSION>'))
const diagram = el('DIAGRAM', '<ID>1</ID>\n<NAME>Main</NAME>\n<ISMAINDIAGRAM>1</ISMAINDIAGRAM>')
// "Zákazník" in Windows-1250 bytes under DeZign's Latin-1 declaration.
const entities = [
  ent('10', 'customer', 'Z\xe1kazn\xedk, kter\xfd plat\xed \xf8\xe1dn\xec', 'A1', [attr('A1', 'id', 'BIGINT', '<NNCON>\n<VALUE>1</VALUE>\n</NNCON>'), attr('A2', 'name', 'TEXT')]),
  ent('20', 'invoice', '', 'B1', [attr('B1', 'id', 'BIGINT'), attr('B2', 'customer_id', 'BIGINT')]),
  ent('30', 'payment', '', 'C1', [attr('C1', 'id', 'BIGINT'), attr('C2', 'invoice_id', 'BIGINT')]),
]
const rels = [rel('40', 'customer_invoice', '10', '20', 'A1', 'B2'), rel('41', 'invoice_payment', '20', '30', 'B1', 'C2')]
const controls = [entc('10', 0, 0), entc('20', 900, 0), entc('30', 900, 700)]
const head = '<?xml version="1.0" encoding="iso-8859-1"?>'
const dez = join(dir, 'shop.dez')
writeFileSync(dez, `${head}<dezign>\n<VERSION>\n${settings}\n<DATADICT>\n<DBID>postgresql16</DBID>\n<DOMAINS>\n</DOMAINS>\n<ENTITIES>\n${entities.join('\n')}\n</ENTITIES>\n<VIEWS>\n<VIEW>\n<NAME>v</NAME>\n</VIEW>\n</VIEWS>\n<RELATIONSHIPS>\n${rels.join('\n')}\n</RELATIONSHIPS>\n</DATADICT>\n<DIAGRAMS>\n${diagram}\n<CONTROLS>\n<ENTITYCONTROLS>\n${controls.join('\n')}\n</ENTITYCONTROLS>\n</CONTROLS>\n</DIAGRAMS>\n</VERSION>\n</dezign>\n`, 'latin1')
const before = readFileSync(dez)

const project = join(dir, 'ShopProject')
const put = (path, text) => { mkdirSync(join(project, path, '..'), { recursive: true }); writeFileSync(join(project, path), `${head}\r\n${text}`, 'latin1') }
put('Shop.dezproj', settings)
put('Shop.dds', el('DATADICT', '<DBID>postgresql16</DBID>'))
entities.forEach((e, i) => put(`data dictionary/entities/shop.e${i}.xml`, e))
rels.forEach((r, i) => put(`data dictionary/relationships/r${i}.xml`, r))
put('diagrams/1.xml', diagram)
controls.forEach((c, i) => put(`diagrams/diagramobjects/entitycontrols/1-${i}.xml`, c))
put('archived versions/old.xml', el('VERSION', el('VERSIONINFO', '<VERSIONNUMBER>1</VERSIONNUMBER>')))

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
  console.log('dez tables:', await win.locator('.react-flow__node').count(), 'edges:', await win.locator('.react-flow__edge').count())
  console.log('dez dbml:', text.includes('Table shop.customer'), text.includes('Ref: shop.invoice.customer_id > shop.customer.id [delete: cascade]'), 'czech note:', text.includes('Zákazník, který platí řádně'))
  console.log('dez layout kept:', JSON.stringify(pos['shop.customer']), JSON.stringify(pos['shop.invoice']), JSON.stringify(pos['shop.payment']))
  console.log('toast:', await win.getByText(/Opened a DeZign for Databases model: 3 tables/).count(), await win.getByText(/views: 1/).count(), 'unsaved:', await win.getByText('shop.dez').count() === 0 || (await win.getByText('Unsaved model').count()) > 0)
  console.log('source untouched:', readFileSync(dez).equals(before))

  await pick(join(project, 'Shop.dezproj'))
  await openModel()
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

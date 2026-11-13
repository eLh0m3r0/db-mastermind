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
// (Display level 0 and data type display 3: all columns with their types, as DeZign writes them.)
const diagram = el('DIAGRAM', '<ID>1</ID>\n<NAME>Main</NAME>\n<ISMAINDIAGRAM>1</ISMAINDIAGRAM>\n<DISPLAYLEVEL>0</DISPLAYLEVEL>\n<VISIBLEATTR>3</VISIBLEATTR>')
const billing = el('DIAGRAM', '<ID>2</ID>\n<NAME>Billing</NAME>\n<ISMAINDIAGRAM>0</ISMAINDIAGRAM>\n<DISPLAYLEVEL>0</DISPLAYLEVEL>\n<VISIBLEATTR>3</VISIBLEATTR>')
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
writeFileSync(dez, `${head}<dezign>\n<VERSION>\n${settings}\n<DATADICT>\n<DBID>postgresql16</DBID>\n<DOMAINS>\n</DOMAINS>\n<TEXTAREAS>\n${textArea}\n</TEXTAREAS>\n<GROUPBOXES>\n<GROUPBOX>\n<NAME>GroupBox1</NAME>\n<ID>G1</ID>\n<OBJECTCAPTION>Billing</OBJECTCAPTION>\n</GROUPBOX>\n</GROUPBOXES>\n<ENTITIES>\n${entities.join('\n')}\n</ENTITIES>\n<VIEWS>\n<VIEW>\n<NAME>v_unpaid</NAME>\n<ID>V1</ID>\n<SCHEMA>shop</SCHEMA>\n<CODE>CREATE VIEW %viewname% AS\nSELECT id FROM shop.invoice;</CODE>\n</VIEW>\n</VIEWS>\n<RELATIONSHIPS>\n${rels.join('\n')}\n</RELATIONSHIPS>\n</DATADICT>\n<DIAGRAMS>\n<DisplayPreferences>\n<DEFENTCOLOR>16119285</DEFENTCOLOR>\n</DisplayPreferences>\n${diagram}\n${billing}\n<CONTROLS>\n<ENTITYCONTROLS>\n${controls.join('\n')}\n${billingControls.join('\n')}\n</ENTITYCONTROLS>\n<TEXTAREACONTROLS>\n${textControl}\n</TEXTAREACONTROLS>\n<GROUPBOXESCONTROLS>\n<GROUPBOXC>\n<ID>G1</ID>\n<DIAGRAMID>1</DIAGRAMID>\n<W>420</W>\n<H>980</H>\n<L>840</L>\n<T>-60</T>\n</GROUPBOXC>\n</GROUPBOXESCONTROLS>\n</CONTROLS>\n</DIAGRAMS>\n</VERSION>\n<VERSION>\n<VERSIONINFO>\n<VERSIONNUMBER>1</VERSIONNUMBER>\n<VERSIONLABEL>First release</VERSIONLABEL>\n<VERSIONDATE>2026-01-15</VERSIONDATE>\n</VERSIONINFO>\n<DATADICT>\n<DBID>postgresql16</DBID>\n<ENTITIES>\n${entities.slice(0, 2).join('\n')}\n</ENTITIES>\n<RELATIONSHIPS>\n${rels[0]}\n</RELATIONSHIPS>\n</DATADICT>\n</VERSION>\n</dezign>\n`, 'latin1')
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
  // (A DeZign project opens on its objects: this flow works with the model's text.)
  await win.getByRole('button', { name: 'Text (DBML)' }).last().click().catch(() => {})
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
  const noteNode = win.locator('.react-flow__node[data-id^="note:"]:not([data-id^="note:box:"])')
  console.log('text area as a note:', await noteNode.count(), JSON.stringify(await noteNode.first().evaluate((n) => (n.querySelector('textarea')?.value ?? n.innerText).trim())), 'invoice colored:', await win.locator('.react-flow__node[data-id="shop.invoice"]').evaluate((n) => /series-4/.test(n.innerHTML)))
  console.log('group box:', await win.getByTestId('diagram-box').count(), JSON.stringify(await win.getByTestId('diagram-box').first().innerText()))
  if (process.argv[2]) await win.screenshot({ path: join(process.argv[2], 'flow91-open.png') })
  console.log('dez dbml:', text.includes('Table shop.customer'), text.includes('Ref customer_invoice: shop.invoice.customer_id > shop.customer.id [delete: cascade]'), 'czech note:', text.includes('Zákazník, který platí řádně'))
  console.log('dez layout kept:', JSON.stringify(pos['shop.customer']), JSON.stringify(pos['shop.invoice']), JSON.stringify(pos['shop.payment']))
  console.log('toast:', await win.getByText(/Opened a DeZign for Databases model: 3 tables/).count(), await win.getByText(/Views, sequences, procedures and triggers of the project \(1\) go into the SQL DDL/).count(), 'title:', await win.getByText('shop.dez', { exact: true }).count())
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

  // Diagrams are managed here too: a table joins Billing, another leaves it, and a new diagram is made.
  const nodes = async () => (await win.locator('.react-flow__node:not([data-id^="note:"])').evaluateAll((list) => list.map((n) => n.getAttribute('data-id')))).sort().join(',')
  await win.getByTestId('model-area').selectOption({ label: 'Billing (2)' })
  await win.waitForTimeout(1200)
  await win.getByPlaceholder('Add table…').fill('customer')
  await win.getByPlaceholder('Add table…').press('Enter')
  await win.waitForTimeout(1200)
  const joined = await nodes()
  await win.locator('.react-flow__node[data-id="shop.payment"]').click({ button: 'right' })
  await win.getByText('Remove from diagram').click()
  await win.waitForTimeout(1200)
  console.log('billing after adding and removing a table:', joined, '→', await nodes())
  await win.getByTestId('model-area').selectOption('+')
  await win.getByPlaceholder('Name of the diagram').fill('Customers')
  await win.getByRole('button', { name: 'Create', exact: true }).click()
  await win.waitForTimeout(1000)
  await win.getByPlaceholder('Add table…').fill('customer')
  await win.getByPlaceholder('Add table…').press('Enter')
  await win.waitForTimeout(1200)
  console.log('new diagram:', await win.getByTestId('model-area').locator('option:checked').innerText(), '|', await nodes())
  await win.getByTestId('model-area').selectOption({ label: 'Whole model' })
  await win.waitForTimeout(1200)

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
  console.log('confirm lists:', /renamed column: customer \(name → full_name\)/.test(listed), /new column: customer \(vat_id\)/.test(listed), 'no draft warning:', !/not been checked in DeZign/.test(listed))
  console.log('confirm lists diagrams:', /new diagram: Customers/.test(listed), /added to diagram: customer \(Billing\)/.test(listed), /taken off diagram: payment \(Billing\)/.test(listed), /added to diagram: customer \(Customers\)/.test(listed))
  await win.getByRole('button', { name: 'Write to the DeZign file' }).click()
  await win.getByText(/Saved to shop\.dez/).waitFor({ timeout: 10000 })
  const after = readFileSync(dez, 'latin1')
  const beforeLines = new Set(before.toString('latin1').split('\n'))
  const changed = after.split('\n').filter((l) => !beforeLines.has(l))
  console.log('written:', after.includes('<NAME>full_name</NAME>'), after.includes('<NAME>vat_id</NAME>'), after.includes('<DESC>DI\xc8 pl\xe1tce</DESC>'), 'kept:', after.includes('<VIEW>'), after.includes('<PROJECTNAME /></PROJECTNAME />'), 'changed lines:', changed.length)
  console.log('diagrams in the file:', (after.match(/<DIAGRAM>/g) ?? []).length, after.includes('<NAME>Customers</NAME>'), 'billing shows', (after.match(/<ENTC>\n<ID>\d+<\/ID>\n<DIAGRAMID>2<\/DIAGRAMID>/g) ?? []).length, 'tables')
  const backupRoot = join(dir, 'data', 'dezign-backups')
  const backups = readdirSync(backupRoot)
  console.log('backup:', backups.length, readFileSync(join(backupRoot, backups[0], 'shop.dez')).equals(before))
  // Saving again right away: nothing to do, and the file is not touched.
  await win.getByRole('button', { name: 'Save', exact: true }).click()
  await win.getByText(/Nothing to save/).last().waitFor({ timeout: 10000 })
  console.log('second save untouched:', readFileSync(dez, 'latin1') === after)

  // A diagram's own display (as DeZign's Diagram → Entity display options), its name, and a diagram taken out.
  await win.getByTestId('model-area').selectOption({ label: 'Billing (2)' })
  await win.waitForTimeout(1200)
  await win.locator('[data-testid="diagram-view"]:visible').click()
  await win.getByRole('menuitemcheckbox', { name: 'Primary keys' }).click()
  await win.locator('[data-testid="diagram-view"]:visible').click()
  await win.getByRole('menuitemcheckbox', { name: 'Column types' }).click()
  await win.waitForTimeout(800)
  const rows = await win.locator('.react-flow__node[data-id="shop.invoice"] .border-t').count()
  console.log('billing shows primary keys only:', rows === 1, 'no types:', (await win.locator('.react-flow__node[data-id="shop.invoice"]').innerText()).includes('bigint') === false)
  // Edited on a diagram that shows part of the model: the rest stays once, and payment (not on this diagram)
  // follows the renamed invoice and its renamed key.
  const tablesBefore = (await win.locator('.cm-content:visible').first().innerText()).match(/Table /g)?.length
  await win.locator('.react-flow__node[data-id="shop.invoice"]').locator('[data-testid="node-name-invoice"]').dblclick()
  await win.getByTestId('inline-edit').fill('bill')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(900)
  const onDiagram = await win.locator('.cm-content:visible').first().innerText()
  console.log('edited on a diagram:', (onDiagram.match(/Table /g)?.length ?? 0) === tablesBefore, /Table (shop\.)?bill /.test(onDiagram), !/Table (shop\.)?invoice /.test(onDiagram), 'hidden table follows:', /payment\.invoice_id > (shop\.)?bill\./.test(onDiagram.replace(/"/g, '')) || /> (shop\.)?bill\.id/.test(onDiagram.replace(/"/g, '')))
  await win.keyboard.press('Escape')
  await win.locator('.react-flow__node[data-id="shop.bill"]').click({ position: { x: 180, y: 12 } })
  await win.keyboard.press('Meta+z')
  await win.waitForTimeout(900)
  console.log('and back:', /Table (shop\.)?invoice /.test(await win.locator('.cm-content:visible').first().innerText()))
  await win.getByTestId('model-area').selectOption('~rename')
  await win.getByRole('textbox').last().fill('Fakturace')
  await win.getByRole('button', { name: 'Rename', exact: true }).click()
  await win.waitForTimeout(600)
  await win.getByTestId('model-area').selectOption({ label: 'Customers (1)' })
  await win.waitForTimeout(800)
  await win.getByTestId('model-area').selectOption('~remove')
  await win.getByRole('button', { name: 'Remove', exact: true }).click()
  await win.waitForTimeout(600)
  await win.getByRole('button', { name: 'Save', exact: true }).click()
  await win.getByText(/Write these changes into shop\.dez\?/).waitFor({ timeout: 10000 })
  const listed2 = await win.locator('[role="dialog"], .fixed').filter({ hasText: 'Write these changes' }).last().innerText()
  console.log('confirm lists display, rename, removal:', /what the tables show: Fakturace/.test(listed2), /renamed diagram: Fakturace \(Billing\)/.test(listed2), /removed diagram: Customers/.test(listed2))
  await win.getByRole('button', { name: 'Write to the DeZign file' }).click()
  await win.getByText(/Saved to shop\.dez/).last().waitFor({ timeout: 10000 })
  const third = readFileSync(dez, 'latin1')
  const billing = /<DIAGRAM>\n<ID>2<\/ID>[\s\S]*?<\/DIAGRAM>/.exec(third)?.[0] ?? ''
  console.log('in the file:', /<NAME>Fakturace<\/NAME>/.test(billing), /<DISPLAYLEVEL>2<\/DISPLAYLEVEL>/.test(billing), /<VISIBLEATTR>0<\/VISIBLEATTR>/.test(billing), 'Customers gone:', !third.includes('<NAME>Customers</NAME>'), (third.match(/<DIAGRAM>/g) ?? []).length, 'diagrams')

  // Frames (DeZign's group boxes): a new one, one moved by its caption and renamed; saved into the project.
  await win.getByTestId('model-area').selectOption({ label: 'Whole model' })
  await win.waitForTimeout(1200)
  await win.getByTestId('diagram-add-box').click()
  await win.getByRole('textbox').last().fill('Sklad')
  await win.getByRole('button', { name: 'Add', exact: true }).click()
  await win.waitForTimeout(800)
  const caption = win.locator('[data-testid="diagram-box"] .dbm-box-handle').filter({ hasText: 'Billing' })
  const at = await caption.boundingBox()
  await win.mouse.move(at.x + 20, at.y + at.height / 2)
  await win.mouse.down()
  await win.mouse.move(at.x + 80, at.y + at.height / 2 + 40, { steps: 10 })
  await win.mouse.up()
  await win.waitForTimeout(600)
  await caption.click({ button: 'right' })
  await win.getByText('Rename frame…').click()
  await win.getByRole('textbox').last().fill('Fakturace a platby')
  await win.getByRole('button', { name: 'Rename', exact: true }).click()
  await win.waitForTimeout(600)
  await win.getByRole('button', { name: 'Save', exact: true }).click()
  await win.getByText(/Write these changes into shop\.dez\?/).waitFor({ timeout: 10000 })
  const listed3 = await win.locator('[role="dialog"], .fixed').filter({ hasText: 'Write these changes' }).last().innerText()
  console.log('confirm lists frames:', /new frame: Sklad/.test(listed3), /changed frame: Fakturace a platby/.test(listed3))
  await win.getByRole('button', { name: 'Write to the DeZign file' }).click()
  await win.getByText(/Saved to shop\.dez/).last().waitFor({ timeout: 10000 })
  const fourth = readFileSync(dez, 'latin1')
  const movedBox = /<GROUPBOXC>\n<ID>G1<\/ID>[\s\S]*?<L>(\d+)<\/L>/.exec(fourth)?.[1]
  console.log('frames in the file:', /<OBJECTCAPTION>Sklad<\/OBJECTCAPTION>/.test(fourth), /<OBJECTCAPTION>Fakturace a platby<\/OBJECTCAPTION>/.test(fourth), (fourth.match(/<GROUPBOXC>/g) ?? []).length, 'moved:', movedBox !== undefined && movedBox !== '840')

  // Notes and colors of the diagram are saved too: a recolored table and a new note are listed as changes, and a
  // tab that never loaded the file's notes (an older build) cannot remove them.
  const state = await win.evaluate(async (path) => {
    const file = await window.mastermind.api.openModelFile(path)
    const base = { path, text: file.text, hash: file.imported.hash, positions: file.imported.positions, dryRun: true }
    const full = await window.mastermind.api.saveDezignModel({ ...base, layout: true, notes: [...file.imported.notes, { id: 'n1', text: 'Nová poznámka', x: 10, y: 600 }], colors: { 'shop.customer': 1 } })
    const old = await window.mastermind.api.saveDezignModel({ ...base, notes: [] })
    return { full: full.changes.map((c) => c.kind).sort().join(','), old: old.changes.length }
  }, dez)
  console.log('layout changes:', state.full, '| tab without loaded notes removes nothing:', state.old === 0)

  // What changed since a version archived in the project: the payment table came after "First release".
  await win.locator('[data-testid="model-compare-menu"]:visible').click()
  await win.getByRole('menuitem', { name: /Compare with (version|file)…/ }).click()
  await win.getByText('v1 · First release · 2026-01-15').click()
  await win.getByRole('button', { name: 'Compare', exact: true }).click()
  await win.getByText(/Create table/).first().waitFor({ timeout: 20000 })
  console.log('compare with an archived version:', await win.getByText(/Changes since v1/).count() > 0, 'changes:', await win.getByText(/Create table/).count())

  // The view's SQL edited in the model ("Views…") goes into the project and into the script.
  await win.getByText('shop.dez', { exact: true }).first().click()
  await win.locator('[data-testid="model-more"]:visible').click()
  await win.getByRole('menuitem', { name: 'Views and code…' }).click()
  await win.getByTestId('views-code').fill('CREATE VIEW %viewname% AS\nSELECT id, total FROM shop.invoice WHERE total > 0;')
  await win.getByTestId('views-apply').click()
  await win.getByRole('button', { name: 'Save', exact: true }).click()
  await win.getByText(/Write these changes into shop\.dez\?/).waitFor({ timeout: 10000 })
  const listedView = await win.locator('[role="dialog"], .fixed').filter({ hasText: 'Write these changes' }).last().innerText()
  await win.getByRole('button', { name: 'Write to the DeZign file' }).click()
  await win.getByText(/Saved to shop\.dez/).last().waitFor({ timeout: 10000 })
  console.log('view edited:', /changed view: v_unpaid/.test(listedView), readFileSync(dez, 'latin1').includes('<CODE>CREATE VIEW %viewname% AS\nSELECT id, total FROM shop.invoice WHERE total &gt; 0;</CODE>'))

  // A new trigger of a table and a new sequence (DeZign: the entity's Triggers tab, the Sequences dialog).
  await win.locator('[data-testid="model-more"]:visible').click()
  await win.getByRole('menuitem', { name: 'Views and code…' }).click()
  await win.getByTestId('objects-add-trigger').click()
  await win.getByTestId('objects-name').fill('trg_paid')
  await win.getByTestId('objects-code').fill('CREATE TRIGGER %triggername% AFTER UPDATE ON %table%\nFOR EACH ROW EXECUTE FUNCTION shop.paid();')
  await win.getByTestId('objects-add-sequence').click()
  await win.getByTestId('objects-name').fill('ticket_no')
  await win.getByTestId('objects-start').fill('100')
  await win.getByText('Cycle', { exact: true }).click()
  const sequenceSql = await win.getByTestId('objects-sql').innerText()
  await win.getByTestId('views-apply').click()
  await win.getByRole('button', { name: 'Save', exact: true }).click()
  await win.getByText(/Write these changes into shop\.dez\?/).waitFor({ timeout: 10000 })
  const listedObjects = await win.locator('[role="dialog"], .fixed').filter({ hasText: 'Write these changes' }).last().innerText()
  await win.getByRole('button', { name: 'Write to the DeZign file' }).click()
  await win.getByText(/Saved to shop\.dez/).last().waitFor({ timeout: 10000 })
  const withObjects = readFileSync(dez, 'latin1').split('</VERSION>')[0]
  console.log('trigger and sequence added:', /CREATE SEQUENCE \S*ticket_no INCREMENT BY 1 START WITH 100 CYCLE/.test(sequenceSql), /new trigger/.test(listedObjects) && /new sequence/.test(listedObjects), /<TRIGGER>\s*<NAME>trg_paid<\/NAME>/.test(withObjects), /<NAME>ticket_no<\/NAME>[\s\S]*?<SEED>100<\/SEED>[\s\S]*?<CYCLE>cycle<\/CYCLE>/.test(withObjects))

  // The view the project holds as SQL is part of the generated script (PostgreSQL is the project's own database).
  await win.getByRole('button', { name: 'SQL DDL' }).click()
  await win.getByRole('menuitem', { name: /^PostgreSQL( \(|$)/ }).click()
  await win.waitForTimeout(1200)
  const ddlTop = await win.locator('.cm-content:visible').first().innerText()
  // The editor draws only the lines in view: go to the end for the rest.
  await win.locator('.cm-content:visible').first().click()
  await win.keyboard.press('Meta+ArrowDown')
  await win.waitForTimeout(400)
  const ddlEnd = await win.locator('.cm-content:visible').first().innerText()
  console.log('ddl has the tables and the view:', /CREATE TABLE/.test(ddlTop), /CREATE VIEW shop\.v_unpaid AS\s+SELECT id, total FROM shop\.invoice WHERE total > 0/.test(ddlEnd), /from the DeZign project/.test(ddlEnd))

  await pick(join(project, 'Shop.dezproj'))
  await openModel()
  console.log('folder project versions:', JSON.stringify(await win.evaluate((p) => window.mastermind.api.listModelVersions(p), join(project, 'Shop.dezproj'))), (await win.evaluate(async (p) => (await window.mastermind.api.openModelVersion(p, 'old.xml')).text.match(/^Table /gm)?.length, join(project, 'Shop.dezproj'))), 'tables in it')
  const text2 = await win.locator('.cm-content:visible').first().innerText()
  console.log('project tables:', await win.locator('.react-flow__node:visible').count(), 'dbml:', text2.includes('Table shop.payment'), text2.includes('Ref invoice_payment: shop.payment.invoice_id > shop.invoice.id'))
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
    await win.waitForFunction((n) => document.querySelectorAll('.react-flow__node').length > n, before, { timeout: 60000 }).catch(async () => {
      // Numbers only, to see what the window shows instead.
      console.log('local model did not draw:', JSON.stringify(await win.evaluate(() => ({ nodes: document.querySelectorAll('.react-flow__node').length, palette: !!document.querySelector('[cmdk-root]'), openError: /Could not open the model/.test(document.body.innerText), opened: /Opened a DeZign/.test(document.body.innerText), dialog: !!document.querySelector('[role="dialog"]'), tabs: document.querySelectorAll('[role="tab"]').length }))), 'before', before)
      throw new Error('the local model did not draw')
    })
    const shown = Date.now() - started
    const said = await win.evaluate(() => (document.body.innerText.match(/Opened a DeZign for Databases model: \d+/g) ?? []).pop()?.replace(/\D+/, ''))
    console.log('local model: tables', said, '| diagram after', shown, 'ms | tables drawn', (await win.locator('.react-flow__node').count()) - before, '| dbml errors', await win.locator('.text-warning button').count())
    // The object browser and the table dialog on a real model: times and counts only.
    const browser = win.locator('[data-testid="object-browser"]:visible')
    await win.getByRole('button', { name: 'Objects', exact: true }).last().click()
    await browser.waitFor({ timeout: 10000 })
    const listed = await browser.locator('[data-testid^="browser-table-"]').count()
    let t0 = Date.now()
    await browser.getByTestId('browser-search').fill('a')
    const found = await browser.locator('[data-testid^="browser-table-"]').count()
    const searchMs = Date.now() - t0
    await browser.getByTestId('browser-search').fill('')
    t0 = Date.now()
    await browser.locator('[data-testid^="browser-table-"]').nth(Math.floor(listed / 2)).dblclick()
    await win.getByTestId('table-panel').waitFor({ timeout: 20000 })
    const dialogMs = Date.now() - t0
    const rows = await win.locator('[data-testid="table-panel"] [data-testid^="column-name-"]').count()
    const sqlLines = ((await win.getByTestId('table-sql').textContent()) ?? '').split('\n').length
    await win.keyboard.press('Escape')
    console.log('local model browser: tables listed', listed, '| search', searchMs, 'ms,', found, 'found | table dialog', dialogMs, 'ms,', rows, 'columns,', sqlLines, 'lines of SQL')

    // Editing and saving, only on a copy and only when asked (DBM_DEZ_WRITE=1): a column added in a table's dialog,
    // an attribute package put in, Save without "Write to DBML", the file read again. Counts and times only.
    if (process.env.DBM_DEZ_WRITE === '1') {
      const packages = await browser.locator('[data-testid^="browser-package-"]').count()
      await browser.locator('[data-testid^="browser-table-"]').nth(Math.floor(listed / 3)).dblclick()
      await win.getByTestId('table-panel').waitFor({ timeout: 20000 })
      const before = await win.locator('[data-testid="table-panel"] [data-testid^="column-name-"]').count()
      await win.getByTestId('table-add-column').click()
      await win.locator('[data-testid="table-panel"] [data-testid^="column-name-"]').last().fill('dbm_e2e_note')
      let packaged = 0
      if (packages) {
        const offered = await win.getByTestId('table-add-package').locator('option:not([disabled])').evaluateAll((o) => o.map((x) => x.value).filter(Boolean))
        if (offered.length) {
          await win.getByTestId('table-add-package').selectOption(offered[0])
          packaged = (await win.locator('[data-testid="table-panel"] [data-testid^="column-name-"]').count()) - before - 1
        }
      }
      await win.keyboard.press('Escape')
      t0 = Date.now()
      await win.getByRole('button', { name: 'Save', exact: true }).click()
      await win.getByText(/Write these changes into/).waitFor({ timeout: 120000 })
      const previewMs = Date.now() - t0
      const listedChanges = (await win.locator('[role="dialog"]').last().innerText()).split('\n').filter((l) => /^(added|changed|renamed|dropped|new|removed)/i.test(l.trim())).length
      t0 = Date.now()
      await win.getByRole('button', { name: 'Write to the DeZign file' }).click()
      await win.getByText(/Saved to /).last().waitFor({ timeout: 120000 })
      const writeMs = Date.now() - t0
      const again = await win.evaluate(async (p) => (await window.mastermind.api.openModelFile(p)).text, process.env.DBM_DEZ_FILE)
      console.log('local model saved: packages', packages, '| package columns put in', packaged, '| save preview', previewMs, 'ms | listed', listedChanges, '| write', writeMs, 'ms | read back with the column', /dbm_e2e_note/.test(again), '| package columns in the file', (again.match(/package: '/g) ?? []).length)
    }
  }
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
} finally {
  await app.close()
}

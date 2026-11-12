// A DeZign model edited in the table panel with no database connected: a column's comment, a new column with a
// check, the order of columns, a named index. Written into the model and saved back into the DeZign file.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'dbm-ui96-'))
const el = (tag, body) => `<${tag}>\n${body}\n</${tag}>`
const attr = (id, name, type, extra = '') => el('ATTR', `<NAME>${name}</NAME>\n<ID>${id}</ID>\n<DESC></DESC>\n<DOMAINID></DOMAINID>\n<DT>\n<DTLISTNAME>${type}</DTLISTNAME>\n<SD>1</SD>\n<INC>1</INC>\n</DT>${extra ? `\n${extra}` : ''}`)
const ent = (id, name, pk, attrs) => el('ENT', `<NAME>${name}</NAME>\n<ID>${id}</ID>\n<SCHEMA>shop</SCHEMA>\n<DESC></DESC>\n<PKCON>\n<ATTRIBUTEIDS>\n<ATTRIBUTEID>${pk}</ATTRIBUTEID>\n</ATTRIBUTEIDS>\n</PKCON>\n<ATTRIBUTES>\n${attrs.join('\n')}\n</ATTRIBUTES>`)
const entc = (id, l, t) => el('ENTC', `<ID>${id}</ID>\n<DIAGRAMID>1</DIAGRAMID>\n<W>240</W>\n<H>100</H>\n<L>${l}</L>\n<T>${t}</T>\n<BRUSH>0,16119285</BRUSH>`)
const settings = el('PROJECTSETTINGS', el('COMMONSETTINGS', '<PROJECTNAME></PROJECTNAME>\n<BEGINDATABASESCRIPT>SET search_path = shop;</BEGINDATABASESCRIPT>\n<ENDDATABASESCRIPT>ANALYZE;</ENDDATABASESCRIPT>\n<FILEFORMATVERSION>140</FILEFORMATVERSION>'))
const entities = [ent('10', 'customer', 'A1', [attr('A1', 'id', 'BIGINT'), attr('A2', 'name', 'TEXT'), attr('A3', 'email', 'TEXT')]), ent('20', 'invoice', 'B1', [attr('B1', 'id', 'BIGINT'), attr('B2', 'total', 'NUMERIC')])]
const dez = join(dir, 'shop.dez')
writeFileSync(dez, `<?xml version="1.0" encoding="iso-8859-1"?><dezign>\n<VERSION>\n${settings}\n<DATADICT>\n<DBID>postgresql16</DBID>\n<DOMAINS>\n</DOMAINS>\n<ENTITIES>\n${entities.join('\n')}\n</ENTITIES>\n<RELATIONSHIPS>\n</RELATIONSHIPS>\n</DATADICT>\n<DIAGRAMS>\n${el('DIAGRAM', '<ID>1</ID>\n<NAME>Main</NAME>\n<ISMAINDIAGRAM>1</ISMAINDIAGRAM>')}\n<CONTROLS>\n<ENTITYCONTROLS>\n${[entc('10', 0, 0), entc('20', 600, 0)].join('\n')}\n</ENTITYCONTROLS>\n</CONTROLS>\n</DIAGRAMS>\n</VERSION>\n</dezign>\n`, 'latin1')

const sql = join(dir, 'model.sql')
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' } })
await app.evaluate(({ dialog }, [file, sql]) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); dialog.showSaveDialog = async () => ({ canceled: false, filePath: sql }) }, [dez, sql])
const win = await app.firstWindow()
try {
  await win.waitForTimeout(1500)
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('Open model')
  await win.keyboard.press('Enter')
  await win.locator('.react-flow__node[data-id="shop.customer"]').waitFor({ timeout: 20000 })
  console.log('opened without a connection:', await win.locator('.react-flow__node').count(), 'tables')

  await win.getByRole('button', { name: 'Design', exact: true }).click()
  await win.waitForTimeout(500)
  // Dragging from a table's own dot to another table makes the key column and the foreign key, as DeZign does.
  const dot = await win.locator('.react-flow__node[data-id="shop.invoice"] .react-flow__handle[data-handleid="s-*"]').boundingBox()
  const key = await win.locator('.react-flow__node[data-id="shop.customer"]').boundingBox()
  await win.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2)
  await win.mouse.down()
  await win.mouse.move(key.x + key.width / 2 + 40, key.y + key.height / 2, { steps: 12 })
  await win.mouse.move(key.x + key.width / 2, key.y + key.height / 2 + 10, { steps: 6 })
  await win.mouse.up()
  await win.waitForTimeout(600)
  console.log('a key dropped anywhere on the other table:', await win.locator('.react-flow__edge').count(), 'relationship,', await win.getByText(/Foreign key invoice\.customer_id → customer\.id added/).count(), 'notice')
  await win.locator('.react-flow__node[data-id="shop.customer"]').click()
  await win.getByText('Edit table').waitFor({ timeout: 10000 })
  console.log('table panel opens:', await win.getByText('Edit table').count() === 1)
  await win.getByTestId('column-comment-email').fill('Přihlašovací e-mail')
  // email goes before name
  await win.getByRole('button', { name: 'Move up' }).nth(2).click()
  await win.getByRole('button', { name: 'Add', exact: true }).nth(0).click()
  await win.locator('input[value="column_4"]').fill('credit')
  await win.getByRole('button', { name: 'Add', exact: true }).nth(3).click()
  await win.getByPlaceholder('Name (optional)').last().fill('credit_not_negative')
  await win.getByTestId('check-condition-0').fill('credit >= 0')
  await win.getByRole('button', { name: 'Add', exact: true }).nth(2).click()
  await win.getByPlaceholder('Name (optional)').nth(0).fill('customer_by_email')
  await win.locator('input[title="Columns, comma separated"]').fill('email')
  if (process.argv[2]) await win.screenshot({ path: join(process.argv[2], 'flow96-panel.png') })
  await win.getByRole('button', { name: /Write to DBML/ }).click()
  await win.waitForTimeout(1200)
  const text = await win.locator('.cm-content:visible').first().innerText()
  console.log('model text:', /email text \[note: 'Přihlašovací e-mail'\]/.test(text), text.indexOf('email text') < text.indexOf('name text'), /credit_not_negative/.test(text), /customer_by_email/.test(text))
  console.log('relationship drawn table to table:', /customer_id bigint/.test(text), /Ref: shop\.invoice\.customer_id > shop\.customer\.id/.test(text))

  await win.getByRole('button', { name: 'Save', exact: true }).click()
  await win.getByText(/Write these changes into shop\.dez\?/).waitFor({ timeout: 10000 })
  await win.getByRole('button', { name: 'Write to the DeZign file' }).click()
  await win.getByText(/Saved to shop\.dez/).waitFor({ timeout: 10000 })
  const saved = readFileSync(dez, 'latin1')
  const names = [...saved.matchAll(/<ATTR>\n<NAME>([^<]*)/g)].map((m) => m[1]).slice(0, 4).join(',')
  console.log('in the DeZign file:', names, /<DESC>P\xf8ihla\xb9ovac\xed e-mail<\/DESC>|<DESC>P.ihla.ovac. e-mail<\/DESC>/.test(saved), /<NAME>credit_not_negative<\/NAME>/.test(saved), /<VALUE>credit &gt;= 0<\/VALUE>/.test(saved), /<NAME>customer_by_email<\/NAME>/.test(saved))

  // A version of the project, as DeZign archives one: listed in the file, and a later save still works.
  await win.getByTestId('model-archive-version').click()
  await win.getByRole('button', { name: 'Archive', exact: true }).click()
  await win.getByText('Archived as version 1').waitFor({ timeout: 10000 })
  const versions = await win.evaluate((path) => window.mastermind.api.listModelVersions(path), dez)
  const archived = readFileSync(dez, 'latin1')
  console.log('archived version:', JSON.stringify(versions.map((v) => [v.number, v.label.startsWith('Version ')])), (archived.match(/<VERSION>/g) ?? []).length === 2, /<\/VERSION><VERSION>\n<VERSIONINFO>\n<VERSIONID>[0-9A-F-]{36}<\/VERSIONID>/.test(archived))

  // A column hidden in one table's box on this diagram (DeZign's Show/hide attributes), saved into the project.
  await win.locator('.react-flow__node[data-id="shop.customer"]').click({ button: 'right' })
  await win.getByText('Columns shown').hover()
  await win.getByText('name', { exact: true }).last().click()
  await win.waitForTimeout(600)
  const boxRows = await win.locator('.react-flow__node[data-id="shop.customer"] .border-t').count()
  await win.getByRole('button', { name: 'Save', exact: true }).click()
  await win.getByText(/Write these changes into shop\.dez\?/).waitFor({ timeout: 10000 })
  await win.getByRole('button', { name: 'Write to the DeZign file' }).click()
  await win.getByText(/Saved to shop\.dez/).last().waitFor({ timeout: 10000 })
  console.log('hidden column:', boxRows === 3, /<HIDDENATTR>A2<\/HIDDENATTR>/.test(readFileSync(dez, 'latin1')))

  // Domains: a new one, followed by a column, then a new type for it that goes to that column too.
  const domainsDialog = async (fill) => {
    await win.getByTestId('model-domains').click()
    await fill()
    await win.getByTestId('domain-apply').click()
    await win.waitForTimeout(800)
  }
  await domainsDialog(async () => {
    await win.getByTestId('domain-add').click()
    await win.getByTestId('domain-name-0').fill('money_t')
    await win.getByTestId('domain-type-0').fill('numeric(12,2)')
  })
  await win.getByRole('button', { name: /Design/ }).first().click()
  await win.locator('.react-flow__node[data-id="shop.customer"]').click()
  await win.getByTitle('The named type (domain) the column follows').last().selectOption('money_t')
  await win.getByRole('button', { name: /Write to DBML/ }).click()
  await win.waitForTimeout(800)
  await domainsDialog(async () => win.getByTestId('domain-type-0').fill('numeric(14,2)'))
  const withDomain = await win.locator('.cm-content:visible').first().innerText()
  await win.getByRole('button', { name: 'Save', exact: true }).click()
  await win.getByText(/Write these changes into shop\.dez\?/).waitFor({ timeout: 10000 })
  await win.getByRole('button', { name: 'Write to the DeZign file' }).click()
  await win.getByText(/Saved to shop\.dez/).last().waitFor({ timeout: 10000 })
  const domainFile = readFileSync(dez, 'latin1')
  console.log('domains:', /credit numeric\(14,2\) \[domain: 'money_t'\]/.test(withDomain), /money_t: numeric\(14,2\)/.test(withDomain), /<DOMAIN>\n<NAME>money_t<\/NAME>[\s\S]*?<DTLISTNAME>NUMERIC<\/DTLISTNAME>\n<LE>14<\/LE>\n<PR>2<\/PR>/.test(domainFile))

  // The project's begin and end scripts go around the DDL made for its own database.
  await win.getByRole('button', { name: /^SQL DDL/ }).click()
  await win.getByText('PostgreSQL', { exact: true }).last().click()
  await win.getByText('Script saved').waitFor({ timeout: 10000 })
  const script = readFileSync(sql, 'utf8')
  console.log('ddl with the project scripts:', script.includes('SET search_path = shop;'), script.trimEnd().endsWith('ANALYZE;'), script.indexOf('SET search_path') < script.indexOf('CREATE TABLE'), /COMMENT ON COLUMN/.test(script))
  // The DROP script DeZign writes next to it: children before the tables they point at.
  await win.getByRole('button', { name: /^SQL DDL/ }).click()
  await win.getByText('DROP script…').click()
  await win.getByText('Script saved').last().waitFor({ timeout: 10000 })
  const drop = readFileSync(sql, 'utf8')
  console.log('drop script:', drop.indexOf('DROP TABLE "shop"."invoice"') > -1 && drop.indexOf('DROP TABLE "shop"."invoice"') < drop.indexOf('DROP TABLE "shop"."customer"'), !/CREATE/.test(drop))
  if (process.argv[2]) await win.screenshot({ path: join(process.argv[2], 'flow96.png') })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  if (process.argv[2]) await win.screenshot({ path: join(process.argv[2], 'flow96-error.png') })
} finally {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
}

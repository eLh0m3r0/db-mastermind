// A model without a connection: the app is started with a model file (as a double-click in the system does),
// generates DDL to a file, and is linked to a database only when the ALTER script is wanted.
import { _electron as electron } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'dbm-ui92-'))
const model = join(dir, 'shop.dbml')
writeFileSync(model, 'Table dbm_clients {\n  id int [pk]\n  name varchar(80) [not null]\n}\nTable dbm_deals {\n  id int [pk]\n  client_id int [ref: > dbm_clients.id]\n}\nTable dbm_notes {\n  id int [pk]\n  dbm_client_id int\n}\n')
const sql = join(dir, 'out.sql')
const env = { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' }
const app = await electron.launch({ args: ['apps/desktop', model], env })
await app.evaluate(({ dialog }, sql) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: sql }) }, sql)
const win = await app.firstWindow()
try {
  await win.locator('.react-flow__node').first().waitFor({ timeout: 20000 })
  console.log('opened from the command line:', await win.locator('.react-flow__node').count(), 'tables, title:', await win.getByText('shop.dbml', { exact: true }).count() > 0)
  const picker = win.getByTestId('model-database')
  console.log('no database:', await picker.inputValue() === '', 'compare disabled:', await win.getByRole('button', { name: 'Compare with database' }).isDisabled())

  // Checks run by themselves: the relationship has no index, and client_ref looks like a reference nobody declared.
  await win.getByTestId('model-issues').click()
  const panel = win.getByTestId('model-issues-panel')
  console.log('checks:', (await win.getByTestId('model-issues').innerText()).trim(), '|', (await panel.innerText()).replace(/\s+/g, ' ').slice(0, 160))
  await panel.getByText('Possible relationship').click()
  await panel.getByRole('button', { name: 'Add', exact: true }).click()
  await win.waitForTimeout(700)
  await panel.getByRole('button', { name: 'Add index all' }).click()
  await win.waitForTimeout(900)
  const fixed = await win.locator('.cm-content:visible').first().innerText()
  console.log('fixed:', /Ref: dbm_notes\.dbm_client_id > dbm_clients\.id/.test(fixed), (fixed.match(/name: 'ix_/g) ?? []).length, 'indexes added, chip gone:', await win.getByTestId('model-issues').count() === 0)

  // DDL without a database goes to a file.
  await win.getByRole('button', { name: 'SQL DDL' }).click()
  await win.getByText('PostgreSQL', { exact: true }).first().click()
  await win.getByText('Script saved').waitFor({ timeout: 10000 })
  const script = existsSync(sql) ? readFileSync(sql, 'utf8') : ''
  console.log('ddl file:', /CREATE TABLE/i.test(script), /dbm_clients/.test(script), /REFERENCES/i.test(script))

  // Link a database when the ALTER script is wanted: the demo database has neither table.
  await win.evaluate(() => window.mastermind.api.createSampleDatabase())
  // Tabs are saved a moment after they change.
  await win.waitForTimeout(800)
  await win.reload()
  // The tab was saved with the workspace and comes back, still without a database.
  await win.locator('.react-flow__node').first().waitFor({ timeout: 20000 })
  console.log('restored after restart:', await win.getByText('shop.dbml', { exact: true }).count() > 0)
  const options = await win.getByTestId('model-database').locator('option').allInnerTexts()
  console.log('picker offers:', options.join(' | '))
  await win.getByTestId('model-database').selectOption({ label: options.find((o) => /coffee/i.test(o)) })
  const compare = win.getByRole('button', { name: /Compare with Demo coffee shop/ })
  await compare.waitFor({ timeout: 10000 })
  await compare.click()
  await win.getByRole('button', { name: 'Compare', exact: true }).click()
  await win.getByText(/Create table/).first().waitFor({ timeout: 20000 })
  console.log('compare with the linked database:', await win.getByText(/Create table/).count() >= 2)
  console.log('remembered:', await win.evaluate((model) => JSON.parse(localStorage.getItem('dbm.modelDatabase') ?? '{}')[model] !== undefined, model))
  if (process.argv[2]) await win.screenshot({ path: join(process.argv[2], 'flow92.png') })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
} finally {
  await app.close()
}

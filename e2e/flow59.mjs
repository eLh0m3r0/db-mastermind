// Model subject areas: show one TableGroup, add a table there, the rest of the model stays.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui59-'))
const file = join(dir, 'm.dbml')
writeFileSync(file, `Table customers {\n  id int [pk]\n}\nTable orders {\n  id int [pk]\n  customer_id int [ref: > customers.id]\n}\nTable products {\n  id int [pk]\n}\nTable stock {\n  product_id int [ref: > products.id]\n}\nTableGroup Sales {\n  customers\n  orders\n}\nTableGroup Warehouse {\n  products\n  stock\n}\n`)
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, file)
const win = await app.firstWindow()
try {
  await win.waitForTimeout(800)
  await win.evaluate(() => window.mastermind.api.createSampleDatabase())
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Demo coffee shop/ }).first().click()
  await win.waitForTimeout(1500)
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('Open model')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(2000)
  console.log('all:', await win.locator('.react-flow__node').count())
  await win.locator('select').filter({ hasText: 'All areas' }).selectOption('Warehouse')
  await win.waitForTimeout(1500)
  console.log('Warehouse:', await win.locator('.react-flow__node').count(), (await win.locator('.react-flow__node').allInnerTexts()).map((t) => t.split('\n')[0]).join(','))
  await win.getByRole('button', { name: 'Design', exact: true }).click()
  await win.getByRole('button', { name: 'New table', exact: true }).first().click()
  await win.waitForTimeout(400)
  await win.getByRole('button', { name: /Write to DBML/ }).click()
  await win.waitForTimeout(800)
  const text = await win.locator('.cm-content:visible').first().innerText()
  console.log('kept others:', text.includes('Table customers'), text.includes('Table orders'), 'new in Warehouse:', /TableGroup Warehouse \{[^}]*new_table_1/.test(text))
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
} finally {
  await app.close()
}

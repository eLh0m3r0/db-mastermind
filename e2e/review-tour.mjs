// Screenshot tour of the main screens for a review (synthetic models only): node e2e/review-tour.mjs <out> [en|cs]
import { _electron as electron } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2]
const lang = process.argv[3] ?? 'en'
const dir = mkdtempSync(join(tmpdir(), 'dbm-tour-'))
const dbml = join(dir, 'shop.dbml')
writeFileSync(
  dbml,
  `Table sales.customer {
  id bigint [pk, increment]
  email varchar(200) [not null, unique]
  name varchar(100) [not null]
  created_at timestamp [not null, default: \`now()\`]
  Note: 'People who buy'
}

Table sales.invoice {
  id bigint [pk, increment]
  customer_id bigint [not null, ref: > sales.customer.id]
  issued_on date [not null]
  total numeric(12,2) [not null]
  status varchar(20) [not null, default: 'draft']
}

Table sales.invoice_line {
  invoice_id bigint [pk, ref: > sales.invoice.id]
  line_no int [pk]
  product_id bigint [not null, ref: > catalog.product.id]
  quantity int [not null]
  price numeric(12,2) [not null]
}

Table catalog.product {
  id bigint [pk, increment]
  code varchar(30) [not null, unique]
  name varchar(200) [not null]
  category_id int [ref: > catalog.category.id]
}

Table catalog.category {
  id int [pk]
  name varchar(100) [not null]
  parent_id int [ref: > catalog.category.id]
}

TableGroup Sales {
  sales.customer
  sales.invoice
  sales.invoice_line
}
`,
)
const dez = join(dir, 'shop.dez')
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: lang, DBM_E2E_BACKGROUND: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const size = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h])
let n = 0
const shot = async (name) => {
  await win.waitForTimeout(500)
  await win.screenshot({ path: join(out, `${String(++n).padStart(2, '0')}-${name}.png`) })
}
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const stubOpen = (file) => app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, file)
const stubSave = (file) => app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, file)
try {
  await size(1440, 900)
  await win.waitForTimeout(800)
  await shot('home-empty')
  await api('createSampleDatabase')
  await win.reload()
  await win.waitForTimeout(1200)
  await shot('home-with-connection')
  await size(1280, 720)
  await shot('home-laptop-1280x720')
  await size(1440, 900)

  // Database side
  await win.getByRole('button', { name: /Demo coffee shop/ }).first().click()
  await win.waitForTimeout(2000)
  await shot('database-opened')

  // A model from a file
  await stubOpen(dbml)
  await win.keyboard.press('Meta+o')
  await win.locator('.react-flow__node').first().waitFor({ timeout: 15000 })
  await win.waitForTimeout(1200)
  await shot('model-opened')
  await win.locator('.react-flow__node[data-id="sales.invoice"]').dblclick({ position: { x: 180, y: 12 } })
  await win.getByTestId('table-panel').waitFor({ timeout: 10000 })
  await shot('model-table-panel-docked')
  await win.getByTestId('table-panel').locator('[data-testid^="column-name-"]').nth(2).click()
  await shot('model-table-panel-column-open')
  await size(1280, 800)
  await shot('model-panel-1280')
  await size(1024, 720)
  await shot('model-panel-narrow-drawer')
  await win.keyboard.press('Escape')
  await shot('model-narrow-no-panel')
  await size(1440, 900)
  await win.locator('.react-flow__node[data-id="sales.customer"]').click({ position: { x: 180, y: 12 } })
  await shot('model-table-selected-inline-controls')
  await win.getByTestId('node-name-customer').dblclick()
  await shot('model-inline-rename')
  await win.keyboard.press('Escape')
  await win.locator('[data-testid="model-import"]:visible').click()
  await shot('model-import-menu')
  await win.keyboard.press('Escape')
  await win.locator('[data-testid="model-more"]:visible').click()
  await shot('model-more-menu')
  await win.keyboard.press('Escape')
  await win.locator('[data-testid="model-compare-menu"]:visible').click()
  await shot('model-compare-menu')
  await win.keyboard.press('Escape')
  await win.getByRole('button', { name: 'SQL DDL' }).last().click()
  await shot('model-sql-ddl-menu')
  await win.keyboard.press('Escape')
  const edge = win.locator('[data-testid^="rf__edge-sales.invoice:"]').first()
  await edge.dispatchEvent('dblclick')
  await win.waitForTimeout(600)
  await shot('model-relationship-panel')
  await win.keyboard.press('Escape')

  // As a DeZign project, opened again
  await stubSave(dez)
  await win.locator('[data-testid="model-save-as"]:visible').click()
  await win.waitForTimeout(2500)
  await stubOpen(dez)
  await win.locator('[data-testid="model-open"]:visible').click()
  await win.waitForTimeout(3000)
  await shot('dezign-project-opened')
  await win.locator('[data-testid="model-more"]:visible').click()
  await win.getByRole('menuitem', { name: 'DeZign project' }).click()
  await shot('dezign-more-submenu')
  await win.keyboard.press('Escape')
  await win.keyboard.press('Escape')

  // New model from scratch
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('New model')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(1500)
  await shot('new-model-empty')
} catch (err) {
  console.log('TOUR ERROR', err.message.split('\n')[0])
  await shot('error')
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

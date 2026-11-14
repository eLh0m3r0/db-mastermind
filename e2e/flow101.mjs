// Definitions of database objects (Milestone 11, A1): a click on a function in the explorer opens its definition
// in a query tab; edited and run, it changes the function; clicking it again comes back to the same tab; a view's
// and a table's "Definition (SQL)" come from their context menus. Needs `npm run db:up` (postgres) and the shop
// fixtures (the definitions integration test seeds them).
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'

const out = process.argv[2] ?? tmpdir()
const admin = new pg.Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' })
await admin.connect()
await admin.query(`CREATE OR REPLACE FUNCTION shop.add_one(x int) RETURNS int LANGUAGE sql AS $$ SELECT x + 1 $$`)
await admin.query(`CREATE OR REPLACE VIEW shop.vip_customers AS SELECT * FROM shop.customers WHERE vip`)

const dir = mkdtempSync(join(tmpdir(), 'dbm-ui101-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const check = (label, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) process.exitCode = 1
}
const editorText = () => win.locator('.cm-content:visible').first().innerText()
const tabCount = () => win.getByRole('tab').count()
try {
  await win.waitForTimeout(800)
  await api('saveConnection', { id: '', name: 'Defs PG', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' })
  await win.reload()
  await win.getByText('Defs PG', { exact: true }).first().dblclick()
  await win.locator('[data-sidebar-filter]').waitFor({ timeout: 15000 })
  await win.locator('[data-sidebar-filter]').fill('add_one')
  const routine = win.locator('[data-routine="add_one"]').first()
  await routine.waitFor({ timeout: 10000 })
  await routine.click()
  await win.waitForTimeout(1200)
  const text = await editorText()
  check('a click on the function opens its definition', /CREATE OR REPLACE FUNCTION shop\.add_one/.test(text))
  check('the tab is named after the function', (await win.getByRole('tab').filter({ hasText: 'add_one' }).count()) === 1)
  await win.screenshot({ path: `${out}/r101-function.png` })

  // Edit the body and run it: the function changes.
  const editor = win.locator('.cm-content:visible').first()
  await editor.click()
  await win.keyboard.press('ControlOrMeta+a')
  await win.keyboard.insertText(text.replace('x + 1', 'x + 2'))
  await win.keyboard.press('ControlOrMeta+Shift+Enter')
  await win.waitForTimeout(1500)
  const { rows } = await admin.query('SELECT shop.add_one(1) AS v')
  check('running the edited definition changes the function', rows[0].v === 3)

  const before = await tabCount()
  await routine.click()
  await win.waitForTimeout(600)
  check('clicking the function again returns to its tab (no new tab)', (await tabCount()) === before)

  // A view from its context menu.
  await win.locator('[data-sidebar-filter]').fill('vip_customers')
  await win.getByText('vip_customers', { exact: true }).first().click({ button: 'right' })
  await win.getByText('Definition (SQL)', { exact: true }).click()
  await win.waitForTimeout(1200)
  check('a view’s definition opens as CREATE OR REPLACE VIEW', /CREATE OR REPLACE VIEW "?shop"?\."?vip_customers"? AS/.test(await editorText()))

  // A table: the generated CREATE statement.
  await win.locator('[data-sidebar-filter]').fill('orders')
  await win.getByText('orders', { exact: true }).first().click({ button: 'right' })
  await win.getByText('Definition (SQL)', { exact: true }).click()
  await win.waitForTimeout(1200)
  const tableSql = await editorText()
  check('a table’s definition is its generated CREATE TABLE', /Generated from the catalog/.test(tableSql) && /CREATE TABLE "?shop"?\."?orders"?/.test(tableSql))
  await win.screenshot({ path: `${out}/r101-table.png` })
  check('no page errors', errors.length === 0)
  if (errors.length) console.log(errors)
} catch (err) {
  console.log('FAIL', err)
  await win.screenshot({ path: `${out}/r101-failure.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await admin.query(`CREATE OR REPLACE FUNCTION shop.add_one(x int) RETURNS int LANGUAGE sql AS $$ SELECT x + 1 $$`).catch(() => {})
  await admin.end()
  await app.close()
}

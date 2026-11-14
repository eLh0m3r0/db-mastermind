// The data grid of Milestone 11 (B): totals of the selected cells; a column's profile, whose common value filters
// the grid; a cell set to an SQL expression (saved as the expression, a second statement refused); and Find value
// over all tables, whose hit opens the table filtered to it. Needs `npm run db:up` (postgres) and the shop fixtures
// (seeded by the integration tests); restores what it changes.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'

const out = process.argv[2] ?? tmpdir()
const admin = new pg.Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' })
await admin.connect()
// The rows this flow looks for, whatever other tests left behind.
await admin.query(`UPDATE shop.customers SET name = 'Bob' WHERE email = 'bob@example.com'`)
await admin.query(`UPDATE shop.orders SET total = 10.50 WHERE id = 1`)
const bobBefore = (await admin.query(`SELECT name FROM shop.customers WHERE email = 'bob@example.com'`)).rows[0]?.name

const dir = mkdtempSync(join(tmpdir(), 'dbm-ui103-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const check = (label, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) process.exitCode = 1
}
const openTable = async (name) => {
  await win.locator('[data-sidebar-filter]').fill(name)
  await win.getByText(name, { exact: true }).first().click()
  await win.locator('[role="gridcell"]').first().waitFor({ timeout: 15000 })
  await win.waitForTimeout(500)
}
try {
  await win.waitForTimeout(800)
  await api('saveConnection', { id: '', name: 'Grid PG', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' })
  await win.reload()
  await win.getByText('Grid PG', { exact: true }).first().dblclick()
  await win.locator('[data-sidebar-filter]').waitFor({ timeout: 15000 })

  // B1: totals of a selection.
  await openTable('orders')
  check('no totals for a single cell', (await win.getByTestId('selection-stats').count()) === 0 || !(await win.getByTestId('selection-stats').isVisible()))
  await win.getByRole('gridcell', { name: '10.50', exact: true }).click()
  await win.getByRole('gridcell', { name: '52.50', exact: true }).click({ modifiers: ['Shift'] })
  const stats = await win.getByTestId('selection-stats').innerText()
  check('selected numbers show count, sum, average, min and max', /Count/.test(stats) && /Sum/.test(stats) && /Avg/.test(stats) && /Max/.test(stats))
  await win.screenshot({ path: `${out}/r103-totals.png` })

  // B4: profile of a column; a common value filters the grid.
  await win.getByRole('columnheader').filter({ hasText: 'status' }).click({ button: 'right' })
  await win.getByText('Profile values…', { exact: true }).click()
  await win.getByTestId('column-profile').waitFor({ timeout: 10000 })
  const profile = await win.getByTestId('column-profile').innerText()
  check('the profile counts rows and lists the common values', /120/.test(profile) && /paid/.test(profile) && /new/.test(profile))
  await win.screenshot({ path: `${out}/r103-profile.png` })
  await win.getByTestId('column-profile').getByRole('button').filter({ hasText: 'paid' }).click()
  await win.waitForTimeout(1500)
  const statuses = await win.getByRole('gridcell', { name: 'new', exact: true }).count()
  check('a common value filters the grid to it', statuses === 0 && (await win.getByRole('gridcell', { name: 'paid', exact: true }).count()) > 0)

  // B2: a cell set to an SQL expression.
  await openTable('customers')
  await win.getByRole('gridcell', { name: 'Bob', exact: true }).click({ button: 'right' })
  await win.getByText('Set SQL expression…', { exact: true }).click()
  await win.getByPlaceholder('now()').fill('1); DELETE FROM shop.orders --')
  await win.getByRole('button', { name: 'Set', exact: true }).click()
  await win.waitForTimeout(400)
  check('an expression with a second statement is refused', (await win.getByRole('gridcell', { name: /^= / }).count()) === 0)
  await win.getByRole('gridcell', { name: 'Bob', exact: true }).click({ button: 'right' })
  await win.getByText('Set SQL expression…', { exact: true }).click()
  await win.getByPlaceholder('now()').fill("upper('bob') || '!'")
  await win.getByRole('button', { name: 'Set', exact: true }).click()
  await win.waitForTimeout(400)
  check('the pending cell shows its expression', (await win.getByRole('gridcell', { name: "= upper('bob') || '!'", exact: true }).count()) === 1)
  await win.getByRole('button', { name: 'Save', exact: true }).click()
  await win.waitForTimeout(1500)
  const saved = (await admin.query(`SELECT name FROM shop.customers WHERE email = 'bob@example.com'`)).rows[0]?.name
  check('saving lets the database work the expression out', saved === 'BOB!')

  // B3: find a value everywhere.
  await win.keyboard.press('ControlOrMeta+k')
  await win.keyboard.insertText('Find a value')
  await win.keyboard.press('Enter')
  await win.getByTestId('find-value-input').fill('alice@example.com')
  await win.keyboard.press('Enter')
  await win.locator('[data-testid="find-value-hit"][data-table="customers"]').waitFor({ timeout: 15000 })
  await win.waitForTimeout(800)
  check('the value is found in customers only', (await win.getByTestId('find-value-hit').count()) === 1)
  await win.screenshot({ path: `${out}/r103-find.png` })
  await win.locator('[data-testid="find-value-hit"][data-table="customers"]').getByRole('button', { name: 'Open' }).click()
  await win.waitForTimeout(1500)
  check('Open shows the table filtered to the rows with the value', (await win.getByRole('gridcell', { name: 'alice@example.com', exact: true }).count()) === 1 && (await win.getByRole('gridcell', { name: 'BOB!', exact: true }).count()) === 0)
  check('no page errors', errors.length === 0)
  if (errors.length) console.log(errors)
} catch (err) {
  console.log('FAIL', err)
  await win.screenshot({ path: `${out}/r103-failure.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  if (bobBefore) await admin.query(`UPDATE shop.customers SET name = $1 WHERE email = 'bob@example.com'`, [bobBefore]).catch(() => {})
  await admin.end()
  await app.close()
}

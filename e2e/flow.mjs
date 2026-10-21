// Dev helper: drives a full flow against the docker Postgres and saves screenshots.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'e2e-shots'
const userData = mkdtempSync(join(tmpdir(), 'dbm-ui-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: userData, DBM_NO_UPDATE_CHECK: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

try {
  await win.getByRole('button', { name: 'New connection' }).first().click()
  await win.getByPlaceholder(/Paste a URL/).fill('postgres://postgres:mastermind@127.0.0.1:54329/mastermind')
  await win.getByPlaceholder(/Paste a URL/).press('Enter')
  await win.getByPlaceholder('Production CRM').fill('Shop (Postgres)')
  await shot('01-connection-form')
  await win.getByRole('button', { name: 'Save & connect' }).click()
  await win.getByPlaceholder(/Filter \d+ tables/).waitFor({ timeout: 20000 })
  await win.waitForTimeout(800)
  await shot('02-connected')
  await win.getByPlaceholder(/Filter \d+ tables/).fill('orders')
  await win.getByPlaceholder(/Filter \d+ tables/).press('Enter')
  await win.waitForTimeout(1500)
  await shot('03-table')
  await win.getByRole('button', { name: /^Filter/ }).click()
  await win.waitForTimeout(300)
  await shot('04-filter-builder')
  await win.keyboard.press(`${mod}+t`)
  await win.waitForTimeout(500)
  await win.locator('.cm-content').click()
  await win.keyboard.type('select c.name, count(o.id) as orders, sum(o.total) as revenue\nfrom shop.customers c join shop.orders o on o.customer_id = c.id\ngroup by c.name order by revenue desc;')
  await win.keyboard.press(`${mod}+Enter`)
  await win.waitForTimeout(1500)
  await shot('05-query')
  await win.keyboard.press(`${mod}+k`)
  await win.waitForTimeout(300)
  await shot('06-palette')
  await win.keyboard.type('ER diagram')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(2500)
  await shot('07-diagram')
} catch (err) {
  console.log('FLOW ERROR', err.message)
  await shot('99-error')
} finally {
  console.log('errors:', JSON.stringify(errors, null, 1))
  await app.close()
}

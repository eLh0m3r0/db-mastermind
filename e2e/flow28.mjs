// Diagram colors: color tables, they survive in a saved diagram.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: mkdtempSync(join(tmpdir(), 'dbm-ui28-')), DBM_NO_UPDATE_CHECK: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const color = async (table, name) => {
  await win.locator('.react-flow__node', { hasText: table }).first().click({ button: 'right' })
  await win.getByText('Color', { exact: true }).hover()
  await win.getByText(name, { exact: true }).click()
  await win.waitForTimeout(300)
}
try {
  await win.waitForTimeout(800)
  const id = await api('createSampleDatabase')
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Demo coffee shop/ }).first().click()
  await win.waitForTimeout(1500)
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('Open ER diagram')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(2500)
  await color('orders', 'Orange')
  await color('order_items', 'Orange')
  await color('payments', 'Orange')
  await color('customers', 'Teal')
  await color('products', 'Purple')
  await color('categories', 'Purple')
  await win.getByRole('button', { name: 'Diagrams' }).click()
  await win.getByText('Save as new diagram…').click()
  await win.getByPlaceholder('e.g. Sales, Billing, Warehouse').fill('Overview')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(1500)
  console.log('saved colors:', JSON.stringify((await api('listDiagrams', id))[0]?.colors))
  await win.screenshot({ path: `${out}/n0-colors.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/99-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

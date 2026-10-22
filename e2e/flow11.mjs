// Saved diagrams: save the focused neighbourhood as "Sales", add a table, reopen it from the menu.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const userData = mkdtempSync(join(tmpdir(), 'dbm-ui11-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: userData, DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
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
  await win.waitForTimeout(1500)
  await win.getByPlaceholder('Focus on table…').fill('orders')
  await win.getByPlaceholder('Focus on table…').press('Enter')
  await win.waitForTimeout(1500)
  await win.getByRole('button', { name: 'Diagrams' }).click()
  await win.getByText('Save as new diagram…').click()
  await win.getByPlaceholder('e.g. Sales, Billing, Warehouse').fill('Sales')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(1200)
  await win.getByPlaceholder('Add table…').fill('categories')
  await win.getByPlaceholder('Add table…').press('Enter')
  await win.waitForTimeout(2000)
  console.log('nodes:', JSON.stringify(await win.evaluate(() => [...document.querySelectorAll('.react-flow__node')].map((n) => [n.getAttribute('data-id'), n.style.transform, n.style.visibility]))))
  const saved = await api('listDiagrams', id)
  console.log('saved:', JSON.stringify(saved.map((d) => [d.name, d.tables.length, Object.keys(d.positions ?? {}).length])))
  await win.screenshot({ path: `${out}/90-saved-diagram.png` })
  await win.getByRole('button', { name: 'Sales' }).click()
  await win.getByRole('menuitem', { name: 'Sales' }).or(win.getByText('Sales', { exact: true }).last()).first().click()
  await win.waitForTimeout(2000)
  console.log('tabs titled Sales:', await win.getByText('Sales', { exact: true }).count())
  await win.screenshot({ path: `${out}/91-reopened.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/99-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

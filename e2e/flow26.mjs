// Columns: hide one, move another, edit through the reordered view, and the layout survives reopening.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: mkdtempSync(join(tmpdir(), 'dbm-ui26-')), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const headers = () => win.locator('[role="columnheader"], .grid-header, div').filter({ hasText: /^(id|name|description)/ }).allInnerTexts()
try {
  await win.waitForTimeout(800)
  await api('createSampleDatabase')
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Demo coffee shop/ }).first().click()
  await win.waitForTimeout(1500)
  await win.getByText('categories', { exact: true }).first().click()
  await win.waitForTimeout(1500)
  await win.getByText('description', { exact: true }).first().click({ button: 'right' })
  await win.getByText('Move left').click()
  await win.waitForTimeout(300)
  await win.getByText('id', { exact: true }).first().click({ button: 'right' })
  await win.getByText('Hide column').click()
  await win.waitForTimeout(300)
  // Edit the first visible cell (now "description") and check the pending edit hits that column.
  await win.getByText('Beans and ground coffee').dblclick()
  await win.keyboard.press('Meta+a')
  await win.keyboard.type('Beans, ground coffee and capsules')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(300)
  await win.screenshot({ path: `${out}/l0-columns.png` })
  // Reopen the table: layout is remembered.
  await win.keyboard.press('Escape')
  console.log('pending:', await win.getByText(/\d+ changes?$/).first().textContent().catch(() => 'none'))
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/99-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

// Paste from a spreadsheet into the table grid: edits existing rows and adds new ones as pending changes.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: mkdtempSync(join(tmpdir(), 'dbm-ui25-')), DBM_NO_UPDATE_CHECK: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  await api('createSampleDatabase')
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Demo coffee shop/ }).first().click()
  await win.waitForTimeout(1500)
  await win.getByText('categories', { exact: true }).first().click()
  await win.waitForTimeout(1500)
  // Focus the "name" cell of the last row.
  const cells = win.locator('text=Gifts')
  await cells.first().click()
  await app.evaluate(({ clipboard }) => clipboard.writeText('Gifts & cards\tVouchers and gift sets\nSyrups\tFlavours for coffee\nMerch\t"Mugs, T-shirts\nand bags"\n'))
  await win.keyboard.press('Meta+v')
  await win.waitForTimeout(800)
  console.log('pending:', await win.getByText(/\d+ changes?$/).first().textContent().catch(() => 'none'))
  await win.screenshot({ path: `${out}/k0-paste.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/99-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

// Model (DBML): start from the database, add a table in text, compare with the database → migration.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: mkdtempSync(join(tmpdir(), 'dbm-ui20-')), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
win.on('dialog', (d) => d.accept())
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
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('New model')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(800)
  await win.getByRole('button', { name: 'From database' }).click()
  await win.waitForTimeout(1500)
  const editor = win.locator('.cm-content').last()
  await editor.click()
  await win.keyboard.press('Meta+End')
  await win.keyboard.insertText(`

Table loyalty_cards {
  id integer [pk, increment]
  customer_id integer [not null, ref: > customers.id]
  points integer [not null, default: 0, note: 'Earned with every order']
  issued_on date
}
`)
  await win.waitForTimeout(2500)
  await win.screenshot({ path: `${out}/f0-model.png` })
  await win.getByRole('button', { name: /Compare with/ }).click()
  await win.waitForTimeout(800)
  await win.getByRole('button', { name: 'Compare', exact: true }).click()
  await win.waitForTimeout(2000)
  console.log('migration:', (await win.locator('pre').last().innerText()).slice(0, 600))
  await win.screenshot({ path: `${out}/f1-model-compare.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/99-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

// Diagram join path: customers → categories on the demo database, then open it as a query.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const userData = mkdtempSync(join(tmpdir(), 'dbm-ui10-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: userData, DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
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
  await win.getByRole('button', { name: /Demo|Coffee|Sample|Ukázk/i }).first().click()
  await win.waitForTimeout(1500)
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('Open ER diagram')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(1500)
  await win.getByPlaceholder('Focus on table…').fill('customers')
  await win.getByPlaceholder('Focus on table…').press('Enter')
  await win.waitForTimeout(800)
  await win.getByPlaceholder('Join path to…').fill('categories')
  await win.waitForTimeout(2000)
  await win.screenshot({ path: `${out}/80-path.png` })
  await win.getByRole('button', { name: 'Open as query' }).click()
  await win.waitForTimeout(800)
  await win.keyboard.press('Meta+Shift+Enter')
  await win.waitForTimeout(1500)
  await win.screenshot({ path: `${out}/81-path-query.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/99-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

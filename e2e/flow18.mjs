// Snippets: "dup" expands to a duplicates query with fields; the settings section lists them.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const userData = mkdtempSync(join(tmpdir(), 'dbm-ui18-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: userData, DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
win.on('console', (m) => (m.type() === 'error' || m.text().startsWith('SNIPPET')) && errors.push(m.text()))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  await api('createSampleDatabase')
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Demo coffee shop/ }).first().click()
  await win.waitForTimeout(1500)
  await win.locator('.cm-content').first().click()
  await win.keyboard.type('dup')
  await win.waitForTimeout(600)
  await win.screenshot({ path: `${out}/d0-snippet-menu.png` })
  await win.keyboard.press('Enter')
  await win.keyboard.type('email')
  await win.keyboard.press('Tab')
  await win.keyboard.type('customers')
  await win.keyboard.press('Escape')
  await win.waitForTimeout(300)
  console.log('sql:', await win.locator('.cm-content').first().innerText())
  await win.keyboard.press('Meta+Enter')
  await win.waitForTimeout(1200)
  await win.screenshot({ path: `${out}/d1-snippet.png` })
  await win.keyboard.press('Meta+,')
  await win.waitForTimeout(500)
  await win.getByRole('button', { name: 'Snippets' }).click()
  await win.waitForTimeout(400)
  await win.screenshot({ path: `${out}/d2-snippet-settings.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/99-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

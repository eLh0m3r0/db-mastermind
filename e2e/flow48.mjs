// High-contrast theme, light and dark.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: mkdtempSync(join(tmpdir(), 'dbm-ui48-')), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  await api('createSampleDatabase')
  await api('updateSettings', { contrast: 'high', theme: 'dark' })
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Demo coffee shop/ }).first().click()
  await win.waitForTimeout(1200)
  await win.getByText('orders', { exact: true }).first().click()
  await win.waitForTimeout(1200)
  console.log('class:', await win.evaluate(() => document.documentElement.className))
  await win.screenshot({ path: `${out}/r16-hc-dark.png` })
  await api('updateSettings', { theme: 'light' })
  await win.reload()
  await win.waitForTimeout(1500)
  await win.screenshot({ path: `${out}/r16-hc-light.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

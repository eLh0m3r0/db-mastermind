import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const userData = mkdtempSync(join(tmpdir(), 'dbm-ui6-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: userData, DBM_NO_UPDATE_CHECK: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  await api('updateSettings', { ai: { activeProvider: 'claude-code', providers: [{ id: 'claude-code', enabled: true }], dataSharing: 'schema-and-samples', autoRunReadQueries: true } })
  await win.reload()
  await win.waitForTimeout(1200)
  await win.getByRole('button', { name: 'Try the demo database' }).click()
  await win.getByPlaceholder(/Filter \d+ tables/).waitFor({ timeout: 20000 })
  await win.getByPlaceholder(/Filter \d+ tables/).fill('orders')
  await win.getByPlaceholder(/Filter \d+ tables/).press('Enter')
  await win.waitForTimeout(1000)
  await win.getByPlaceholder(/Describe a filter/).fill('shipped orders from summer 2025 that have a note')
  await win.getByPlaceholder(/Describe a filter/).press('Enter')
  await win.getByPlaceholder(/Describe a filter/).isEnabled()
  await win.waitForFunction(() => !document.querySelector('input[placeholder^="Describe a filter"]')?.hasAttribute('disabled'), null, { timeout: 180000 })
  await win.waitForTimeout(1200)
  await win.screenshot({ path: `${out}/50-ai-filter.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/99-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

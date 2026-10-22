// AI permissions in one place: defaults and per-connection levels.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: mkdtempSync(join(tmpdir(), 'dbm-ui56-')), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  const id = await api('createSampleDatabase')
  await api('saveConnection', { id: '', name: 'Production ERP', driver: 'sqlite', filePath: ':memory:', readOnly: true })
  await win.reload()
  await win.waitForTimeout(1000)
  await win.keyboard.press('Meta+,')
  await win.getByRole('dialog').getByRole('button', { name: 'AI permissions' }).click()
  await win.waitForTimeout(500)
  const row = win.locator('div.border-b').filter({ hasText: 'Demo coffee shop' }).last()
  await row.locator('select').selectOption('schema')
  await win.waitForTimeout(500)
  const demo = (await api('listConnections')).find((c) => c.id === id)
  console.log('saved:', JSON.stringify(demo.ai))
  const erp = win.locator('div.border-b').filter({ hasText: 'Production ERP' }).last()
  console.log('read-only write option disabled:', await erp.locator('option[value="write"]').isDisabled())
  await win.screenshot({ path: `${out}/r20-permissions.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/r20-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

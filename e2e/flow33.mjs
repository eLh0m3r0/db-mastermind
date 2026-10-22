// Export all rows of a query beyond the editor's row limit (streamed).
import { _electron as electron } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui33-'))
const target = join(dir, 'all.csv')
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: dir, DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
await app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }) }, target)
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  await api('createSampleDatabase')
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Demo coffee shop/ }).first().click()
  await win.waitForTimeout(1500)
  await win.locator('.cm-content').first().click()
  await win.keyboard.press('Meta+a')
  await win.keyboard.insertText('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 25000) SELECT i, i * 2 AS twice FROM n;')
  await win.keyboard.press('Meta+Enter')
  await win.waitForTimeout(2000)
  await win.getByRole('button', { name: 'Export', exact: true }).click()
  await win.getByText('All rows (runs the query again)').hover()
  await win.getByText('CSV', { exact: false }).first().click()
  await win.waitForTimeout(3000)
  await win.screenshot({ path: `${out}/r1-export-all.png` })
  const lines = readFileSync(target, 'utf8').trim().split(/\r?\n/)
  console.log('lines:', lines.length, 'first:', lines[0], 'last:', lines.at(-1))
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

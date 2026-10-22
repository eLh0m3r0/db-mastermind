// Audit: grid edits land in the history with their source, and the history exports to CSV.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const csv = join(mkdtempSync(join(tmpdir(), 'dbm-audit-')), 'history.csv')
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: mkdtempSync(join(tmpdir(), 'dbm-ui30-')), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, csv)
  const id = await api('createSampleDatabase')
  await api('runQuery', { runId: 'r1', connectionId: id, sql: 'SELECT count(*) FROM customers' })
  await api('applyChanges', id, { schema: 'main', name: 'categories' }, [{ type: 'update', key: { id: 5 }, values: { name: 'Gifts & cards' } }])
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Demo coffee shop/ }).first().click()
  await win.waitForTimeout(1200)
  await win.getByRole('button', { name: 'History' }).click()
  await win.waitForTimeout(800)
  await win.screenshot({ path: `${out}/p0-history.png` })
  await win.getByRole('button', { name: 'Export…' }).click()
  await win.waitForTimeout(800)
  console.log(readFileSync(csv, 'utf8'))
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/99-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

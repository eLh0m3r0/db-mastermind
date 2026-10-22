// Server activity: a slow query in one tab shows up in the activity tab and can be cancelled.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const userData = mkdtempSync(join(tmpdir(), 'dbm-ui7-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: userData, DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  const conn = await api('saveConnection', { id: '', name: 'Dev (Postgres)', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' })
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Dev \(Postgres\)/ }).first().click()
  await win.waitForTimeout(1500)
  void api('runQuery', { runId: 'slow1', connectionId: conn.id, sql: 'SELECT pg_sleep(20) /* nightly report */', session: 'other' })
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('Server activity')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(2500)
  await win.screenshot({ path: `${out}/50-activity.png` })
  const row = win.locator('tr', { hasText: 'nightly report' }).first()
  await row.hover()
  await row.getByRole('button', { name: 'Cancel query' }).click()
  await win.waitForTimeout(3500)
  console.log('still listed after cancel:', await win.locator('tr', { hasText: 'nightly report' }).count())
  await win.screenshot({ path: `${out}/51-activity-after.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/99-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

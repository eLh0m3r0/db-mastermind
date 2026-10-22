// Server activity shows a blocked session and the session blocking it.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const userData = mkdtempSync(join(tmpdir(), 'dbm-ui14-'))
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
  await api('runQuery', { runId: 'h', connectionId: conn.id, sql: 'BEGIN; UPDATE shop.customers SET name = name WHERE id = 1', session: 'holder' })
  void api('runQuery', { runId: 'w', connectionId: conn.id, sql: 'UPDATE shop.customers SET vip = vip WHERE id = 1 /* month-end batch */', session: 'waiter' }).catch(() => {})
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('Server activity')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(3000)
  await win.screenshot({ path: `${out}/b0-locks.png` })
  await api('releaseSession', conn.id, 'holder')
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/99-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

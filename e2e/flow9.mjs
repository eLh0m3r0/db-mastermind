// Pinning a table puts it in a "Pinned" group that survives a reload.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const userData = mkdtempSync(join(tmpdir(), 'dbm-ui9-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: userData, DBM_NO_UPDATE_CHECK: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const open = async () => {
  await win.getByRole('button', { name: /Dev \(Postgres\)/ }).first().click()
  await win.waitForTimeout(1500)
}
try {
  await win.waitForTimeout(800)
  await api('saveConnection', { id: '', name: 'Dev (Postgres)', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' })
  await win.reload()
  await win.waitForTimeout(1000)
  await open()
  await win.getByText('orders', { exact: true }).first().click({ button: 'right' })
  await win.getByText('Pin to top').click()
  await win.waitForTimeout(500)
  await win.reload()
  await win.waitForTimeout(1000)
  await open()
  await win.keyboard.press('Escape')
  await win.waitForTimeout(200)
  console.log('pinned group:', await win.getByText('Pinned', { exact: true }).count(), 'orders rows:', await win.getByText('orders', { exact: true }).count())
  await win.screenshot({ path: `${out}/70-pinned.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/99-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

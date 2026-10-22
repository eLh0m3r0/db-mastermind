// Confirmations use the app's own dialog with named buttons (window.confirm only offered OK/Cancel): a statement that
// can delete data on a production connection, and deleting a connection. Destructive dialogs start on Cancel.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2] ?? tmpdir()
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui68-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: dir, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
win.on('dialog', (d) => { errors.push(`native dialog: ${d.message()}`); void d.dismiss() })
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  const c = await api('saveConnection', { id: '', name: 'Prod PG', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind', environment: 'production' })
  await api('connect', c.id)
  await api('runQuery', { connectionId: c.id, sql: 'DROP TABLE IF EXISTS shop.flow68; CREATE TABLE shop.flow68 (a int); INSERT INTO shop.flow68 VALUES (1), (2)', runId: 's' })
  await win.reload(); await win.waitForTimeout(1000)
  await win.getByText('Prod PG', { exact: true }).first().dblclick()
  const ed = win.locator('.cm-content:visible').first()
  await ed.waitFor({ timeout: 20000 }); await ed.click()
  await win.keyboard.type('DELETE FROM shop.flow68')
  await win.keyboard.press(`${mod}+Enter`)
  await win.getByRole('dialog').waitFor({ timeout: 10000 })
  console.log('dialog:', (await win.getByRole('dialog').innerText()).replace(/\n+/g, ' / '))
  await win.screenshot({ path: `${out}/r68-confirm.png` })
  console.log('focused:', await win.evaluate(() => document.activeElement?.textContent))
  await win.keyboard.press('Enter'); await win.waitForTimeout(800)
  const count = async () => Number((await api('runQuery', { connectionId: c.id, sql: 'SELECT count(*) FROM shop.flow68', runId: 'c' + Math.random() }))[0].results[0].rows[0][0])
  console.log('rows after Enter (cancel):', await count())
  await ed.click(); await win.keyboard.press(`${mod}+Enter`)
  await win.getByRole('button', { name: 'Run anyway' }).click(); await win.waitForTimeout(1200)
  console.log('rows after Run anyway:', await count())
  await win.getByRole('button', { name: 'All connections' }).click(); await win.waitForTimeout(500)
  await win.getByText('Prod PG', { exact: true }).first().click({ button: 'right' })
  await win.getByRole('menuitem', { name: /^Delete/ }).click()
  await win.getByRole('dialog').waitFor()
  console.log('delete dialog:', (await win.getByRole('dialog').innerText()).replace(/\n+/g, ' / '))
  await win.getByRole('dialog').getByRole('button', { name: 'Delete' }).click(); await win.waitForTimeout(600)
  console.log('connections left:', (await api('listConnections')).length)
  console.log('errors:', errors.length ? errors : 'none')
} finally {
  await app.close()
}

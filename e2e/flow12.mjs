// Data compare: orders vs a modified copy, with the sync script.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const userData = mkdtempSync(join(tmpdir(), 'dbm-ui12-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: userData, DBM_NO_UPDATE_CHECK: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  const conn = await api('saveConnection', { id: '', name: 'Dev (Postgres)', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' })
  const res = await api('runQuery', {
    runId: 'setup',
    connectionId: conn.id,
    sql: `DROP TABLE IF EXISTS shop.orders_copy; CREATE TABLE shop.orders_copy AS SELECT * FROM shop.orders; DELETE FROM shop.orders_copy WHERE id <= 2; UPDATE shop.orders_copy SET status = 'refunded' WHERE id IN (7, 8); INSERT INTO shop.orders_copy SELECT 999, customer_id, total, status, ordered_on FROM shop.orders WHERE id = 5`,
  })
  console.log('setup errors:', JSON.stringify(res.filter((o) => o.error).map((o) => o.error.message)))
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Dev \(Postgres\)/ }).first().click()
  await win.waitForTimeout(1500)
  await win.getByText('orders', { exact: true }).first().click({ button: 'right' })
  await win.getByText('Compare data with…').click()
  await win.waitForTimeout(1000)
  await win.locator('select').nth(3).selectOption({ label: 'orders_copy' })
  await win.getByRole('button', { name: 'Compare', exact: true }).click()
  await win.waitForTimeout(2500)
  await win.getByText('Delete extra').click()
  await win.waitForTimeout(300)
  await win.screenshot({ path: `${out}/95-data-compare.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/99-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

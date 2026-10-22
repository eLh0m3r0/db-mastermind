// Dashboards: pin a chart and a single value, open the dashboard.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: mkdtempSync(join(tmpdir(), 'dbm-ui22-')), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
win.on('dialog', (d) => d.accept())
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const run = async (sql) => {
  await win.locator('.cm-content').first().click()
  await win.keyboard.press('Meta+a')
  await win.keyboard.insertText(sql)
  await win.keyboard.press('Meta+Enter')
  await win.waitForTimeout(1200)
}
const pin = async (dashboard) => {
  await win.getByRole('button', { name: 'Pin to dashboard' }).click()
  await win.getByText(dashboard, { exact: true }).last().click()
  await win.waitForTimeout(600)
}
try {
  await win.waitForTimeout(800)
  await api('createSampleDatabase')
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Demo coffee shop/ }).first().click()
  await win.waitForTimeout(1500)
  await run("SELECT substr(o.ordered_at, 1, 7) AS month, round(sum(i.quantity * i.unit_price)) AS revenue FROM orders o JOIN order_items i ON i.order_id = o.id WHERE o.status <> 'cancelled' GROUP BY month ORDER BY month")
  await win.getByRole('button', { name: 'Show chart' }).click()
  await pin('New dashboard')
  await run('SELECT count(*) AS customers FROM customers')
  await pin('Dashboard 1')
  await run('SELECT c.name AS category, count(*) AS products FROM products p JOIN categories c ON c.id = p.category_id GROUP BY c.name ORDER BY products DESC')
  await pin('Dashboard 1')
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('Dashboards')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(800)
  await win.getByText('Dashboard 1', { exact: true }).last().click()
  await win.waitForTimeout(2500)
  await win.screenshot({ path: `${out}/g0-dashboard.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/99-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

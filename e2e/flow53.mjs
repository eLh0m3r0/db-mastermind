// ClickHouse in the app: connect, browse with a filter, run SQL, export everything, no row editing.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui53-'))
const target = join(dir, 'events.csv')
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
await app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }) }, target)
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  const c = await api('saveConnection', { id: '', name: 'Analytics (ClickHouse)', driver: 'clickhouse', host: '127.0.0.1', port: 18123, user: 'default', password: 'mastermind', database: 'default' })
  await api('connect', c.id)
  await api('runQuery', { connectionId: c.id, sql: "CREATE OR REPLACE TABLE dbm_e2e (id UInt64, kind String, amount Float64) ENGINE = MergeTree ORDER BY id AS SELECT number, ['a','b'][number % 2 + 1], number / 3 FROM numbers(15000)", runId: 'c' })
  await win.reload()
  await win.waitForTimeout(1200)
  await win.getByRole('button', { name: /Analytics \(ClickHouse\)/ }).first().click()
  await win.waitForTimeout(2000)
  await win.getByText('dbm_e2e', { exact: true }).first().click()
  await win.waitForTimeout(1500)
  console.log('rows label:', await win.getByText(/rows/).first().innerText())
  console.log('add row disabled:', await win.getByRole('button', { name: /Add row/ }).first().isDisabled().catch(() => 'n/a'))
  await win.screenshot({ path: `${out}/r18-clickhouse-table.png` })
  await win.getByRole('tab', { name: /Query 1/ }).click()
  await win.locator('.cm-content:visible').first().click()
  await win.keyboard.insertText('SELECT kind, count() AS n, round(avg(amount), 2) AS avg FROM dbm_e2e GROUP BY kind ORDER BY kind')
  await win.keyboard.press('Meta+Enter')
  await win.waitForTimeout(1500)
  console.log('grouped:', (await win.locator('.font-mono:visible').allInnerTexts()).filter((x) => /^(a|b|7500|\d+\.\d+)$/.test(x)).join(' '))
  await win.keyboard.press('Meta+a')
  await win.keyboard.insertText('SELECT * FROM dbm_e2e')
  await win.keyboard.press('Meta+Enter')
  await win.waitForTimeout(2000)
  await win.getByRole('button', { name: 'Export', exact: true }).click()
  await win.getByText('All rows (runs the query again)').hover()
  await win.getByText('CSV', { exact: false }).first().click()
  await win.waitForTimeout(3000)
  console.log('exported lines:', readFileSync(target, 'utf8').trim().split('\n').length)
  await win.screenshot({ path: `${out}/r18-clickhouse-query.png` })
  await api('runQuery', { connectionId: c.id, sql: 'DROP TABLE dbm_e2e', runId: 'd' })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/r18-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

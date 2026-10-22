// BigQuery in the app (emulator on :19050): add the connection in the form, browse a table, filter a number
// column with a typed value, run SQL.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui60-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: dir, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  // Seed through a throwaway connection, then add the real one through the form.
  const seed = await api('saveConnection', { id: '', name: 'seed', driver: 'bigquery', host: 'http://127.0.0.1:19050', database: 'dbm-test' })
  await api('connect', seed.id)
  for (const sql of [
    'DROP TABLE IF EXISTS shop.e2e_orders',
    'CREATE TABLE shop.e2e_orders (id INT64, customer STRING, total NUMERIC, placed DATE)',
    "INSERT INTO shop.e2e_orders VALUES (1, 'Ann', 10.5, DATE '2026-01-01'), (2, 'Bob', 25, DATE '2026-02-01'), (3, 'Cid', 40.25, DATE '2026-03-01'), (4, 'Dee', 7, DATE '2026-04-01')",
  ]) {
    const r = await api('runQuery', { connectionId: seed.id, sql, runId: `s${Math.random()}` })
    if (r?.[0]?.error) throw new Error(`seed: ${JSON.stringify(r[0].error)}`)
  }
  await api('deleteConnection', seed.id)
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: 'New connection' }).first().click()
  await win.waitForTimeout(500)
  await win.getByRole('button', { name: 'BigQuery', exact: true }).click()
  await win.getByLabel('Project ID').fill('dbm-test').catch(async () => {
    await win.locator('input[placeholder="my-project-123"]').fill('dbm-test')
  })
  await win.getByRole('button', { name: 'Advanced', exact: true }).click()
  await win.locator('input[placeholder="https://bigquery.googleapis.com"]').fill('http://127.0.0.1:19050')
  await win.getByRole('button', { name: 'General', exact: true }).click()
  await win.screenshot({ path: `${out}/r60-bigquery-form.png` })
  await win.getByRole('button', { name: /Save & connect|Connect/ }).last().click()
  await win.waitForTimeout(3000)
  await win.getByPlaceholder(/Filter \d+ tables/).fill('e2e_orders')
  await win.getByPlaceholder(/Filter \d+ tables/).press('Enter')
  await win.waitForTimeout(2500)
  console.log('rows label:', await win.getByText(/rows/).first().innerText())
  await win.getByRole('button', { name: /^Filter/ }).click()
  await win.locator('select').nth(0).selectOption('total')
  await win.locator('select').nth(1).selectOption('gt')
  await win.getByPlaceholder('value').last().fill('20')
  await win.getByRole('button', { name: 'Apply' }).click()
  await win.waitForTimeout(2500)
  const cells = await win.locator('.font-mono:visible').allInnerTexts()
  console.log('filtered customers:', ['Ann', 'Bob', 'Cid', 'Dee'].filter((n) => cells.includes(n)).join(','))
  await win.screenshot({ path: `${out}/r60-bigquery-filter.png` })
  await win.keyboard.press('Meta+t')
  await win.waitForTimeout(500)
  await win.locator('.cm-content:visible').first().click()
  await win.keyboard.insertText('SELECT COUNT(*) AS n, SUM(total) AS revenue FROM shop.e2e_orders WHERE placed >= DATE \'2026-02-01\'')
  await win.keyboard.press('Meta+Enter')
  await win.waitForTimeout(3000)
  const texts = await win.locator('.font-mono:visible').allInnerTexts()
  console.log('query result:', texts.filter((x) => /^(3|72\.25)$/.test(x)).join(' '))
  await win.screenshot({ path: `${out}/r60-bigquery-query.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/r60-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

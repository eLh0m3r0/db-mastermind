// Moving data (Milestone 11, D): "Copy to another connection…" on a table copies it with the table it references
// from PostgreSQL into a new SQLite file (created, rows and keys kept); "Run the query on several connections" runs
// one query on both; JSON and Parquet files import into a table. Needs `npm run db:up` (postgres) and the shop
// fixtures.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'

const out = process.argv[2] ?? tmpdir()
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui108-'))
const jsonFile = join(dir, 'people.json')
writeFileSync(jsonFile, JSON.stringify([{ id: 1, name: 'Ann', tags: ['a'] }, { id: 2, name: 'Ben' }]))
const parquetFile = join(dir, 'people.parquet')
const duck = await DuckDBInstance.create(':memory:')
const dc = await duck.connect()
await dc.run(`COPY (SELECT * FROM (VALUES (3, 'Cid'), (4, 'Dee')) t(id, name)) TO '${parquetFile}' (FORMAT parquet)`)
dc.closeSync()

const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const check = (label, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) process.exitCode = 1
}
const one = async (id, sql) => {
  const [o] = await api('runQuery', { connectionId: id, sql, runId: `q${Date.now()}` })
  return o.error ? `ERROR ${o.error.message}` : o.results?.[0]?.rows?.[0]?.[0]
}
try {
  await win.waitForTimeout(800)
  await api('saveConnection', { id: '', name: 'Source PG', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' })
  const lite = await api('saveConnection', { id: '', name: 'Target Lite', driver: 'sqlite', filePath: join(dir, 'target.db') })
  await win.reload()
  await win.getByText('Source PG', { exact: true }).first().dblclick()
  await win.locator('[data-sidebar-filter]').waitFor({ timeout: 15000 })

  // Copy orders (and the customers it references) into SQLite.
  await win.locator('[data-sidebar-filter]').fill('shop.orders')
  await win.getByText('orders', { exact: true }).first().click({ button: 'right' })
  await win.getByText('Copy to another connection…', { exact: true }).click()
  await win.getByTestId('copy-tables').waitFor({ timeout: 5000 })
  await win.getByTestId('copy-target').selectOption({ label: 'Target Lite' })
  await win.getByTestId('copy-tables').getByText('shop.customers', { exact: true }).click()
  await win.screenshot({ path: `${out}/r108-copy.png` })
  await win.getByTestId('copy-start').click()
  await win.getByTestId('copy-result').waitFor({ timeout: 30000 })
  const summary = await win.getByTestId('copy-result').innerText()
  check('the copy reports both tables, parents first', /customers[\s\S]*3 rows[\s\S]*orders[\s\S]*120 rows/.test(summary))
  await win.screenshot({ path: `${out}/r108-copied.png` })
  check('the rows are in SQLite with their keys', Number(await one(lite.id, 'SELECT COUNT(*) FROM orders o JOIN customers c ON c.id = o.customer_id')) === 120)
  await win.getByRole('dialog').getByText('Close', { exact: true }).click()

  // One query on both connections.
  await win.keyboard.press('ControlOrMeta+t')
  await win.waitForTimeout(500)
  await win.locator('.cm-content:visible').first().click()
  await win.keyboard.insertText('SELECT 41 + 1 AS answer')
  await win.keyboard.press('ControlOrMeta+k')
  await win.keyboard.insertText('Run the query on several')
  await win.keyboard.press('Enter')
  await win.getByTestId('run-many').waitFor({ timeout: 5000 })
  await win.getByTestId('run-many').getByText('Target Lite', { exact: true }).click()
  await win.getByTestId('run-many-start').click()
  await win.getByTestId('run-many-results').waitFor({ timeout: 10000 })
  await win.waitForTimeout(1500)
  const results = await win.getByTestId('run-many-results').innerText()
  check('the query ran on both connections', /Source PG[\s\S]*1 row/.test(results) && /Target Lite[\s\S]*1 row/.test(results))
  await win.screenshot({ path: `${out}/r108-run-many.png` })
  await win.getByRole('dialog').getByText('Close', { exact: true }).click()

  // JSON and Parquet into a table.
  await one(lite.id, 'CREATE TABLE people (id integer, name text, tags text)')
  const preview = await api('importPreview', jsonFile)
  check('a JSON file previews with its keys as the header', preview.format === 'json' && preview.rows[0].join(',') === 'id,name,tags')
  await api('importFile', { connectionId: lite.id, table: { name: 'people' }, path: jsonFile, hasHeader: true, mapping: ['id', 'name', 'tags'] })
  await api('importFile', { connectionId: lite.id, table: { name: 'people' }, path: parquetFile, hasHeader: true, mapping: ['id', 'name'] })
  check('JSON and Parquet rows are imported', Number(await one(lite.id, 'SELECT COUNT(*) FROM people')) === 4 && (await one(lite.id, "SELECT tags FROM people WHERE id = 1")) === '["a"]')
  check('no page errors', errors.length === 0)
  if (errors.length) console.log(errors)
} catch (err) {
  console.log('FAIL', err)
  await win.screenshot({ path: `${out}/r108-failure.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await app.close()
}

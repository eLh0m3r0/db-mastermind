// Server health (Milestone 11, E): Server activity keeps Sessions as it was and adds Top queries and Storage.
// MySQL lists its most expensive statements; PostgreSQL without pg_stat_statements says how to turn it on; Storage
// lists table sizes and the never-used flow105_unused_idx, whose DROP INDEX opens in the editor (never runs). Needs
// `npm run db:up` (postgres, mysql) and the shop fixtures.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'

const out = process.argv[2] ?? tmpdir()
// A fresh index nothing has used (the fixtures' own may have served other flows' filters since the server started).
const admin = new pg.Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' })
await admin.connect()
await admin.query('DROP INDEX IF EXISTS shop.flow105_unused_idx')
await admin.query('CREATE INDEX flow105_unused_idx ON shop.customers (name, email)')
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui105-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const check = (label, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) process.exitCode = 1
}
const palette = async (text) => {
  await win.keyboard.press('ControlOrMeta+k')
  await win.keyboard.insertText(text)
  await win.waitForTimeout(300)
  await win.keyboard.press('Enter')
}
try {
  await win.waitForTimeout(800)
  await api('saveConnection', { id: '', name: 'Health PG', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' })
  await api('saveConnection', { id: '', name: 'Health MY', driver: 'mysql', host: '127.0.0.1', port: 33069, user: 'root', password: 'mastermind', database: 'mastermind' })
  await win.reload()

  await win.getByText('Health PG', { exact: true }).first().dblclick()
  await win.locator('.cm-content:visible').first().waitFor({ timeout: 15000 })
  await palette('Server activity')
  await win.getByText('Server activity', { exact: true }).first().waitFor({ timeout: 10000 })
  await win.waitForTimeout(1500)
  check('Server activity opens on Sessions, as before', (await win.getByRole('button', { name: 'Sessions', pressed: true }).count()) === 1 && (await win.getByPlaceholder('Search sessions…').count()) === 1)

  await win.getByRole('button', { name: 'Top queries' }).click()
  const unavailable = win.getByTestId('top-queries-unavailable')
  const loadedPg = await Promise.race([unavailable.waitFor({ timeout: 10000 }).then(() => 'unavailable'), win.locator('[data-testid="top-queries"] table').waitFor({ timeout: 10000 }).then(() => 'table')])
  if (loadedPg === 'unavailable') check('without pg_stat_statements it says how to enable it', /CREATE EXTENSION pg_stat_statements/.test(await unavailable.innerText()))
  else check('with pg_stat_statements it lists statements', true)
  check('the session search is only on Sessions', (await win.getByPlaceholder('Search sessions…').count()) === 0)
  await win.screenshot({ path: `${out}/r105-pg-top.png` })

  await win.getByRole('button', { name: 'Storage' }).click()
  await win.getByTestId('index-findings').waitFor({ timeout: 10000 })
  const storage = await win.getByTestId('storage').innerText()
  check('Storage lists the tables with their sizes', /orders/.test(storage) && /customers/.test(storage) && /kB|MB/.test(storage))
  check('the never-used index is listed', /flow105_unused_idx/.test(await win.getByTestId('index-findings').innerText()))
  await win.screenshot({ path: `${out}/r105-storage.png` })
  await win.getByTestId('index-findings').locator('div', { hasText: 'flow105_unused_idx' }).last().getByRole('button', { name: 'Open DROP INDEX in editor' }).click()
  await win.waitForTimeout(800)
  const sql = await win.locator('.cm-content:visible').first().innerText()
  check('DROP INDEX opens in the editor with a warning, not run', /DROP INDEX "?shop"?\."?flow105_unused_idx"?;/.test(sql) && /Check before dropping/.test(sql))

  // MySQL: performance_schema has the statements.
  await win.getByRole('button', { name: 'All connections' }).click()
  await win.getByText('Health MY', { exact: true }).first().dblclick()
  await win.waitForTimeout(1500)
  await api('runQuery', { connectionId: (await api('listConnections')).find((c) => c.name === 'Health MY').id, sql: 'SELECT COUNT(*) FROM orders WHERE total > 5' })
  await palette('Top queries')
  await win.locator('[data-testid="top-queries"] table').waitFor({ timeout: 15000 })
  check('MySQL lists its most expensive statements', /orders/i.test(await win.getByTestId('top-queries').innerText()))
  await win.screenshot({ path: `${out}/r105-mysql-top.png` })
  check('no page errors', errors.length === 0)
  if (errors.length) console.log(errors)
} catch (err) {
  console.log('FAIL', err)
  await win.screenshot({ path: `${out}/r105-failure.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await admin.query('DROP INDEX IF EXISTS shop.flow105_unused_idx').catch(() => {})
  await admin.end()
  await app.close()
}

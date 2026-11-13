// Manual commit on a PostgreSQL connection: a change in the SQL editor opens a transaction the toolbar shows (with
// what ran in it), Roll back and Commit end it, the tab is marked meanwhile; closing the tab, disconnecting and
// quitting ask first; an error leaves a failed transaction that only Roll back ends. Needs `npm run db:up` (postgres).
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'

const out = process.argv[2] ?? tmpdir()
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui98-'))
const pool = new pg.Pool({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' })
const count = async () => Number((await pool.query('SELECT count(*) AS n FROM tx_e2e')).rows[0].n)
await pool.query('DROP TABLE IF EXISTS tx_e2e')
await pool.query('CREATE TABLE tx_e2e (v int)')

const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const check = (label, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) process.exitCode = 1
}
const bar = () => win.getByTestId('transaction-bar')
const run = async (sql) => {
  const editor = win.locator('.cm-content:visible').first()
  await editor.click()
  await win.keyboard.press('ControlOrMeta+a')
  await win.keyboard.insertText(sql)
  await win.keyboard.press('ControlOrMeta+Enter')
  await win.waitForTimeout(700)
}
try {
  await win.waitForTimeout(800)
  await api('saveConnection', { id: '', name: 'Manual PG', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind', manualCommit: true })
  await win.reload()
  await win.getByText('Manual PG', { exact: true }).first().dblclick()
  await win.locator('.cm-content:visible').first().waitFor({ timeout: 15000 })
  check('manual commit is shown before anything runs', await win.getByTestId('manual-commit').isVisible())

  // A change opens a transaction: shown, marked on the tab, invisible to other connections.
  await run('INSERT INTO tx_e2e VALUES (1)')
  await bar().waitFor({ timeout: 10000 })
  check('toolbar shows the transaction with its change', /Transaction · 1 change/.test(await bar().innerText()))
  check('tab is marked', await win.getByTestId('tab-transaction').count() === 1)
  check('other connections see nothing yet', (await count()) === 0)
  await bar().getByRole('button', { name: /Transaction/ }).click()
  check('the list names the statement and its rows', await win.getByText('INSERT INTO tx_e2e VALUES (1)').count() > 0 && await win.getByText('1 row', { exact: true }).count() > 0)
  await win.screenshot({ path: `${out}/r98-open.png` })
  await win.keyboard.press('Escape')

  await bar().getByRole('button', { name: 'Roll back' }).click()
  await win.getByText('Rolled back: 1 change undone').waitFor({ timeout: 10000 })
  check('roll back ends it and keeps nothing', (await bar().count()) === 0 && (await count()) === 0 && (await win.getByTestId('tab-transaction').count()) === 0)

  // Reads open nothing; a change and Commit.
  await run('SELECT count(*) FROM tx_e2e')
  check('a read opens no transaction', (await bar().count()) === 0)
  await run('INSERT INTO tx_e2e VALUES (2)')
  await bar().waitFor({ timeout: 10000 })
  await bar().getByRole('button', { name: 'Commit' }).click()
  await win.getByText('Committed: 1 change saved').waitFor({ timeout: 10000 })
  check('commit saves it', (await count()) === 1)

  // Closing the tab asks; Cancel keeps it, Roll back closes it.
  await run('INSERT INTO tx_e2e VALUES (3)')
  await bar().waitFor({ timeout: 10000 })
  const tabsBefore = await win.getByRole('tab').count()
  await win.keyboard.press('ControlOrMeta+w')
  await win.getByText(/has an open transaction/).waitFor({ timeout: 10000 })
  await win.screenshot({ path: `${out}/r98-close.png` })
  await win.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  await win.waitForTimeout(300)
  check('cancel keeps the tab and its transaction', (await win.getByRole('tab').count()) === tabsBefore && (await bar().count()) === 1)
  await win.keyboard.press('ControlOrMeta+w')
  await win.getByText(/has an open transaction/).waitFor({ timeout: 10000 })
  await win.getByRole('dialog').getByRole('button', { name: 'Roll back' }).click()
  await win.waitForTimeout(800)
  check('roll back closes the tab and keeps nothing', (await win.getByRole('tab').count()) === tabsBefore - 1 && (await count()) === 1)

  // An error: a failed transaction, only Roll back.
  await win.keyboard.press('ControlOrMeta+t')
  await win.locator('.cm-content:visible').first().waitFor({ timeout: 10000 })
  await run('INSERT INTO tx_e2e VALUES (4)')
  await bar().waitFor({ timeout: 10000 })
  await run('SELECT no_such_column FROM tx_e2e')
  await win.waitForTimeout(500)
  check('an error leaves a failed transaction', (await bar().getAttribute('data-state')) === 'failed' && /Transaction failed/.test(await bar().innerText()))
  check('a failed transaction offers no Commit', (await bar().getByRole('button', { name: 'Commit' }).count()) === 0)
  await win.screenshot({ path: `${out}/r98-failed.png` })
  await bar().getByRole('button', { name: 'Roll back' }).click()
  await win.waitForTimeout(800)
  check('roll back clears the failure', (await bar().count()) === 0)

  // Disconnecting asks; Commit saves.
  await run('INSERT INTO tx_e2e VALUES (5)')
  await bar().waitFor({ timeout: 10000 })
  // (File → Disconnect)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'disconnect'))
  await win.getByText(/has an open transaction/).waitFor({ timeout: 10000 })
  await win.getByRole('dialog').getByRole('button', { name: 'Commit' }).click()
  await win.waitForTimeout(1000)
  check('disconnect committed first', (await count()) === 2 && (await bar().count()) === 0)
  await win.getByText('Manual PG', { exact: true }).first().dblclick()
  await win.locator('.cm-content:visible').first().waitFor({ timeout: 15000 })

  // Renaming the connection needs no new connection: the open transaction stays.
  await run('INSERT INTO tx_e2e VALUES (6)')
  await bar().waitFor({ timeout: 10000 })
  const saved = (await api('listConnections')).find((c) => c.name === 'Manual PG')
  await win.evaluate((c) => window.mastermind.api.saveConnection({ ...c, color: '#e5484d' }), saved)
  await run('INSERT INTO tx_e2e VALUES (7)')
  check('saving a color keeps the transaction', /2 changes/.test(await bar().innerText()))

  // Quitting with it open: the app asks (answered Commit here).
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
  })
  await app.close()
  check('quitting committed the open transaction', (await count()) === 4)
  console.log('errors:', errors.length ? errors : 'none')
} catch (err) {
  await win.screenshot({ path: `${out}/r98-failure.png` }).catch(() => {})
  console.log('errors:', errors)
  await app.close().catch(() => {})
  throw err
} finally {
  await pool.end()
}

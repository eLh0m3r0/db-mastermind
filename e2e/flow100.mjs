// Another database on the same PostgreSQL server: "Open another database…" in the connection's menu lists the server's
// databases, makes a connection of its own for the picked one (settings copied, explorer choices not), opens it and its
// queries run there; picking the first database again goes back to its connection (no duplicate); a password typed
// for this session (not saved) opens the new database without asking again. Needs `npm run db:up` (postgres).
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'

const out = process.argv[2] ?? tmpdir()
// A database no connection exists for yet (the typed-password case makes one for it).
const admin = new pg.Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'postgres' })
await admin.connect()
await admin.query('DROP DATABASE IF EXISTS dbm_picker_test')
await admin.query('CREATE DATABASE dbm_picker_test')
await admin.end()
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui100-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const check = (label, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) process.exitCode = 1
}
const header = () => win.locator('button').filter({ has: win.locator('svg.lucide-chevron-down') }).filter({ hasText: /PG/ }).first()
const openPicker = async () => {
  await header().click()
  await win.getByText('Open another database…', { exact: true }).click()
  await win.getByRole('listbox', { name: 'Databases' }).waitFor({ timeout: 10000 })
  await win.locator('[data-database]').first().waitFor({ timeout: 10000 })
}
const runQuery = async (sql) => {
  const editor = win.locator('.cm-content:visible').first()
  await editor.waitFor({ timeout: 15000 })
  await editor.click()
  await win.keyboard.press('ControlOrMeta+a')
  await win.keyboard.insertText(sql)
  await win.keyboard.press('ControlOrMeta+Enter')
  await win.waitForTimeout(900)
}
try {
  await win.waitForTimeout(800)
  await api('saveConnection', { id: '', name: 'Server PG', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind', color: '#0f9f6e', environment: 'test', manualCommit: true, pinnedTables: ['shop.customers'] })
  await win.reload()
  await win.getByText('Server PG', { exact: true }).first().dblclick()
  await win.locator('.cm-content:visible').first().waitFor({ timeout: 15000 })

  await openPicker()
  const names = await win.locator('[data-database]').evaluateAll((els) => els.map((e) => e.getAttribute('data-database')))
  check('the picker lists the server’s databases', names.includes('mastermind') && names.includes('postgres'))
  check('the current one is marked', (await win.locator('[data-database="mastermind"][aria-selected="true"]').count()) === 1)
  await win.screenshot({ path: `${out}/r100-picker.png` })
  await win.getByPlaceholder('Search databases…').fill('postg')
  check('search narrows the list', (await win.locator('[data-database]').count()) === 1)
  await win.getByPlaceholder('Search databases…').press('Enter')
  await win.waitForTimeout(1500)

  const list = await api('listConnections')
  const made = list.find((c) => c.database === 'postgres')
  check('a connection of its own was made', !!made && made.name === 'Server PG / postgres')
  check('it took the settings, not the explorer choices', made?.color === '#0f9f6e' && made?.manualCommit === true && made?.environment === 'test' && !made?.pinnedTables)
  check('it is open and selected', /\/postgres/.test(await header().innerText()))
  await runQuery('SELECT current_database() AS db')
  check('its queries run in that database', (await win.getByText('postgres', { exact: true }).count()) > 0 && (await win.locator('[role=gridcell], div').filter({ hasText: /^postgres$/ }).count()) > 0)
  await win.screenshot({ path: `${out}/r100-other.png` })

  // Back to the first database: its own connection again, no duplicate.
  await openPicker()
  check('the first database shows its connection', (await win.locator('[data-database="mastermind"]').innerText()).includes('Server PG'))
  await win.locator('[data-database="mastermind"]').click()
  await win.waitForTimeout(1200)
  check('picking it goes back to its connection', /\/mastermind/.test(await header().innerText()) && (await api('listConnections')).length === 2)

  // A password typed for this session only.
  await api('saveConnection', { id: '', name: 'NoPass PG', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', database: 'mastermind' })
  await win.reload()
  await win.waitForTimeout(800)
  await win.getByRole('button', { name: 'All connections' }).first().click()
  await win.getByText('NoPass PG', { exact: true }).first().dblclick()
  await win.locator('input[type=password]').last().waitFor({ timeout: 15000 })
  await win.locator('input[type=password]').last().fill('mastermind')
  // (Not saved: the checkbox stays off.)
  const save = win.getByRole('checkbox', { name: /Save/ })
  if (await save.count()) await save.uncheck()
  await win.getByRole('button', { name: 'Connect', exact: true }).click()
  await win.locator('.cm-content:visible').first().waitFor({ timeout: 15000 })
  await openPicker()
  await win.locator('[data-database="dbm_picker_test"]').click()
  await win.waitForTimeout(2000)
  check('a typed password opens the other database without asking again', (await win.locator('input[type=password]').count()) === 0 && /\/dbm_picker_test/.test(await header().innerText()))
  const typed = (await api('listConnections')).find((c) => c.name === 'NoPass PG / dbm_picker_test')
  check('the typed password is not saved with it', !!typed && !typed.password)
  console.log('errors:', errors.length ? errors : 'none')
} catch (err) {
  await win.screenshot({ path: `${out}/r100-failure.png` }).catch(() => {})
  console.log('errors:', errors)
  throw err
} finally {
  await app.close()
}

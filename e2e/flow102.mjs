// SQL files on disk (Milestone 11, A2): a .sql file handed to the app at start waits until a connection is
// selected and then opens in a query tab named after the file; ⌘S writes it back (keeping its CRLF line ends);
// a change made by another program reloads the tab when it has nothing unsaved, and is only offered when it has;
// the Save query dialog can turn a scratch tab into a file. Needs `npm run db:up` (postgres).
import { _electron as electron } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? tmpdir()
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui102-'))
const file = join(dir, 'report.sql')
writeFileSync(file, 'SELECT 1 AS one;\r\n')
const env = { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' }

// First start: create the connection, so the second start (with the file) has one to pick.
{
  const app = await electron.launch({ args: ['apps/desktop'], env })
  const win = await app.firstWindow()
  await win.waitForTimeout(800)
  await win.evaluate(() => window.mastermind.api.saveConnection({ id: '', name: 'Files PG', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' }))
  await app.close()
}

const app = await electron.launch({ args: ['apps/desktop', file], env })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const check = (label, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) process.exitCode = 1
}
const editor = () => win.locator('.cm-content:visible').first()
const touch = (path, text) => {
  writeFileSync(path, text)
  const later = new Date(Date.now() + 10_000)
  utimesSync(path, later, later)
}
try {
  await win.getByText('Select a connection to open report.sql').waitFor({ timeout: 15000 })
  check('a file handed to the app without a selected connection waits for one', (await win.getByRole('tab').filter({ hasText: 'report.sql' }).count()) === 0)
  await win.getByText('Files PG', { exact: true }).first().dblclick()
  await win.getByRole('tab').filter({ hasText: 'report.sql' }).waitFor({ timeout: 15000 })
  check('selecting a connection opens the file in a tab named after it', (await editor().innerText()).includes('SELECT 1 AS one;'))

  await editor().click()
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.insertText('\nSELECT 2 AS two;')
  await win.waitForTimeout(500)
  await win.keyboard.press('ControlOrMeta+s')
  await win.waitForTimeout(800)
  check('⌘S writes the file back with its own CRLF line ends', readFileSync(file, 'utf8') === 'SELECT 1 AS one;\r\nSELECT 2 AS two;')
  check('no Save query dialog for a file tab', (await win.getByRole('dialog').count()) === 0)

  // Another program changes the file while the tab has nothing unsaved: it reloads when the window gets focus.
  touch(file, 'SELECT 3 AS three;\n')
  await win.evaluate(() => window.dispatchEvent(new Event('focus')))
  await win.waitForTimeout(1000)
  check('an outside change reloads a tab without unsaved changes', (await editor().innerText()).includes('SELECT 3 AS three;'))

  // With unsaved changes it is only offered.
  await editor().click()
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.insertText(' -- mine')
  await win.waitForTimeout(500)
  touch(file, 'SELECT 4 AS four;\n')
  await win.evaluate(() => window.dispatchEvent(new Event('focus')))
  await win.getByText('“report.sql” was changed on disk').waitFor({ timeout: 5000 })
  check('with unsaved changes the tab keeps its text', (await editor().innerText()).includes('-- mine'))
  await win.getByRole('button', { name: 'Reload from disk' }).click()
  await win.waitForTimeout(800)
  check('Reload from disk takes the file’s text', (await editor().innerText()).includes('SELECT 4 AS four;'))
  await win.screenshot({ path: `${out}/r102-file-tab.png` })

  // A scratch query: the Save query dialog offers a .sql file instead.
  await win.keyboard.press('ControlOrMeta+t')
  await win.waitForTimeout(500)
  await win.keyboard.press('ControlOrMeta+s')
  await win.getByTestId('save-as-sql-file').waitFor({ timeout: 5000 })
  await win.screenshot({ path: `${out}/r102-save-dialog.png` })
  check('the Save query dialog links to saving a .sql file', await win.getByTestId('save-as-sql-file').isVisible())
  await win.keyboard.press('Escape')
  check('no page errors', errors.length === 0)
  if (errors.length) console.log(errors)
} catch (err) {
  console.log('FAIL', err)
  await win.screenshot({ path: `${out}/r102-failure.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await app.close()
}

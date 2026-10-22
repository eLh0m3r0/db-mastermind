// "Query a file" on a SQLite database file opens it as a connection (it used to run read_csv on it and fail).
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui75-'))
const file = join(dir, 'notes.db')
const db = new DatabaseSync(file)
db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT); INSERT INTO notes (title) VALUES ('Ahoj');")
db.close()
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: dir, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
try {
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }) }, file)
  await win.waitForTimeout(800)
  await win.getByRole('button', { name: /Query a file/ }).first().click()
  await win.getByText('notes', { exact: true }).waitFor({ timeout: 15000 })
  const list = await win.evaluate(() => window.mastermind.api.listConnections())
  console.log('connection:', JSON.stringify(list.map((c) => [c.name, c.driver])), '| query tab open:', await win.locator('.cm-content:visible').count(), '| error shown:', await win.getByText(/sniffing|read_csv/).count())
  // Twice: the same connection is reused.
  await win.getByRole('button', { name: 'All connections' }).click()
  await win.getByRole('button', { name: /Query a file/ }).first().click()
  await win.waitForTimeout(1500)
  console.log('connections after opening it again:', (await win.evaluate(() => window.mastermind.api.listConnections())).length)
  console.log('errors:', errors.length ? errors : 'none')
} finally {
  await app.close()
}

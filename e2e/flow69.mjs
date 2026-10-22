// Import from DBeaver (folders become groups) and .pgpass; a PostgreSQL connection without a saved password connects
// with the password from ~/.pgpass, as psql and pgAdmin do, instead of asking.
import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const home = mkdtempSync(join(tmpdir(), 'dbm-ui69-'))
writeFileSync(join(home, '.pgpass'), '127.0.0.1:54329:mastermind:postgres:mastermind\n', { mode: 0o600 })
const dbeaver = process.platform === 'darwin' ? join(home, 'Library', 'DBeaverData') : process.platform === 'win32' ? join(home, 'AppData', 'Roaming', 'DBeaverData') : join(home, '.local', 'share', 'DBeaverData')
const dir = join(dbeaver, 'workspace6', 'General', '.dbeaver')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'data-sources.json'), JSON.stringify({ folders: { Work: {} }, connections: { 'pg-1': { provider: 'postgresql', driver: 'postgres-jdbc', name: 'DBeaver PG', folder: 'Work', configuration: { host: '127.0.0.1', port: '54329', database: 'mastermind', user: 'postgres' } } } }))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: home, APPDATA: join(home, 'AppData', 'Roaming'), DBM_USER_DATA: join(home, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  await win.getByRole('button', { name: /Import connections/ }).first().click()
  console.log('import menu:', (await win.locator('[role=menuitem]').allInnerTexts()).join(' | '))
  await win.getByRole('menuitem', { name: /DBeaver/ }).click()
  await win.waitForTimeout(1000)
  const c = (await api('listConnections')).find((x) => x.name === 'DBeaver PG')
  console.log('imported:', c.name, '| group:', c.group, '| saved password:', !!c.password)
  await win.getByText('DBeaver PG', { exact: true }).first().dblclick()
  await win.getByPlaceholder(/Filter .+ tables/).waitFor({ timeout: 20000 })
  console.log('connected with the .pgpass password, password prompt shown:', await win.getByText(/Password for/).count())
  console.log('errors:', errors.length ? errors : 'none')
} finally {
  await app.close()
}

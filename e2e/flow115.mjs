// Connections from a project (Milestone 12, A4): a project folder with a .env (its password as a variable) and a
// docker-compose.yml (PostgreSQL publishing 54329) is imported through Import connections → From a project folder:
// one connection (the .env's DATABASE_URL names the compose service, so they are the same), with the password, and
// opening it connects to the test container without asking for one. A second project's .env is imported through
// From a file…; importing the first again adds nothing. Needs `npm run db:up` (postgres).
import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? tmpdir()
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui115-'))
const shop = join(dir, 'shop-app')
mkdirSync(shop)
writeFileSync(join(shop, '.env'), '# local development\nDB_PASSWORD=mastermind\nDATABASE_URL="postgresql://postgres:${DB_PASSWORD}@db:5432/mastermind"\nREDIS_URL=redis://localhost:6379\n')
writeFileSync(join(shop, 'docker-compose.yml'), 'services:\n  db:\n    image: postgres:17-alpine\n    environment:\n      POSTGRES_PASSWORD: ${DB_PASSWORD}\n      POSTGRES_DB: mastermind\n    ports:\n      - "54329:5432"\n  cache:\n    image: redis:7\n')
const api = join(dir, 'billing-api')
mkdirSync(api)
writeFileSync(join(api, '.env.local'), 'export PGHOST=127.0.0.1\nexport PGPORT=54329\nexport PGUSER=postgres\nexport PGPASSWORD=mastermind\nexport PGDATABASE=mastermind\n')

const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` (${detail})`}`)
  if (!ok) process.exitCode = 1
}
const pick = (path) => app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, path)
const importMenu = async (item) => {
  // (From the list of all connections, where the import menu is.)
  await win.getByRole('button', { name: 'All connections' }).first().click()
  await win.waitForTimeout(300)
  await win.getByRole('button', { name: 'Import connections' }).filter({ visible: true }).first().click()
  await win.getByRole('menuitem', { name: item }).click()
}
const names = () => win.evaluate(async () => (await window.mastermind.api.listConnections()).map((c) => c.name).sort())
try {
  await win.waitForTimeout(800)
  await pick(shop)
  await importMenu('From a project folder… (.env, docker-compose, Prisma)')
  await win.getByText('Imported 1 connection from shop-app').waitFor({ timeout: 10000 })
  check('a project folder: its connection, once', JSON.stringify(await names()) === JSON.stringify(['shop-app — db']), JSON.stringify(await names()))
  await win.screenshot({ path: `${out}/r115-imported.png` })

  // Opened: it connects with the password from the .env, nothing asked.
  await win.getByText('shop-app — db', { exact: true }).first().dblclick()
  await win.getByPlaceholder(/Filter \d+ tables/).waitFor({ timeout: 20000 })
  check('it connects to the container with the imported password', (await win.getByText(/Password for/).count()) === 0)
  await win.screenshot({ path: `${out}/r115-connected.png` })

  // Another project's .env through From a file….
  await pick(join(api, '.env.local'))
  await importMenu('From a file… (.env, docker-compose, export of DB Mastermind, pgAdmin, DataGrip, Workbench, SSMS…)')
  await win.getByText('Imported 1 connection', { exact: true }).waitFor({ timeout: 10000 })
  check('a .env file: its PG* set', (await names()).includes('billing-api — PGHOST'), JSON.stringify(await names()))
  const billing = await win.evaluate(async () => (await window.mastermind.api.listConnections()).find((c) => c.name === 'billing-api — PGHOST'))
  check('…with host, port, user and database', billing?.host === '127.0.0.1' && billing?.port === 54329 && billing?.user === 'postgres' && billing?.database === 'mastermind', JSON.stringify(billing && { host: billing.host, port: billing.port, user: billing.user, database: billing.database }))
  const test = await win.evaluate(async (id) => {
    try {
      const c = (await window.mastermind.api.listConnections()).find((x) => x.id === id)
      return (await window.mastermind.api.connect(c.id))?.serverInfo?.product ?? 'no'
    } catch (err) {
      return String(err?.message ?? err)
    }
  }, billing?.id)
  check('…and it connects too', test === 'PostgreSQL', test)

  // A path the page names by itself (not dropped, picked or given on the command line) is not read.
  const unasked = join(dir, 'unasked')
  mkdirSync(unasked)
  writeFileSync(join(unasked, '.env'), 'DATABASE_URL=postgres://x:y@localhost/z\n')
  const refused = await win.evaluate(async (path) => {
    try {
      await window.mastermind.api.importProjectConnections(path)
      return 'read'
    } catch (err) {
      return String(err?.message ?? err)
    }
  }, unasked)
  check('a folder the user did not hand to the app is not read', /through the app/.test(refused), refused)
  const json = await win.evaluate(async (path) => window.mastermind.api.isModelFile(path).then(() => 'read', (err) => String(err?.message ?? err)), join(unasked, 'x.json'))
  check('…nor a .json file', /through the app/.test(json), json)

  // The same project again: nothing new.
  await pick(shop)
  await importMenu('From a project folder… (.env, docker-compose, Prisma)')
  await win.getByText('The connections of shop-app are already here').waitFor({ timeout: 10000 })
  check('importing again adds nothing', (await names()).length === 2)
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  process.exitCode = 1
  await win.screenshot({ path: `${out}/r115-error.png` }).catch(() => {})
} finally {
  check('no page errors', errors.length === 0, JSON.stringify(errors.slice(0, 3)))
  await app.close()
}

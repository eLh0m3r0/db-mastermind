// Import menu lists the database tools found on this computer, with counts.
import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const home = mkdtempSync(join(tmpdir(), 'dbm-ui57-'))
const support = join(home, 'Library', 'Application Support')
mkdirSync(join(home, '.pgadmin'))
const pg = new DatabaseSync(join(home, '.pgadmin', 'pgadmin4.db'))
pg.exec("CREATE TABLE server (id INTEGER, name TEXT, host TEXT, port INTEGER, maintenance_db TEXT, username TEXT, connection_params TEXT); INSERT INTO server VALUES (1, 'Prod PG', 'pg.corp', 5432, 'postgres', 'an', '{\"sslmode\":\"require\"}'), (2, 'Dev PG', 'localhost', 5433, 'app', 'me', NULL)")
pg.close()
mkdirSync(join(support, 'MySQL', 'Workbench'), { recursive: true })
writeFileSync(join(support, 'MySQL', 'Workbench', 'connections.xml'), `<data><value type="list"><value type="object" struct-name="db.mgmt.Connection" id="a"><value type="dict" key="parameterValues"><value type="string" key="hostName">my.corp</value><value type="int" key="port">3306</value><value type="string" key="userName">root</value></value><value type="string" key="name">Shop MySQL</value></value></value></data>`)
mkdirSync(join(support, 'Code', 'User'), { recursive: true })
writeFileSync(join(support, 'Code', 'User', 'settings.json'), `{ // editor\n "sqltools.connections": [{ "name": "Local", "driver": "PostgreSQL", "server": "localhost", "database": "x", "username": "u" }], }`)
mkdirSync(join(support, 'azuredatastudio', 'User'), { recursive: true })
writeFileSync(join(support, 'azuredatastudio', 'User', 'settings.json'), `{ "datasource.connections": [{ "options": { "server": "sql01", "database": "ERP", "authenticationType": "Integrated" }, "providerName": "MSSQL" }] }`)
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: home, DBM_USER_DATA: join(home, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
try {
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: 'Import connections' }).first().click()
  await win.waitForTimeout(800)
  console.log('menu:', (await win.getByText(/^From .* \(\d+\)$/).allInnerTexts()).join(' | '))
  await win.screenshot({ path: `${out}/r21-import-menu.png` })
  await win.getByText('From pgAdmin 4 (2)').click()
  await win.waitForTimeout(800)
  await win.getByRole('button', { name: 'Import connections' }).first().click()
  await win.getByText('From Azure Data Studio (1)').click()
  await win.waitForTimeout(800)
  const list = await win.evaluate(() => window.mastermind.api.listConnections())
  console.log('imported:', JSON.stringify(list.map((c) => [c.name, c.driver, c.host, c.port, c.ssl?.mode ?? null, c.options?.authentication ?? null])))
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/r21-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

// Import connections from DataGrip's global data sources.
import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const home = mkdtempSync(join(tmpdir(), 'dbm-ui47-'))
const opts = join(home, 'Library', 'Application Support', 'JetBrains', 'DataGrip2025.2', 'options')
mkdirSync(opts, { recursive: true })
writeFileSync(join(opts, 'dataSources.xml'), `<application><component name="DataSourceManagerImpl" format="xml" multifile-model="true">
<data-source source="LOCAL" name="Shop prod" uuid="u1"><driver-ref>postgresql</driver-ref><jdbc-url>jdbc:postgresql://pg.corp:5432/shop</jdbc-url></data-source>
<data-source source="LOCAL" name="Oracle ERP" uuid="u2"><jdbc-url>jdbc:oracle:thin:@ora.corp:1521/ERP</jdbc-url></data-source>
</component></application>`)
writeFileSync(join(opts, 'dataSources.local.xml'), `<application><component name="dataSourceStorageLocal"><data-source name="Shop prod" uuid="u1"><user-name>analyst</user-name></data-source></component></application>`)
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: home, DBM_USER_DATA: join(home, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
try {
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: 'Import connections' }).click()
  await win.getByText('From DataGrip / IntelliJ').click()
  await win.waitForTimeout(800)
  const list = await win.evaluate(() => window.mastermind.api.listConnections())
  console.log(JSON.stringify(list.map((c) => [c.name, c.driver, c.host, c.port, c.database, c.user ?? null])))
  console.log('toast:', await win.getByText(/Imported 2 connections/).count())
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: '../shots/r15-error.png' })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

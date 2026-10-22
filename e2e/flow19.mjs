// Users & roles on PostgreSQL.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: mkdtempSync(join(tmpdir(), 'dbm-ui19-')), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  const conn = await api('saveConnection', { id: '', name: 'Dev (Postgres)', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' })
  await api('runQuery', { runId: 'r', connectionId: conn.id, sql: "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analysts') THEN CREATE ROLE analysts; END IF; END $$; GRANT USAGE ON SCHEMA shop TO analysts; GRANT SELECT ON ALL TABLES IN SCHEMA shop TO analysts; DROP ROLE IF EXISTS jana; CREATE ROLE jana LOGIN IN ROLE analysts; GRANT UPDATE (name) ON shop.customers TO jana;" })
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Dev \(Postgres\)/ }).first().click()
  await win.waitForTimeout(1500)
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('Users & roles')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(1500)
  await win.getByRole('button', { name: 'jana' }).first().click()
  await win.waitForTimeout(1200)
  console.log('column grant shown:', await win.getByText('shop.customers.name').count())
  await win.getByRole('button', { name: 'analysts' }).first().click()
  await win.waitForTimeout(1500)
  await win.screenshot({ path: `${out}/e0-roles.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/99-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

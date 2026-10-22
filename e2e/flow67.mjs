// SQL editor: a result cut at the row limit offers "Load all rows" (same statement, no limit), and a cancelled
// query is shown as cancelled, not as an error (no red, no Fix with AI). Needs the postgres service.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui67-'))
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: dir, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const editor = () => win.locator('.cm-content:visible').first()
const typeSql = async (sql) => {
  await editor().click()
  await win.keyboard.press(`${mod}+a`)
  await win.keyboard.press('Backspace')
  await win.keyboard.insertText(sql)
}
try {
  await win.waitForTimeout(800)
  await api('saveConnection', { id: '', name: 'PG', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' })
  await api('updateSettings', { maxResultRows: 1000 })
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByText('PG', { exact: true }).first().dblclick()
  await editor().waitFor()
  await typeSql('select g from generate_series(1, 5000) g;')
  await win.keyboard.press(`${mod}+Enter`)
  await win.getByRole('button', { name: 'Load all rows' }).click({ timeout: 15000 })
  await win.getByText(/5[\s ,]?000/).first().waitFor({ timeout: 15000 })
  console.log('limit warning after Load all:', await win.getByText(/^First /).count())
  await typeSql('select pg_sleep(20);')
  await win.keyboard.press(`${mod}+Enter`)
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Cancel/ }).first().click()
  await win.getByText('Cancelled', { exact: true }).waitFor({ timeout: 10000 })
  console.log('Fix with AI after cancel:', await win.getByRole('button', { name: 'Fix with AI' }).count())
  console.log('errors:', errors.length ? errors : 'none')
} finally {
  await app.close()
}

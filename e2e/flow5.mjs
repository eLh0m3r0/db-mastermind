import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const userData = mkdtempSync(join(tmpdir(), 'dbm-ui5-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: userData, DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  const pg = await api('saveConnection', { id: '', name: 'Dev (Postgres)', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' })
  await api('saveConnection', { id: '', name: 'Prod (MySQL)', driver: 'mysql', host: '127.0.0.1', port: 33069, user: 'root', password: 'mastermind', database: 'mastermind' })
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Prod \(MySQL\)/ }).first().click()
  await win.waitForTimeout(2000)
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('Compare schemas')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(500)
  await win.locator('select').first().selectOption({ label: 'Dev (Postgres)' })
  await win.waitForTimeout(300)
  await win.getByRole('button', { name: 'Compare', exact: true }).click()
  await win.waitForTimeout(3000)
  await win.screenshot({ path: `${out}/40-compare.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/99-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

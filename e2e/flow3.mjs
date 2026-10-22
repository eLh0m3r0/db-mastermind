import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2]
const userData = mkdtempSync(join(tmpdir(), 'dbm-ui3-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: userData, DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
win.on('dialog', (d) => d.accept())
const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])

try {
  await win.waitForTimeout(800)
  await api('saveConnection', { id: '', name: 'Shop PG', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' })
  await win.reload()
  await win.waitForTimeout(800)
  await win.getByRole('button', { name: /Shop PG/ }).first().click()
  await win.getByPlaceholder(/Filter \d+ tables/).waitFor({ timeout: 20000 })
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('ER diagram')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(2000)
  await win.getByRole('button', { name: 'Design' }).click()
  await win.locator('.react-flow__node', { hasText: 'customers' }).first().click()
  await win.waitForTimeout(400)
  await win.getByRole('button', { name: 'Add' }).first().click()
  await win.waitForTimeout(200)
  const nameInputs = win.locator('input[value^="column_"]')
  await nameInputs.last().fill('phone')
  await win.locator('input[value="email"]').first().fill('email_address')
  await shot('20-designer-edit')
  await win.getByRole('button', { name: 'New table' }).click()
  await win.waitForTimeout(400)
  await win.locator('input[value^="new_table_"]').fill('payments')
  await win.waitForTimeout(300)
  await shot('21-designer-new-table')
  await win.getByRole('button', { name: /Review migration/ }).click()
  await win.waitForTimeout(1500)
  await shot('22-migration')
  await win.getByRole('button', { name: 'Open in SQL editor' }).click()
  await win.waitForTimeout(800)
  await win.keyboard.press('Meta+Shift+Enter')
  await win.waitForTimeout(2500)
  await shot('23-migration-run')
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await shot('99-error')
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 10), null, 1))
  await app.close()
}

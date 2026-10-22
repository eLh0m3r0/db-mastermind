// Text prompts use the app's own dialog (Electron has no window.prompt, so Rename tab and saving a change set did
// nothing), a new designer table starts with its name selected, foreign keys can't point at views, and a T-SQL
// batch with DDL (as the migration runs it) reloads the explorer.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const home = mkdtempSync(join(tmpdir(), 'dbm-ui71-'))
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: home, DBM_USER_DATA: join(home, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
await win.setViewportSize({ width: 1400, height: 900 })
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  const pg = await api('saveConnection', { id: '', name: 'PG', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' })
  await win.reload()
  await win.waitForTimeout(900)
  await win.getByText('PG', { exact: true }).first().dblclick()
  await win.getByPlaceholder(/Filter .+ tables/).waitFor({ timeout: 20000 })
  await win.getByText('Query 1').first().click({ button: 'right' })
  await win.getByText('Rename…').click()
  await win.waitForFunction(() => document.activeElement?.closest('[role=dialog]') && document.activeElement.tagName === 'INPUT', null, { timeout: 5000 })
  await win.keyboard.type('Reports')
  await win.keyboard.press('Enter')
  console.log('tab renamed by typing over the old name:', (await win.getByText('Reports', { exact: true }).count()) === 1)

  await win.keyboard.press(`${mod}+k`)
  await win.keyboard.type('Open ER diagram')
  await win.keyboard.press('Enter')
  await win.locator('.react-flow__node').first().waitFor({ timeout: 20000 })
  await win.locator('select').filter({ has: win.locator('option[value="shop"]') }).first().selectOption('shop')
  await win.waitForTimeout(800)
  await win.getByRole('button', { name: /^Design$/ }).click()
  await win.getByRole('button', { name: /New table/ }).click()
  await win.waitForTimeout(400)
  await win.keyboard.type('p2_receipts')
  console.log('typing names the new table:', (await win.locator('.react-flow__node-table', { hasText: 'p2_receipts' }).count()) === 1)
  await win.getByText('Foreign keys', { exact: true }).locator('xpath=..').getByRole('button', { name: /Add/ }).click()
  const targets = await win.locator('select.h-6').nth(1).locator('option').allInnerTexts()
  console.log('views offered as FK targets:', targets.includes('vip_customers'))

  await win.getByRole('button', { name: /Change sets/ }).click()
  await win.getByRole('menuitem', { name: /Save these changes as/ }).click()
  await win.waitForFunction(() => document.activeElement?.closest('[role=dialog]') && document.activeElement.tagName === 'INPUT', null, { timeout: 5000 })
  await win.keyboard.type('Invoices')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(400)
  const sets = (await api('listChangeSets', pg.id)).map((c) => c.name)
  console.log('change set saved:', sets.includes('Invoices'), sets)
  console.log('errors:', errors.length ? errors : 'none')
} finally {
  await app.close()
}

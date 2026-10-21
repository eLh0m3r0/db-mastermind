import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2]
const userData = mkdtempSync(join(tmpdir(), 'dbm-ui2-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: userData, DBM_NO_UPDATE_CHECK: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])

try {
  await win.waitForTimeout(800)
  const pg = await api('saveConnection', { id: '', name: 'Shop PG', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind', color: '#0f9f6e' })
  await api('saveConnection', { id: '', name: 'Sales MSSQL', driver: 'mssql', host: '127.0.0.1', port: 14339, user: 'sa', password: 'Mastermind!2026', database: 'mastermind', options: { trustServerCertificate: true }, environment: 'production' })
  await api('updateSettings', { ai: { activeProvider: 'claude-code', providers: [{ id: 'claude-code', enabled: true }], dataSharing: 'schema-and-samples', autoRunReadQueries: true } })
  await win.reload()
  await win.waitForTimeout(1200)
  await shot('10-home-with-connections')

  // Postgres: open customers, edit a cell, review, apply
  await win.getByRole('button', { name: /Shop PG/ }).first().click()
  await win.getByPlaceholder(/Filter \d+ tables/).waitFor({ timeout: 20000 })
  await win.getByPlaceholder(/Filter \d+ tables/).fill('customers')
  await win.getByPlaceholder(/Filter \d+ tables/).press('Enter')
  await win.waitForTimeout(1200)
  const grid = win.locator('[tabindex="0"].overflow-auto').last()
  const cell = win.getByText('Alice', { exact: true }).first()
  await cell.dblclick()
  await win.keyboard.press('Meta+a')
  await win.keyboard.type('Alice Liddell')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(300)
  await shot('11-pending-edit')
  await win.getByRole('button', { name: 'Review' }).click()
  await win.waitForTimeout(300)
  await shot('12-review')
  await win.getByRole('button', { name: /^Apply 1 statement/ }).click()
  await win.waitForTimeout(1200)
  await shot('13-applied')

  // FK navigation from orders
  await win.getByPlaceholder(/Filter \d+ tables/).fill('orders')
  await win.getByPlaceholder(/Filter \d+ tables/).press('Enter')
  await win.waitForTimeout(1200)
  await win.getByTitle('Open referenced row').first().click()
  await win.waitForTimeout(1500)
  await shot('14-fk-navigation')

  // Knowledge base
  await win.getByTitle('Knowledge base').click()
  await win.waitForTimeout(500)
  await win.getByRole('button', { name: 'Create knowledge base' }).click()
  await win.waitForTimeout(800)
  await shot('15-knowledge')

  // AI assistant via Claude Code subscription
  await win.keyboard.press('Meta+j')
  await win.waitForTimeout(500)
  await win.getByPlaceholder(/Ask about/).fill('Which customer has the highest total order value? Answer briefly and show the SQL.')
  await win.getByPlaceholder(/Ask about/).press('Enter')
  await win.getByText('Thinking…').waitFor({ state: 'detached', timeout: 180000 })
  await win.waitForTimeout(500)
  await shot('16-ai')

  // SQL Server
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('connect Sales MSSQL')
  await win.keyboard.press('Enter')
  await win.getByPlaceholder(/Filter \d+ tables/).waitFor({ timeout: 30000 })
  await win.waitForTimeout(1500)
  await win.locator('.cm-content').last().click()
  await win.keyboard.type('select top 5 c.name, o.total, o.ordered_on from shop.orders o join shop.customers c on c.id = o.customer_id order by o.total desc')
  await win.keyboard.press('Meta+Enter')
  await win.waitForTimeout(2500)
  await shot('17-mssql')
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await shot('99-error')
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 10), null, 1))
  await app.close()
}

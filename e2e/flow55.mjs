// Team AI tools: create tools/*.sql from the knowledge base view; the assistant can call it.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: mkdtempSync(join(tmpdir(), 'dbm-ui55-')), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
await app.evaluate(({ shell }) => { shell.showItemInFolder = () => {} })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  await api('updateSettings', { ai: { providers: [{ id: 'claude-code', enabled: true, model: 'haiku' }], activeProvider: 'claude-code', dataSharing: 'full', autoRunReadQueries: true } })
  const id = await api('createSampleDatabase')
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Demo coffee shop/ }).first().click()
  await win.waitForTimeout(1500)
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('knowledge base')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(1200)
  await win.getByRole('button', { name: 'AI tools (tools/*.sql)' }).click()
  await win.getByText('New AI tool…').click()
  await win.waitForTimeout(800)
  const conn = (await api('listConnections')).find((c) => c.id === id)
  const path = join(conn.knowledgeBasePath, 'tools', 'new_tool.sql')
  writeFileSync(path, readFileSync(path, 'utf8').replace('-- tool: new_tool', '-- tool: customer_order_count').replace(/-- description: .*/, '-- description: Number of orders a customer placed').replace(/SELECT \*\nFROM customers\nWHERE id = :customer_id/, 'SELECT count(*) AS orders FROM orders WHERE customer_id = :customer_id'))
  console.log('listed:', JSON.stringify(await api('listTeamTools', id)))
  await win.keyboard.press('Meta+j')
  await win.waitForTimeout(500)
  const box = win.getByPlaceholder(/Ask/).last()
  await box.fill('Use the customer_order_count tool to tell me how many orders customer 7 placed. Answer with just the number.')
  await box.press('Enter')
  await win.getByText(/customer_order_count/).first().waitFor({ timeout: 180000 })
  await win.waitForTimeout(20000)
  const sql = await api('runQuery', { connectionId: id, sql: 'SELECT count(*) FROM orders WHERE customer_id = 7', runId: 'x' })
  console.log('expected:', JSON.stringify(sql[0].results[0].rows[0]))
  await win.screenshot({ path: `${out}/r19-team-tool.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/r19-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

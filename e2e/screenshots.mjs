// Regenerates the README screenshots from the demo database: `node e2e/screenshots.mjs [--ai]`
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = 'docs/screenshots'
const withAi = process.argv.includes('--ai')
const userData = mkdtempSync(join(tmpdir(), 'dbm-shots-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: userData, DBM_NO_UPDATE_CHECK: '1' } })
const win = await app.firstWindow()
win.on('dialog', (d) => d.accept())
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const shot = async (name) => {
  await win.waitForTimeout(400)
  await win.screenshot({ path: `${out}/${name}.png` })
}
/** Switches theme through the command palette, like a user would. */
const theme = async (t) => {
  const isDark = await win.evaluate(() => document.documentElement.classList.contains('dark'))
  if (isDark === (t === 'dark')) return
  await win.keyboard.press('Escape')
  await win.keyboard.press('Meta+k')
  await win.keyboard.type(t === 'dark' ? 'Switch to dark theme' : 'Switch to light theme')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(300)
}

await win.waitForTimeout(800)
await theme('light')
await shot('home')

// Table browser with filters (dark)
await win.getByRole('button', { name: 'Try the demo database' }).click()
await win.getByPlaceholder(/Filter \d+ tables/).waitFor({ timeout: 20000 })
await theme('dark')
await win.getByPlaceholder(/Filter \d+ tables/).fill('orders')
await win.getByPlaceholder(/Filter \d+ tables/).press('Enter')
await win.waitForTimeout(800)
await win.getByRole('button', { name: /^Filter/ }).click()
await win.locator('select').nth(0).selectOption('status')
await win.locator('select').nth(1).selectOption('in')
await win.getByPlaceholder('comma or newline separated values').fill('paid,shipped')
await win.locator('button', { hasText: /^Condition$/ }).click()
await win.locator('select').nth(2).selectOption('ordered_at')
await win.locator('select').nth(3).selectOption('gte')
await win.getByPlaceholder('value').last().fill('2025-06-01')
await win.getByRole('button', { name: 'Apply' }).click()
await win.waitForTimeout(800)
await win.getByText('Gift wrap, please', { exact: true }).first().click()
await win.getByRole('button', { name: 'Row details' }).click()
await shot('table-filters')

// SQL editor (light)
await theme('light')
await win.keyboard.press('Meta+t')
await win.locator('.cm-content').last().click()
await win.keyboard.type(
  "select substr(o.ordered_at, 1, 7) as month, count(distinct o.id) as orders,\n       round(sum(i.quantity * i.unit_price)) as revenue\n  from orders o join order_items i on i.order_id = o.id\n where o.status <> 'cancelled'\n group by month order by month desc",
  { delay: 2 },
)
await win.keyboard.press('Escape')
await win.keyboard.press('Meta+Enter')
await win.waitForTimeout(800)
await shot('query')
await win.getByRole('button', { name: 'Show chart' }).click()
await win.waitForTimeout(300)
const box = await win.locator('svg[aria-label="Chart of query results"]').boundingBox()
if (box) await win.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5)
await shot('chart')
await win.getByRole('button', { name: 'Show table' }).click()

// ER diagram (light) and designer (dark)
await win.keyboard.press('Meta+k')
await win.keyboard.type('ER diagram')
await win.keyboard.press('Enter')
await win.waitForTimeout(2500)
await shot('diagram')
await theme('dark')
await win.getByRole('button', { name: 'Design' }).click()
await win.locator('.react-flow__node', { hasText: 'customers' }).first().click()
await win.getByRole('button', { name: 'Add' }).first().click()
await win.locator('input[value^="column_"]').last().fill('phone')
await win.locator('input[value="newsletter"]').first().fill('marketing_consent')
await shot('designer')
await win.getByRole('button', { name: /Review migration/ }).click()
await win.waitForTimeout(1200)
await shot('migration')
await win.keyboard.press('Escape')

if (withAi) {
  await api('updateSettings', { ai: { activeProvider: 'claude-code', providers: [{ id: 'claude-code', enabled: true }], dataSharing: 'schema-and-samples', autoRunReadQueries: true } })
  await win.reload()
  await win.waitForTimeout(1500)
  await theme('light')
  await win.keyboard.press('Meta+j')
  await win.getByPlaceholder(/Ask about/).fill('Which product category brings the most revenue? Show the SQL.')
  await win.getByPlaceholder(/Ask about/).press('Enter')
  await win.getByText('Thinking…').waitFor({ state: 'detached', timeout: 240000 })
  await shot('ai')
}
await app.close()
console.log('done')

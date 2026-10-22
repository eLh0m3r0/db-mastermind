// Regenerates the README screenshots from the demo database: `node e2e/screenshots.mjs [--ai]`
// SHOTS_DIR / DBM_LANGUAGE override the output folder and language (the Windows UI tour in CI uses both).
import { _electron as electron } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.env.SHOTS_DIR ?? 'docs/screenshots'
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const withAi = process.argv.includes('--ai')
const userData = mkdtempSync(join(tmpdir(), 'dbm-shots-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: userData, DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: process.env.DBM_LANGUAGE ?? 'en' } })
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
  await win.keyboard.press(`${mod}+k`)
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
await win.keyboard.press(`${mod}+t`)
await win.locator('.cm-content').last().click()
await win.keyboard.type(
  "select substr(o.ordered_at, 1, 7) as month, count(distinct o.id) as orders,\n       round(sum(i.quantity * i.unit_price)) as revenue\n  from orders o join order_items i on i.order_id = o.id\n where o.status <> 'cancelled'\n group by month order by month desc",
  { delay: 2 },
)
await win.keyboard.press('Escape')
await win.keyboard.press(`${mod}+Enter`)
await win.waitForTimeout(800)
await shot('query')
await win.getByRole('button', { name: 'Show chart' }).click()
await win.waitForTimeout(300)
const box = await win.locator('svg[aria-label="Chart of query results"]').boundingBox()
if (box) await win.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5)
await shot('chart')
await win.getByRole('button', { name: 'Show table' }).click()

// ER diagram (light) and designer (dark)
await win.keyboard.press(`${mod}+k`)
await win.keyboard.type('ER diagram')
await win.keyboard.press('Enter')
await win.waitForTimeout(2500)
await shot('diagram')
await win.getByPlaceholder('Focus on table…').fill('customers')
await win.getByPlaceholder('Focus on table…').press('Enter')
await win.waitForTimeout(800)
await win.getByPlaceholder('Join path to…').fill('categories')
await win.waitForTimeout(2000)
await shot('join-path')
await win.getByRole('button', { name: 'Show whole schema' }).click()
await win.waitForTimeout(2000)
await theme('dark')
await win.getByRole('button', { name: 'Design' }).click()
await win.locator('.react-flow__node', { hasText: 'customers' }).first().click()
await win.getByRole('button', { name: 'Add', exact: true }).first().click()
await win.locator('input[value^="column_"]').last().fill('phone')
await win.locator('input[value="newsletter"]').first().fill('marketing_consent')
await shot('designer')
await win.getByRole('button', { name: /Review migration/ }).click()
await win.waitForTimeout(1200)
await shot('migration')
await win.keyboard.press('Escape')

// Query a CSV file with SQL (light): a Czech export with ';' and decimal commas.
await theme('light')
const csv = join(userData, 'prodeje-2026.csv')
const rows = ['datum;pobočka;produkt;množství;cena']
const shops = ['Praha', 'Brno', 'Ostrava', 'Plzeň']
const products = ['Espresso', 'Latte', 'Čaj', 'Dort', 'Croissant']
for (let i = 0; i < 400; i++) rows.push(`2026-${String(1 + (i % 9)).padStart(2, '0')}-${String(1 + (i % 27)).padStart(2, '0')};${shops[i % 4]};${products[(i * 7) % 5]};${1 + ((i * 13) % 6)};${(45 + ((i * 37) % 120)).toFixed(0)},${String((i * 11) % 100).padStart(2, '0')}`)
writeFileSync(csv, rows.join('\n'))
await app.evaluate(({ dialog }, path) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
}, csv)
await win.keyboard.press(`${mod}+k`)
await win.keyboard.type('Query a CSV')
await win.keyboard.press('Enter')
await win.waitForTimeout(2500)
await win.locator('.cm-content').last().click()
await win.keyboard.press(`${mod}+a`)
await win.keyboard.insertText(`SELECT pobočka, produkt, sum(množství * cena) AS tržba\nFROM read_csv('${csv}', decimal_separator = ',')\nGROUP BY ALL\nORDER BY tržba DESC\nLIMIT 10;`)
await win.keyboard.press(`${mod}+Enter`)
await win.waitForTimeout(1500)
await shot('query-file')

if (withAi) {
  await api('updateSettings', { ai: { activeProvider: 'claude-code', providers: [{ id: 'claude-code', enabled: true }], dataSharing: 'schema-and-samples', autoRunReadQueries: true } })
  await win.reload()
  await win.waitForTimeout(1500)
  await theme('light')
  await win.keyboard.press(`${mod}+j`)
  await win.getByPlaceholder(/Ask about/).fill('Which product category brings the most revenue? Show the SQL.')
  await win.getByPlaceholder(/Ask about/).press('Enter')
  await win.getByText('Thinking…').waitFor({ state: 'detached', timeout: 240000 })
  await shot('ai')
}
await app.close()
console.log('done')

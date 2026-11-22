// The Product Hunt gallery: six 1270×760 images of the app (a 1270×760 window, light, English, the release's version)
// and a 240×240 logo, from the same seeded states as the website's screenshots (e2e/screenshots.mjs):
//
//   node e2e/launch-shots.mjs <out-folder> [number…]
//
// Never writes into the repository unless told to. DBM_EXE runs a packaged app; DBM_AI_ENV (OPENROUTER_API_KEY,
// OPENROUTER_MODEL) is needed for image 5, which asks the real model once (skipped without it).
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import {
  askAi,
  closeTab,
  filteredOrders,
  mod,
  modelerState,
  newQuery,
  openDemo,
  palette,
  park,
  quietToasts,
  readAiEnv,
  repo,
  run,
  session,
  setUpOpenRouter,
} from './screenshots.mjs'

const args = process.argv.slice(2)
if (!args[0]) {
  console.error('Usage: node e2e/launch-shots.mjs <out-folder> [number…]')
  process.exit(1)
}
const out = resolve(args[0])
const only = new Set(args.slice(1).map(Number))
mkdirSync(out, { recursive: true })
const size = { width: 1270, height: 760, scale: 1, theme: 'light' }

let failures = 0
async function shot(n, name, fn) {
  if (only.size && !only.has(n)) return
  const ctx = await session(size)
  try {
    await fn(ctx)
    await park(ctx.win)
    await ctx.win.waitForTimeout(500)
    const file = join(out, `${String(n).padStart(2, '0')}-${name}.png`)
    await ctx.win.screenshot({ path: file })
    const png = readFileSync(file)
    const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)]
    console.log(`${file.split('/').pop()} ${w}×${h}${w === 1270 && h === 760 ? '' : '  (not 1270×760)'}`)
  } catch (err) {
    failures++
    console.error(`FAILED ${n} ${name}: ${err.message.split('\n')[0]}`)
    await ctx.win.screenshot({ path: join(out, `_failed-${n}.png`) }).catch(() => {})
  } finally {
    await ctx.close()
  }
}

/** The demo's ER diagram, laid out, the orders tab closed. */
async function diagram(ctx) {
  await openDemo(ctx)
  await closeTab(ctx.win, 'orders')
  await palette(ctx.win, 'ER diagram')
  await ctx.win.locator('.react-flow__node').first().waitFor({ timeout: 15000 })
  await ctx.win.getByRole('button', { name: 'Auto layout' }).click()
  await ctx.win.waitForTimeout(1200)
}

// 1. The everyday client: a table filtered without SQL, foreign keys as arrows, a row's details beside it.
await shot(1, 'filter-and-follow', async (ctx) => {
  const { win } = ctx
  await openDemo(ctx)
  await filteredOrders(ctx)
  await win.locator('[role=row]').nth(1).locator('[role=gridcell]').nth(2).hover()
  await win.locator('[role=row]').nth(1).locator('[role=gridcell]').nth(3).click()
  await win.getByRole('button', { name: 'Row details' }).click()
  await win.waitForTimeout(500)
})

// 2. The SQL editor: the JOIN it completed from the foreign key, the result of that query below, and the same
//    completion shown again where it was picked.
await shot(2, 'sql-join-completion', async (ctx) => {
  const { win } = ctx
  await openDemo(ctx)
  await closeTab(win, 'orders')
  await newQuery(ctx)
  await win.keyboard.type('select c.first_name, c.last_name, c.city, o.status, o.ordered_at\n  from orders o\n  join ', { delay: 20 })
  await win.locator('.cm-tooltip-autocomplete').waitFor({ timeout: 5000 })
  // (The editor ignores Enter for a moment after the list opens, so a fast typist never picks by accident.)
  await win.waitForTimeout(400)
  await win.keyboard.press('Enter')
  await run(ctx)
  const picked = await win.evaluate(() => document.querySelector('.cm-content').innerText.split('\n').pop().replace(/^\s*join /, ''))
  await win.locator('.cm-content').click()
  await win.keyboard.press(`${mod}+End`)
  for (let i = 0; i < picked.length; i++) await win.keyboard.press('Backspace')
  await win.keyboard.press('Control+Space')
  await win.locator('.cm-tooltip-autocomplete').waitFor({ timeout: 5000 })
  await win.waitForTimeout(300)
})

// 3. A model on the canvas, the table's panel docked beside it.
await shot(3, 'model-on-canvas', async (ctx) => {
  await modelerState(ctx)
})

// 4. A change to a live database becomes a migration that checks the data first.
await shot(4, 'migration-data-check', async (ctx) => {
  const { win } = ctx
  await diagram(ctx)
  await win.getByRole('button', { name: 'Design', exact: true }).click()
  await win.waitForTimeout(600)
  await win.locator('.react-flow__node[data-id="main.customers"]').click({ position: { x: 60, y: 12 } })
  await win.getByTestId('column-name-newsletter').fill('marketing_consent')
  await win.getByTestId('column-name-newsletter').press('Enter')
  await win.locator('.react-flow__node[data-id="main.orders"]').click({ position: { x: 60, y: 12 } })
  const nn = win.getByTestId('column-nn-shipped_at')
  for (let i = 0; i < 3 && (await nn.getAttribute('aria-pressed')) !== 'true'; i++) {
    await nn.click()
    await win.waitForTimeout(500)
  }
  await win.getByRole('button', { name: /Review migration/ }).click()
  await win.waitForTimeout(1800)
})

// 5. The AI assistant answers from the schema and the knowledge base, with the SQL it ran.
await shot(5, 'ai-assistant', async (ctx) => {
  const file = process.env.DBM_AI_ENV
  if (!file || !existsSync(file)) throw new Error('DBM_AI_ENV names no file with OPENROUTER_API_KEY and OPENROUTER_MODEL')
  await diagram(ctx)
  await setUpOpenRouter(ctx, readAiEnv(file))
  // (Short enough that the question, the steps, the table and the SQL fit one window.)
  await askAi(ctx, 'Which product category brings the most revenue? Use the knowledge base. Answer in one sentence with a small table, then the SQL.', { widen: 230 })
})

// 6. The ER diagram of the live database with the join path between two tables, ready as SQL.
await shot(6, 'join-path', async (ctx) => {
  const { win } = ctx
  await diagram(ctx)
  await win.getByPlaceholder('Focus on table…').fill('customers')
  await win.getByPlaceholder('Focus on table…').press('Enter')
  await win.waitForTimeout(800)
  await win.getByPlaceholder('Join path to…').fill('categories')
  await win.waitForTimeout(1500)
  await win.locator('.react-flow__controls-fitview:visible').click()
  await win.waitForTimeout(800)
})

// 6b. The alternative for image 6: the diagram's Export ▸ Code menu with the four code formats.
await shot(7, 'export-code-menu', async (ctx) => {
  const { win } = ctx
  await diagram(ctx)
  await win.getByRole('button', { name: 'Export' }).click()
  await win.getByRole('menuitem', { name: 'Code' }).hover()
  await win.waitForTimeout(600)
  await quietToasts(win)
})

// The logo: the icon's drawing on a full square of its gradient (Product Hunt rounds the corners itself).
if (!only.size || only.has(8)) {
  const req = createRequire(join(repo, 'package.json'))
  const { chromium } = req('playwright')
  const browser = await chromium.launch({ channel: 'chrome', chromiumSandbox: true })
  const page = await browser.newPage({ viewport: { width: 240, height: 240 }, deviceScaleFactor: 1 })
  await page.route('**/*', (route) => route.abort())
  const icon = readFileSync(join(repo, 'docs', 'icon.svg'), 'utf8')
  const glyph = icon.slice(icon.indexOf('<ellipse'), icon.lastIndexOf('</g>'))
  const square = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b6dff"/><stop offset="1" stop-color="#4f2fe0"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/><g>${glyph}</g></svg>`
  await page.setContent(`<body style="margin:0">${square}</body>`)
  await page.locator('svg').screenshot({ path: join(out, 'logo-240.png') })
  await browser.close()
  console.log('logo-240.png 240×240')
}
if (failures) process.exit(1)

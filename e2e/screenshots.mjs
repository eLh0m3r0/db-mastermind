// The website's and the README's screenshots, light and dark, from a clean profile with the demo database:
//
//   node e2e/screenshots.mjs <out-folder> [name…]
//
// Each name is written as <name>.png (light) and <name>-dark.png: a 1440×900 window at the display's scale (2880×1800
// on a Retina Mac). `node scripts/site-images.mjs <out-folder>` then makes the files the website uses. The shot list
// with the exact states is in the launch notes (shots-needed.md); every group of shots starts the app afresh.
//
// Environment:
//   DBM_EXE           a packaged app to run instead of the development build (apps/desktop, after `npm run build`)
//   DBM_SHOT_VERSION  the version the status bar shows (default 1.5.0, through Electron's app.setVersion; set it to
//                     an empty string to show the build's own version)
//   DBM_AI_ENV        a file with OPENROUTER_API_KEY and OPENROUTER_MODEL for the `ai` shot (entered in Settings → AI
//                     assistant of the throwaway profile; never printed). Without it the `ai` shot is skipped.
//   DBM_SHOTS_TMP     where the throwaway profiles go (default: the system temp folder)
//   SHOTS_DIR         the output folder when none is given (the UI tour workflow uses it); DBM_LANGUAGE the language
import { _electron as electron } from '@playwright/test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const out = resolve(argv[0] ?? process.env.SHOTS_DIR ?? 'docs/screenshots')
const only = new Set(argv.slice(1))
mkdirSync(out, { recursive: true })
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const version = process.env.DBM_SHOT_VERSION ?? '1.5.0'
const tmpBase = process.env.DBM_SHOTS_TMP ?? tmpdir()
mkdirSync(tmpBase, { recursive: true })
const wanted = (...names) => !only.size || names.some((n) => only.has(n))
const repo = resolve(new URL('..', import.meta.url).pathname)

/** A fresh app on a throwaway profile: English, 1440×900, violet accent, normal contrast and density. */
async function session() {
  const dir = mkdtempSync(join(tmpBase, 'dbm-shots-'))
  const home = join(dir, 'home')
  const data = join(dir, 'data')
  mkdirSync(join(home, 'Downloads'), { recursive: true })
  mkdirSync(data)
  // 2× whatever display the window lands on (an external 1080p screen renders at 1×).
  const scaleArgs = ['--force-device-scale-factor=2']
  const env = { ...process.env, HOME: home, USERPROFILE: home, DBM_USER_DATA: data, DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: process.env.DBM_LANGUAGE ?? 'en', ...(process.env.CI ? {} : { DBM_E2E_BACKGROUND: '1' }) }
  const app = await electron.launch(
    process.env.DBM_EXE
      ? { executablePath: process.env.DBM_EXE, args: scaleArgs, env, timeout: 90_000 }
      : { args: [join(repo, 'apps/desktop'), ...scaleArgs, ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [])], cwd: repo, env, timeout: 90_000 },
  )
  const win = await app.firstWindow()
  win.on('dialog', (d) => d.accept())
  win.on('pageerror', (e) => console.warn('page error:', e.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  if (version) await app.evaluate(({ app }, v) => app.setVersion(v), version)
  const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
  await win.waitForTimeout(800)
  // 'system' mode: the shots switch light / dark through the emulated system setting, which keeps every open
  // menu, tooltip and completion as it is.
  await api('updateSettings', { theme: 'system', look: 'violet', contrast: 'normal', density: 'comfortable' })
  await win.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await win.reload()
  await win.waitForTimeout(1200)
  const ctx = { app, win, api, home, data, dir }
  ctx.close = async () => {
    await app.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
  return ctx
}

// The home page's section images on phones: the most telling 480×360 CSS px of the window (shown at 2×), as
// hero-phone is. Each is written as <name>-phone[-dark].png (the whole window, like hero-phone.png) and the rectangles
// go to phone-crops.json for scripts/site-images.mjs.
const PHONE_CROPS = {
  'hero-phone': { x: 268, y: 70, w: 480, h: 360 },
  'table-filters-phone': { x: 330, y: 75, w: 480, h: 360 },
  'modeler-phone': { x: 520, y: 280, w: 480, h: 360 },
  'dashboard-phone': { x: 270, y: 60, w: 480, h: 360 },
  'ai-phone': { x: 918, y: 45, w: 480, h: 360 },
}
writeFileSync(join(out, 'phone-crops.json'), `${JSON.stringify(PHONE_CROPS, null, 2)}\n`)

/** Writes <name>.png and <name>-dark.png of the current state; `again` restores an overlay the switch closed. */
async function capture({ win }, name, { again, mouse } = {}) {
  if (only.size && !only.has(name)) return
  for (const scheme of ['light', 'dark']) {
    await win.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await win.waitForTimeout(500)
    if (again) await again()
    if (mouse) await win.mouse.move(mouse.x, mouse.y)
    await win.waitForTimeout(400)
    const file = join(out, `${name}${scheme === 'dark' ? '-dark' : ''}.png`)
    await win.screenshot({ path: file })
    const width = readFileSync(file).readUInt32BE(16)
    if (width !== 2880) console.warn(`${name}: ${width} px wide, not 2880`)
    // (hero-phone is a state of its own; the section images' phone sources are the same windows.)
    if (name !== 'hero' && PHONE_CROPS[`${name}-phone`]) copyFileSync(file, join(out, `${name}-phone${scheme === 'dark' ? '-dark' : ''}.png`))
  }
  await win.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  console.log(name)
}

/** Waits until the notices are gone (they close themselves), so no shot has one by accident. */
const quietToasts = async (win) => {
  await win.waitForTimeout(300)
  await win.locator('[data-sonner-toast], [role=status]').first().waitFor({ state: 'detached', timeout: 12000 }).catch(() => {})
}

/** The mouse away from anything that shows a hover state or a tooltip. */
const park = (win) => win.mouse.move(1439, 450)

const palette = async (win, command) => {
  await win.keyboard.press('Escape')
  await win.keyboard.press(`${mod}+k`)
  await win.waitForTimeout(250)
  await win.keyboard.type(command)
  await win.waitForTimeout(300)
  await win.keyboard.press('Enter')
}

async function openDemo(ctx) {
  await ctx.win.getByRole('button', { name: 'Try the demo database' }).click()
  await ctx.win.getByPlaceholder(/Filter \d+ tables/).waitFor({ timeout: 20000 })
  await ctx.win.waitForTimeout(800)
}

/** The orders table with the two conditions of the website (status in paid, shipped; ordered since June 2025). */
async function filteredOrders({ win }) {
  await win.getByRole('button', { name: /^Filter/ }).click()
  await win.locator('select').nth(0).selectOption('status')
  await win.locator('select').nth(1).selectOption('in')
  await win.getByPlaceholder('comma or newline separated values').fill('paid,shipped')
  await win.locator('button', { hasText: /^Condition$/ }).click()
  await win.locator('select').nth(2).selectOption('ordered_at')
  await win.locator('select').nth(3).selectOption('gte')
  await win.getByPlaceholder('value').last().fill('2025-06-01')
  await win.getByRole('button', { name: 'Apply' }).click()
  await win.waitForTimeout(900)
}

const MONTHLY = "select substr(o.ordered_at, 1, 7) as month, count(distinct o.id) as orders,\n       round(sum(i.quantity * i.unit_price)) as revenue\n  from orders o join order_items i on i.order_id = o.id\n where o.status <> 'cancelled'\n group by month order by month"

const MONTHLY_SHORT = "select substr(o.ordered_at, 1, 7) as month,\n       count(distinct o.id) as orders,\n       round(sum(i.quantity * i.unit_price)) as revenue\n  from orders o\n  join order_items i on i.order_id = o.id\n where o.status <> 'cancelled'\n group by month order by month"

// Children left of their parents (relationships leave a table on the right and arrive on the left), spread to
// the height of the split's left pane.
const HERO_LAYOUT = {
  'main.payments': { x: 0, y: 0 },
  'main.order_items': { x: 0, y: 380 },
  'main.customer_revenue': { x: 0, y: 760 },
  'main.orders': { x: 310, y: 140 },
  'main.products': { x: 310, y: 530 },
  'main.customers': { x: 620, y: 0 },
  'main.employees': { x: 620, y: 360 },
  'main.categories': { x: 620, y: 670 },
}

const SHOP_DBML = `Table sales.customer {
  id bigint [pk, increment]
  email varchar(200) [not null, unique]
  name varchar(100) [not null]
  created_at timestamp [not null, default: \`now()\`]
  Note: 'People who buy'
}

Table sales.invoice {
  id bigint [pk, increment]
  customer_id bigint [not null, ref: > sales.customer.id]
  issued_on date [not null]
  total numeric(12,2) [not null]
  status varchar(20) [not null, default: 'draft']
}

Table sales.invoice_line {
  invoice_id bigint [pk, ref: > sales.invoice.id]
  line_no int [pk]
  product_id bigint [not null, ref: > catalog.product.id]
  quantity int [not null]
  price numeric(12,2) [not null]
}

Table catalog.product {
  id bigint [pk, increment]
  code varchar(30) [not null, unique]
  name varchar(200) [not null]
  category_id int [ref: > catalog.category.id]
}

Table catalog.category {
  id int [pk]
  name varchar(100) [not null]
  parent_id int [ref: > catalog.category.id]
}
`

async function closeTab(win, name) {
  const tab = win.locator('[role=tab]', { hasText: name }).first()
  await tab.hover()
  await tab.getByRole('button', { name: 'Close tab' }).click()
  await win.waitForTimeout(300)
}

async function newQuery({ win }, sql) {
  await win.keyboard.press(`${mod}+t`)
  await win.locator('.cm-content:visible').last().waitFor({ timeout: 10000 })
  await win.locator('.cm-content:visible').last().click()
  if (sql) await win.keyboard.insertText(sql)
}

const run = async ({ win }) => {
  await win.keyboard.press('Escape')
  await win.keyboard.press(`${mod}+Enter`)
  await win.waitForTimeout(1200)
}

/** Runs one group of shots on a fresh app; a failure leaves _failed-<name>.png and the run goes on. */
let failures = 0
async function group(names, fn) {
  if (!wanted(...names)) return
  const ctx = await session()
  try {
    await fn(ctx)
  } catch (err) {
    failures++
    console.error(`FAILED ${names.join(', ')}: ${err.message.split('\n')[0]}`)
    await ctx.win.screenshot({ path: join(out, `_failed-${names[0]}.png`) }).catch(() => {})
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------------------------------------------------------

await group(['home', 'connect'], async (ctx) => {
  const { win } = ctx
  await park(win)
  await capture(ctx, 'home')
  if (wanted('connect')) {
    await win.getByRole('button', { name: 'New connection' }).first().click()
    const paste = win.getByPlaceholder(/Paste a connection URL/)
    await paste.fill('postgresql://postgres@db.example.supabase.co:5432/postgres')
    await paste.press('Enter')
    await quietToasts(win)
    await park(win)
    await capture(ctx, 'connect')
  }
})

await group(['mcp-settings'], async (ctx) => {
  const { app, win } = ctx
  // The commands show where the app is installed. A development build would show the repository's path, so it
  // reports what an app installed in /Applications reports (only in this throwaway session, which saves nothing).
  if (!process.env.DBM_EXE && process.platform === 'darwin') {
    await app.evaluate(({ app }) => {
      Object.defineProperty(app, 'isPackaged', { get: () => true, configurable: true })
      process.execPath = '/Applications/DB Mastermind.app/Contents/MacOS/DB Mastermind'
    })
    await win.reload()
    await win.waitForTimeout(1200)
  }
  await win.keyboard.press(`${mod}+,`)
  await win.locator('[role=dialog] nav button', { hasText: 'MCP server' }).click()
  await win.waitForTimeout(600)
  await park(win)
  await capture(ctx, 'mcp-settings')
})

await group(['hero-phone', 'table-filters'], async (ctx) => {
  const { win } = ctx
  await openDemo(ctx)
  await filteredOrders(ctx)
  await park(win)
  await capture(ctx, 'hero-phone')
  await win.locator('[role=row]').nth(1).locator('[role=gridcell]').nth(3).click()
  await win.getByRole('button', { name: 'Row details' }).click()
  await win.waitForTimeout(500)
  await park(win)
  await capture(ctx, 'table-filters')
})


await group(['query'], async (ctx) => {
  const { win } = ctx
  await openDemo(ctx)
  await newQuery(ctx)
  await win.keyboard.type('select * from orders o join ', { delay: 30 })
  await win.waitForTimeout(800)
  const completion = win.locator('.cm-tooltip-autocomplete')
  if (!(await completion.count())) await win.keyboard.press('Control+Space')
  await completion.waitFor({ timeout: 5000 })
  await park(win)
  await capture(ctx, 'query')
})

/** Shows the result as a line chart of exactly these numeric columns. */
async function lineChart({ win }, columns) {
  await win.getByRole('button', { name: 'Show chart' }).click()
  await win.waitForTimeout(400)
  await win.locator('button', { hasText: /^Line$/ }).last().click()
  const series = win.locator('button:has(> span.rounded-sm)')
  for (let i = 0; i < (await series.count()); i++) {
    const b = series.nth(i)
    const on = (await b.getAttribute('class')).includes('border-line-strong')
    if (on !== columns.includes((await b.innerText()).trim())) await b.click()
  }
  await win.waitForTimeout(400)
}

await group(['chart', 'hero'], async (ctx) => {
  const { win, api } = ctx
  await openDemo(ctx)
  if (wanted('chart')) {
    await newQuery(ctx, MONTHLY)
    await run(ctx)
    await lineChart(ctx, ['orders'])
    const box = await win.locator('svg[aria-label="Chart of query results"]').boundingBox()
    await capture(ctx, 'chart', { mouse: { x: box.x + box.width * 0.62, y: box.y + box.height * 0.5 } })
  }
  if (wanted('hero')) {
    for (const name of ['Query 1', 'orders']) if (await win.locator('[role=tab]', { hasText: name }).count()) await closeTab(win, name)
    // A saved diagram in two columns, so the narrow pane of the split shows the tables large enough to read.
    const id = await api('createSampleDatabase')
    await api('saveDiagram', { connectionId: id, name: 'Coffee shop', tables: Object.keys(HERO_LAYOUT), positions: HERO_LAYOUT })
    await palette(win, 'ER diagram')
    await win.locator('.react-flow__node').first().waitFor({ timeout: 15000 })
    await win.getByRole('button', { name: 'Diagrams' }).click()
    await win.getByRole('menuitem', { name: 'Coffee shop' }).click()
    await win.waitForTimeout(1200)
    await closeTab(win, 'ER diagram')
    await newQuery(ctx, MONTHLY_SHORT)
    await run(ctx)
    await lineChart(ctx, ['orders'])
    await win.keyboard.press(`${mod}+\\`)
    await win.waitForTimeout(1000)
    // The divider a little right of the middle: the diagram gets the room, the SQL still fits on its lines.
    const divider = await win.locator('.absolute.cursor-col-resize').first().boundingBox()
    await win.mouse.move(divider.x + 3, divider.y + 300)
    await win.mouse.down()
    await win.mouse.move(270 + 0.56 * 1170, divider.y + 300, { steps: 8 })
    await win.mouse.up()
    await win.waitForTimeout(800)
    await win.locator('.react-flow__controls-fitview:visible').click()
    await win.waitForTimeout(800)
    await park(win)
    await capture(ctx, 'hero')
  }
})

await group(['dashboard'], async (ctx) => {
  const { win, api } = ctx
  const id = await api('createSampleDatabase')
  await api('saveDashboard', {
    connectionId: id,
    name: 'Sales',
    refreshSeconds: 0,
    tiles: [
      { id: 'orders-month', title: 'Orders per month', sql: "select substr(ordered_at, 1, 7) as month, count(*) as orders\n  from orders where status <> 'cancelled'\n group by month order by month", chart: { kind: 'line', x: 0, ys: [1] }, span: 1 },
      { id: 'orders-2025', title: 'Orders in 2025', sql: "select count(*) as orders from orders where status <> 'cancelled' and ordered_at like '2025-%'", chart: null, span: 1 },
      { id: 'revenue-category', title: 'Revenue by category', sql: "select c.name as category, round(sum(i.quantity * i.unit_price)) as revenue\n  from order_items i join products p on p.id = i.product_id join categories c on c.id = p.category_id\n  join orders o on o.id = i.order_id where o.status <> 'cancelled'\n group by c.name order by revenue desc", chart: { kind: 'bar', x: 0, ys: [1] }, span: 1 },
      { id: 'payments-method', title: 'Payments by method', sql: 'select method, count(*) as payments from payments group by method order by payments desc', chart: { kind: 'bar', x: 0, ys: [1] }, span: 1 },
    ],
  })
  await win.reload()
  await win.waitForTimeout(1200)
  await win.getByText('Demo coffee shop').first().click()
  await win.getByPlaceholder(/Filter \d+ tables/).waitFor({ timeout: 20000 })
  await palette(win, 'Dashboards')
  await win.getByRole('button', { name: /Sales/ }).first().click()
  await win.waitForTimeout(800)
  for (const name of ['Query 1', 'Dashboards']) if (await win.locator('[role=tab]', { hasText: name }).count()) await closeTab(win, name)
  await win.waitForTimeout(1500)
  await park(win)
  await capture(ctx, 'dashboard')
})

await group(['diagram', 'join-path', 'designer', 'migration'], async (ctx) => {
  const { win } = ctx
  await openDemo(ctx)
  await closeTab(win, 'orders')
  await palette(win, 'ER diagram')
  await win.locator('.react-flow__node').first().waitFor({ timeout: 15000 })
  await win.getByRole('button', { name: 'Auto layout' }).click()
  await win.waitForTimeout(1500)
  await win.getByRole('button', { name: 'Fit view' }).click()
  await win.waitForTimeout(800)
  await park(win)
  await capture(ctx, 'diagram')
  if (wanted('join-path')) {
    await win.getByPlaceholder('Focus on table…').fill('customers')
    await win.getByPlaceholder('Focus on table…').press('Enter')
    await win.waitForTimeout(800)
    await win.getByPlaceholder('Join path to…').fill('categories')
    await win.waitForTimeout(2000)
    await park(win)
    await capture(ctx, 'join-path')
    await win.getByRole('button', { name: 'Show whole schema' }).click()
    await win.waitForTimeout(1500)
  }
  if (wanted('designer', 'migration')) {
    await win.getByRole('button', { name: 'Design', exact: true }).click()
    await win.waitForTimeout(800)
    await win.locator('.react-flow__node[data-id="main.customers"]').click({ position: { x: 60, y: 12 } })
    await win.getByTestId('column-name-newsletter').waitFor({ timeout: 10000 })
    await win.getByTestId('column-name-newsletter').fill('marketing_consent')
    await win.getByTestId('column-name-newsletter').press('Enter')
    await win.waitForTimeout(600)
    await park(win)
    await capture(ctx, 'designer')
    // NOT NULL on a column that has NULLs: the migration's check counts the rows that would fail.
    await win.locator('.react-flow__node[data-id="main.orders"]').click({ position: { x: 60, y: 12 } })
    await win.getByTestId('column-nn-shipped_at').waitFor({ timeout: 10000 })
    const nn = win.getByTestId('column-nn-shipped_at')
    for (let i = 0; i < 3 && (await nn.getAttribute('aria-pressed')) !== 'true'; i++) {
      await nn.click()
      await win.waitForTimeout(500)
    }
    if ((await nn.getAttribute('aria-pressed')) !== 'true') throw new Error('NOT NULL on orders.shipped_at did not stick')
    await win.getByRole('button', { name: 'Review migration' }).click()
    await win.waitForTimeout(2000)
    await park(win)
    await capture(ctx, 'migration')
  }
})

await group(['modeler'], async (ctx) => {
  const { app, win, home } = ctx
  // A model as text, the way it lives in a repository: two schemas, five tables.
  const model = join(home, 'shop.dbml')
  writeFileSync(model, SHOP_DBML)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, model)
  await win.keyboard.press(`${mod}+o`)
  await win.locator('.react-flow__node[data-id="sales.invoice"]').waitFor({ timeout: 15000 })
  await win.waitForTimeout(1200)
  // The list of objects instead of the text, at its narrowest: the canvas gets the room.
  await win.getByRole('button', { name: 'Objects', exact: true }).click()
  const splitter = await win.locator('.cursor-col-resize').last().boundingBox()
  await win.mouse.move(splitter.x + splitter.width / 2, 500)
  await win.mouse.down()
  await win.mouse.move(150, 500, { steps: 8 })
  await win.mouse.up()
  await win.waitForTimeout(400)
  // (A double-click on the name renames the table; on the schema badge it opens the table's panel.)
  const invoice = win.locator('.react-flow__node[data-id="sales.invoice"]')
  const box = await invoice.boundingBox()
  await invoice.dblclick({ position: { x: box.width - 40, y: 14 } })
  await win.getByTestId('table-panel').waitFor({ timeout: 10000 })
  // Docked next to the diagram rather than over it.
  const pin = win.getByTestId('table-panel-pin')
  if ((await pin.count()) && (await pin.getAttribute('aria-label'))?.startsWith('Keep it next')) await pin.click()
  await win.waitForTimeout(500)
  await win.locator('.react-flow__controls-fitview:visible').click()
  await win.waitForTimeout(700)
  // Parents right of their children, as relationships are drawn (the automatic layout puts customer below).
  const node = (id) => win.locator(`.react-flow__node[data-id="${id}"]`)
  const drag = async (b, x, y) => {
    // Held by its last row: a header can be under another table while they are rearranged.
    await win.mouse.move(b.x + b.width / 2, b.y + b.height - 6)
    await win.mouse.down()
    await win.mouse.move(x + b.width / 2, y + b.height - 6, { steps: 12 })
    await win.mouse.up()
    await win.waitForTimeout(300)
  }
  // Small enough that every table is on screen while it is moved.
  for (let i = 0; i < 3; i++) await win.getByRole('button', { name: 'Zoom Out' }).click()
  await win.waitForTimeout(400)
  // The first table onto the canvas's grid (positions snap to it), then the others relative to it.
  const first = await node('sales.invoice_line').boundingBox()
  await drag(first, first.x + 30, first.y + 30)
  // Each table is moved until it sits where it should (a drag can land a grid step off).
  const places = [['sales.customer', 648, 0], ['catalog.category', 648, 216], ['catalog.product', 324, 216], ['sales.invoice', 324, 0]]
  for (const [id, x, y] of [...places, ...places]) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const origin = await node('sales.invoice_line').boundingBox()
      const scale = Number.parseInt(await win.getByTitle('Back to 100 %').innerText(), 10) / 100
      const b = await node(id).boundingBox()
      const dx = origin.x + x * scale - b.x
      const dy = origin.y + y * scale - b.y
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) break
      await drag(b, b.x + dx, b.y + dy)
    }
  }
  await node('sales.invoice').click({ position: { x: 40, y: 40 } })
  // Saved, so the tab shows no unsaved mark (the file is the throwaway copy).
  await win.keyboard.press(`${mod}+s`)
  await win.waitForTimeout(800)
  await quietToasts(win)
  await win.locator('.react-flow__controls-fitview:visible').click()
  await win.waitForTimeout(700)
  await park(win)
  await capture(ctx, 'modeler')
})

await group(['query-file'], async (ctx) => {
  const { app, win, home } = ctx
  // A sales export of four cafés, queried where it lies (~/Downloads) without importing it.
  const csv = join(home, 'Downloads', 'cafe-sales-2026.csv')
  const rows = ['date,cafe,product,quantity,unit_price']
  const cafes = ['Riverside', 'Old Town', 'Station Square', 'Harbour']
  const products = ['Espresso', 'Flat white', 'Cappuccino', 'Chai latte', 'Croissant', 'Cheesecake']
  for (let i = 0; i < 400; i++) {
    const p = (i * 7) % products.length
    rows.push(`2026-${String(1 + (i % 9)).padStart(2, '0')}-${String(1 + (i % 27)).padStart(2, '0')},${cafes[i % 4]},${products[p]},${1 + ((i * 13) % 6)},${(2.5 + p * 0.6 + ((i * 37) % 5) * 0.1).toFixed(2)}`)
  }
  writeFileSync(csv, rows.join('\n'))
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, csv)
  await win.getByRole('button', { name: 'Query a file' }).click()
  await win.locator('.cm-content:visible').last().waitFor({ timeout: 15000 })
  await win.waitForTimeout(1500)
  await win.locator('.cm-content:visible').last().click()
  await win.keyboard.press(`${mod}+a`)
  await win.keyboard.insertText("select cafe, product, sum(quantity * unit_price) as revenue\n  from '~/Downloads/cafe-sales-2026.csv'\n group by all\n order by revenue desc\n limit 12;")
  await run(ctx)
  await win.waitForTimeout(800)
  await park(win)
  await capture(ctx, 'query-file')
})

await group(['ai'], async (ctx) => {
  const { win } = ctx
  const file = process.env.DBM_AI_ENV
  if (!file || !existsSync(file)) {
    console.warn('ai: skipped (DBM_AI_ENV names no file with OPENROUTER_API_KEY and OPENROUTER_MODEL)')
    return
  }
  const vars = Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).map((l) => /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*"?([^"\n]*)"?\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]))
  if (!vars.OPENROUTER_API_KEY || !vars.OPENROUTER_MODEL) throw new Error('DBM_AI_ENV lacks OPENROUTER_API_KEY or OPENROUTER_MODEL')
  await openDemo(ctx)
  await closeTab(win, 'orders')
  await palette(win, 'ER diagram')
  await win.locator('.react-flow__node').first().waitFor({ timeout: 15000 })
  // The provider as a user sets it up: Settings → AI assistant → OpenRouter, key, model, Use this provider.
  await win.keyboard.press(`${mod}+,`)
  await win.locator('[role=dialog] nav button', { hasText: 'AI assistant' }).click()
  await win.locator('[role=dialog] button', { hasText: 'OpenRouter' }).first().click()
  await win.locator('[role=dialog] input[type=password]').fill(vars.OPENROUTER_API_KEY)
  await win.locator('[role=dialog] input[list^="models-"]').fill(vars.OPENROUTER_MODEL)
  const use = win.locator('[role=dialog] button', { hasText: 'Use this provider' })
  if (await use.count()) await use.click()
  await win.waitForTimeout(500)
  await win.locator('[role=dialog] nav button', { hasText: 'AI permissions' }).click()
  const autoRun = win.locator('[role=dialog] label', { hasText: 'Let the assistant run read-only queries without asking' }).locator('input[type=checkbox]')
  if (!(await autoRun.isChecked())) await autoRun.check()
  await win.waitForTimeout(300)
  await win.keyboard.press('Escape')
  await win.waitForTimeout(400)
  await win.getByRole('button', { name: 'Auto layout' }).click()
  await win.keyboard.press(`${mod}+j`)
  await win.waitForTimeout(500)
  // A wider panel (it keeps the width it is dragged to), so the answer's table and SQL fit.
  const splitters = await win.locator('.cursor-col-resize').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().x))
  const edge = Math.max(...splitters)
  await win.mouse.move(edge + 3, 450)
  await win.mouse.down()
  await win.mouse.move(edge + 3 - 150, 450, { steps: 8 })
  await win.mouse.up()
  const ask = win.getByPlaceholder(/Ask about/)
  await ask.fill('Which product category brings the most revenue? Use the knowledge base, show the result as a table and the SQL.')
  await ask.press('Enter')
  await win.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 20000 })
  await win.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached', timeout: 240000 })
  await win.waitForTimeout(1000)
  await win.locator('.react-flow__controls-fitview:visible').click()
  await win.waitForTimeout(600)
  // The conversation from the question down (the panel follows the answer to its end).
  await win.evaluate(() => {
    let el = [...document.querySelectorAll('div')].find((d) => d.textContent?.startsWith('Which product category') && d.children.length === 0)
    while (el && !(el.scrollHeight > el.clientHeight && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement
    if (el) el.scrollTop = 0
  })
  await park(win)
  await capture(ctx, 'ai')
})

console.log(`screenshots in ${out}`)
if (failures) process.exit(1)

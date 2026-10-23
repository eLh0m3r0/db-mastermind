// Everyday grid, editor and connection form fixes: `node e2e/flow86.mjs <screenshot dir>`
// 1. A NULL cell opened in the editor and left untouched stays NULL (it used to become '').
// 2. ⌘S while a cell or a row details field is being edited keeps the typed value and opens the review.
// 3. Closing a table tab with unsaved edits asks first; FK navigation into it opens a new tab instead of reloading it.
// 4. Row details follow the selection the grid clamps after a reload.
// 5. A new run shows its results even when Messages was picked for the previous one.
// 6. ⌘/Ctrl + digit switches tabs on Czech layouts too (the digit row types ě, š, …).
// 7. Pasted ADO.NET / Npgsql strings: Integrated Security means Windows authentication, Host=… is PostgreSQL.
// 8. Czech UI: a read-only connection refuses a write in Czech, without first asking to confirm it. The app quits after
//    a runaway SQLite query was cancelled.
import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'dbm-shots86-'))
const home = mkdtempSync(join(tmpdir(), 'dbm-ui86-'))
const data = join(home, 'data')
mkdirSync(data, { recursive: true })
const file = join(home, 'shop.db')
const db = new DatabaseSync(file)
db.exec(`CREATE TABLE customers (id integer primary key, name text not null, email text, city text);
INSERT INTO customers (name, email, city) VALUES ('Alice', 'a@x.cz', 'Praha'), ('Bob', NULL, 'Brno'), ('Cyril', 'c@x.cz', NULL);
CREATE TABLE orders (id integer primary key, customer_id integer references customers(id), total real);
INSERT INTO orders (customer_id, total) VALUES (1, 100), (2, 50);`)
db.close()
const now = new Date().toISOString()
writeFileSync(
  join(data, 'connections.json'),
  JSON.stringify([
    { id: 'shop', name: 'Shop', driver: 'sqlite', filePath: file, createdAt: now, updatedAt: now },
  ]),
)

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}

async function launch(language, dataDir = data) {
  const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: home, DBM_USER_DATA: dataDir, DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: language }, timeout: 60_000 })
  const win = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setBounds({ x: -4000, y: 0, width: 1280, height: 800 })
    w.blur()
  })
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  return { app, win, errors }
}

const { app, win, errors } = await launch('en')
const body = () => win.locator('body').innerText()
const pending = async () => (await body()).match(/(\d+) changes?\b/)?.[1] ?? '0'
const grid = () => win.locator('[role=grid]:visible').first()
const cell = (r, c) => grid().locator(`[role=row][aria-rowindex="${r + 2}"] [role=gridcell]`).nth(c)
const dialogText = async () => (await win.locator('[role=dialog]').count()) ? await win.locator('[role=dialog]').innerText() : ''
try {
  await win.waitForTimeout(1000)
  await win.getByText('Shop', { exact: true }).first().click()
  await win.waitForTimeout(1200)
  await win.getByText('customers', { exact: true }).first().click()
  await win.waitForTimeout(1000)

  // 1. NULL stays NULL.
  await cell(1, 2).dblclick()
  await win.waitForTimeout(150)
  await cell(0, 1).click()
  await cell(2, 3).click()
  await win.keyboard.press('Enter')
  await win.keyboard.press('Tab')
  await win.waitForTimeout(300)
  check('opening NULL cells and leaving them changes nothing', (await pending()) === '0', `${await pending()} pending`)
  check('the cells still show NULL', (await cell(1, 2).innerText()) === 'NULL' && (await cell(2, 3).innerText()) === 'NULL')

  // 2. ⌘S while editing.
  await cell(0, 3).click()
  await win.keyboard.type('Ostrava')
  await win.keyboard.press('ControlOrMeta+s')
  await win.waitForTimeout(600)
  let review = await dialogText()
  check('⌘S in the cell editor opens the review with the typed value', review.includes(`SET "city" = 'Ostrava'`), review.split('\n')[1])
  await win.screenshot({ path: join(out, '86-save-while-editing.png') })
  await win.keyboard.press('Escape')
  await win.waitForTimeout(300)
  await win.getByRole('button', { name: 'Row details' }).click()
  await cell(1, 1).click()
  await win.waitForTimeout(200)
  const nameField = win.locator('textarea:visible').nth(1)
  await nameField.fill('Bobby')
  await win.keyboard.press('ControlOrMeta+s')
  await win.waitForTimeout(600)
  review = await dialogText()
  check('⌘S in row details includes the field being edited', review.includes(`SET "name" = 'Bobby'`) && review.includes("'Ostrava'"), review.replace(/\n/g, ' | ').slice(0, 200))
  await win.keyboard.press('Escape')
  await win.waitForTimeout(300)

  // 3. Unsaved edits survive FK navigation and closing asks.
  await win.getByText('orders', { exact: true }).first().click()
  await win.waitForTimeout(1000)
  await cell(0, 1).hover()
  await grid().locator('[role=row][aria-rowindex="2"] button[title="Open referenced row"]').click()
  await win.waitForTimeout(1000)
  const tabs = await win.locator('[role=tab]').allInnerTexts()
  check('FK navigation opens a new tab next to the one with unsaved edits', tabs.filter((t) => t.trim() === 'customers').length === 2, JSON.stringify(tabs))
  await win.locator('[role=tab]', { hasText: 'customers' }).first().click()
  await win.waitForTimeout(500)
  check('the edited tab keeps its changes', (await pending()) === '2', `${await pending()} pending`)
  await win.locator('[role=tab]', { hasText: 'customers' }).first().getByRole('button', { name: 'Close tab' }).click()
  await win.waitForTimeout(400)
  check('closing it asks first', (await dialogText()).includes('Discard 2 pending changes?'))
  await win.screenshot({ path: join(out, '86-close-asks.png') })
  await win.getByRole('button', { name: 'Cancel' }).click()
  await win.waitForTimeout(300)
  check('cancel keeps the tab and its edits', (await win.locator('[role=tab]', { hasText: 'customers' }).count()) === 2 && (await pending()) === '2')
  await win.keyboard.press('ControlOrMeta+w')
  await win.waitForTimeout(400)
  check('⌘W asks too', (await dialogText()).includes('Discard 2 pending changes?'))
  await win.getByRole('button', { name: 'Discard', exact: true }).click()
  await win.waitForTimeout(400)
  check('discarding closes it', (await win.locator('[role=tab]', { hasText: 'customers' }).count()) === 1)

  // 4. Row details follow the clamped selection (the FK tab shows one row; select row 3 first, then filter).
  await win.locator('[role=tab]', { hasText: 'customers' }).first().click()
  await win.waitForTimeout(500)
  if (!(await win.getByPlaceholder('Find field…').count())) await win.getByRole('button', { name: 'Row details' }).click()
  await win.getByRole('button', { name: /^Clear all$/ }).click()
  await win.waitForTimeout(800)
  await cell(2, 1).click()
  await win.waitForTimeout(200)
  await win.locator('[role=tab]', { hasText: 'orders' }).click()
  await win.waitForTimeout(400)
  await cell(0, 1).hover()
  await grid().locator('[role=row][aria-rowindex="2"] button[title="Open referenced row"]').click()
  await win.waitForTimeout(1000)
  const details = await win.locator('textarea:visible').evaluateAll((els) => els.map((e) => e.value))
  check('row details show the row the grid kept selected', details.includes('Alice') && !(await body()).includes('Select a row to see its values'), JSON.stringify(details))
  await win.screenshot({ path: join(out, '86-row-details-clamped.png') })

  // 5. Results after Messages.
  await win.keyboard.press('ControlOrMeta+t')
  await win.waitForTimeout(800)
  await win.locator('.cm-content:visible').click()
  await win.keyboard.type("update customers set city = city where id = 1;\nselect 'fresh' as status;")
  await win.keyboard.press('ControlOrMeta+Home')
  await win.keyboard.press('ControlOrMeta+Enter')
  await win.waitForTimeout(800)
  await win.getByRole('button', { name: /^Messages$/ }).click()
  await win.locator('.cm-content:visible').click()
  await win.keyboard.press('ControlOrMeta+End')
  await win.keyboard.press('ControlOrMeta+Enter')
  await win.waitForTimeout(800)
  check('the next run shows its result grid', (await grid().count()) === 1 && (await grid().innerText()).includes('fresh'))
  await win.screenshot({ path: join(out, '86-results-after-messages.png') })

  // 6. Czech layout: Ctrl+ě is Ctrl+2.
  const before = await win.locator('[role=tab][aria-selected=true]').innerText()
  await win.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ě', code: 'Digit2', ctrlKey: true, metaKey: true, bubbles: true })))
  await win.waitForTimeout(400)
  const after = await win.locator('[role=tab][aria-selected=true]').innerText()
  const second = await win.locator('[role=tab]').nth(1).innerText()
  check('⌘/Ctrl + the 2 key switches to the second tab on a Czech layout', after === second && after !== before, `${before} → ${after}`)

  // 7. Connection strings.
  await win.keyboard.press('ControlOrMeta+Shift+n')
  await win.waitForTimeout(500)
  const url = win.locator('[role=dialog] input').first()
  const paste = async (text) => {
    await url.click()
    await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text)
    await win.keyboard.press('ControlOrMeta+v')
    await win.waitForTimeout(500)
  }
  await paste('Server=sql01\\SQLEXPRESS;Database=Sklad;Integrated Security=True;TrustServerCertificate=True')
  const pressed = await win.locator('[role=dialog] [aria-pressed=true]').allInnerTexts()
  check('Integrated Security selects Windows authentication', pressed.includes('Windows authentication'), JSON.stringify(pressed))
  await win.screenshot({ path: join(out, '86-windows-auth.png') })
  await paste('Host=pg01;Port=5433;Database=crm;Username=anna;Password=x')
  const values = await win.locator('[role=dialog] input').evaluateAll((els) => els.map((e) => e.value))
  const driver = await win.locator('[role=dialog] button.shadow-sm', { hasText: 'PostgreSQL' }).count()
  check('an Npgsql string fills in PostgreSQL', driver === 1 && values.includes('pg01') && values.includes('5433') && values.includes('anna'), JSON.stringify(values))
  await win.keyboard.press('Escape')
} finally {
  console.log('page errors:', errors.length ? errors : 'none')
  await app.close()
}

// 8. Czech UI, read-only refusal and quitting after a cancelled runaway query.
const csData = join(home, 'data-cs')
mkdirSync(csData)
writeFileSync(join(csData, 'connections.json'), JSON.stringify([{ id: 'ro', name: 'Archive', driver: 'sqlite', filePath: file, readOnly: true, createdAt: now, updatedAt: now }]))
const cs = await launch('cs', csData)
try {
  const w = cs.win
  await w.waitForTimeout(1000)
  await w.getByText('Archive', { exact: true }).first().click()
  await w.waitForTimeout(1200)
  await w.locator('.cm-content:visible').click()
  await w.keyboard.type("update customers set city = 'X';")
  await w.keyboard.press('ControlOrMeta+Enter')
  await w.waitForTimeout(800)
  check('no confirmation for a write the connection refuses anyway', (await w.locator('[role=dialog]').count()) === 0)
  const text = await w.locator('body').innerText()
  check('the read-only refusal is in Czech', text.includes('Připojení je jen pro čtení. Povolené jsou jen příkazy typu SELECT.'))
  await w.screenshot({ path: join(out, '86-read-only-cs.png') })
  await w.keyboard.press('ControlOrMeta+a')
  await w.keyboard.type('WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT count(*) FROM r;')
  await w.keyboard.press('ControlOrMeta+Enter')
  await w.waitForTimeout(1500)
  await w.getByRole('button', { name: 'Zrušit' }).click()
  await w.waitForTimeout(800)
  check('the runaway query is cancelled', (await w.locator('body').innerText()).includes('Zrušeno'))
} finally {
  console.log('page errors:', cs.errors.length ? cs.errors : 'none')
  const pid = cs.app.process().pid
  const started = Date.now()
  const closed = await Promise.race([cs.app.close().then(() => true), new Promise((r) => setTimeout(() => r(false), 20_000))])
  check('the app still quits', closed, `${Date.now() - started} ms`)
  if (!closed) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
}
if (results.includes(false)) process.exit(1)

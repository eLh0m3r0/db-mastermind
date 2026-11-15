// Context-menu sweep: on each database engine, opens the context menu of a connection, a schema, a table, a view, a
// routine, a column and a cell and a column header of the table, and runs every item (submenus too), recording what
// looks broken (see sweep-lib.mjs). Items marked dangerous (drop, delete, truncate…) are never run: they ask first
// and have their own tests. Engines are what differs here: features a database lacks must not be offered.
// Needs `npm run db:up` with the shop fixtures of the engines swept and a fresh `npm run build -w apps/desktop`.
// Usage: node e2e/context-sweep.mjs <out-dir> [cs|en] [--engines=postgres,mysql,…] [--strict]
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startSweep } from './sweep-lib.mjs'

const out = process.argv[2] ?? join(tmpdir(), 'dbm-context-sweep')
const lang = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'cs'
const strict = process.argv.includes('--strict')
const ENGINES = {
  postgres: { driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' },
  mysql: { driver: 'mysql', host: '127.0.0.1', port: 33069, user: 'root', password: 'mastermind', database: 'mastermind' },
  mariadb: { driver: 'mariadb', host: '127.0.0.1', port: 33070, user: 'root', password: 'mastermind', database: 'mastermind' },
  mssql: { driver: 'mssql', host: '127.0.0.1', port: 14339, user: 'sa', password: 'Mastermind!2026', database: 'mastermind', options: { trustServerCertificate: true } },
  oracle: { driver: 'oracle', host: '127.0.0.1', port: 15219, user: 'shop', password: 'mastermind', database: 'FREEPDB1' },
  cockroach: { driver: 'postgres', host: '127.0.0.1', port: 26257, user: 'root', database: 'defaultdb', ssl: { mode: 'disable' } },
  clickhouse: { driver: 'clickhouse', host: '127.0.0.1', port: 18123, user: 'default', password: 'mastermind', database: 'default' },
  trino: { driver: 'trino', host: '127.0.0.1', port: 18080, user: 'dbm', database: 'memory' },
  sqlite: 'sample',
}
const chosen = (process.argv.find((a) => a.startsWith('--engines='))?.slice('--engines='.length) ?? Object.keys(ENGINES).join(',')).split(',')
// Never run, whatever the menu says: they change or remove things and ask first anyway.
const DANGEROUS = /drop|delete|truncate|remove|empty|smazat|odstranit|vyprázdnit|zahodit|forget|zapomenout/i

const { app, win, api, state, note, checkScreen, act, report } = await startSweep({ out, lang })

/** The items of the open menu (the last one, a submenu when it is open). */
const menuItems = () =>
  win
    .locator('[role="menu"]')
    .last()
    .locator('[role="menuitem"], [role="menuitemcheckbox"]')
    .evaluateAll((els) => els.map((e) => ({ label: e.innerText.trim().split('\n')[0], disabled: e.disabled, danger: e.className.includes('text-danger'), submenu: e.getAttribute('aria-haspopup') === 'menu' })))

const clickItem = (label) => win.locator('[role="menu"]').last().locator('[role="menuitem"], [role="menuitemcheckbox"]').filter({ hasText: label }).first().click({ timeout: 3000 })

/** Every item of the context menu `open` shows, each run on a freshly opened menu. */
async function sweepMenuOf(what, open) {
  if (!(await open().then(() => true, () => false))) return note('no-target', what)
  await win.locator('[role="menu"]').first().waitFor({ timeout: 3000 }).catch(() => {})
  const items = await menuItems()
  await win.keyboard.press('Escape')
  if (!items.length) return note('empty-menu', what)
  // Items that hide or collapse what the next items need go last.
  items.sort((a, b) => Number(/hide|skrýt|collapse|sbalit/i.test(a.label)) - Number(/hide|skrýt|collapse|sbalit/i.test(b.label)))
  for (const item of items) {
    if (item.disabled || item.danger || DANGEROUS.test(item.label)) continue
    if (!item.submenu) {
      await act(`${what}: ${item.label}`, async () => {
        await open()
        await clickItem(item.label)
      })
      continue
    }
    let children = []
    try {
      await open()
      await clickItem(item.label)
      await win.waitForTimeout(300)
      children = (await win.locator('[role="menu"]').count()) > 1 ? await menuItems() : []
    } catch (err) {
      note('action-failed', `${what}: ${item.label}: ${String(err?.message ?? err).split('\n')[0].slice(0, 150)}`)
    }
    await win.keyboard.press('Escape')
    await win.keyboard.press('Escape')
    for (const child of children) {
      if (child.disabled || child.danger || DANGEROUS.test(child.label)) continue
      await act(`${what}: ${item.label} › ${child.label}`, async () => {
        await open()
        await clickItem(item.label)
        await win.waitForTimeout(300)
        await clickItem(child.label)
      })
    }
  }
}

const rightClick = (locator) => async () => {
  await locator.first().scrollIntoViewIfNeeded({ timeout: 3000 })
  await locator.first().click({ button: 'right', timeout: 3000 })
}

async function closeAllTabs() {
  for (let i = 0; i < 30 && (await win.locator('[role="tab"]').count()) > 0; i++) {
    await win.locator('[role="tab"]').last().click({ timeout: 2000 }).catch(() => {})
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+w' : 'Control+w')
    await win.waitForTimeout(200)
    await win.keyboard.press('Escape')
  }
}

try {
  await win.waitForTimeout(1500)
  const names = {}
  for (const id of chosen) {
    const config = ENGINES[id]
    if (!config) continue
    if (config === 'sample') {
      const sampleId = await api('createSampleDatabase')
      names[id] = (await api('listConnections')).find((c) => c.id === sampleId)?.name
    } else {
      names[id] = `Sweep ${id}`
      await api('saveConnection', { name: names[id], ...config })
    }
  }
  for (const id of chosen) {
    const name = names[id]
    if (!name) continue
    state.context = id
    state.current = 'setup'
    await win.reload()
    await win.waitForTimeout(1200)
    await closeAllTabs()
    // The connection list shows when no connection is selected; the home button clears the selection.
    await win.getByRole('button', { name: /^(All connections|Všechna připojení)$/ }).first().click({ timeout: 2000 }).catch(() => {})
    const row = win.locator(`[data-connection="${name}"]`)
    // An item may select the connection (the sidebar then shows its tree): back to the list before each one.
    const home = () => win.getByRole('button', { name: /^(All connections|Všechna připojení)$/ }).first().click({ timeout: 2000 }).catch(() => {})
    await sweepMenuOf('connection', async () => {
      if (!(await row.count())) await home()
      await rightClick(row)()
    })

    state.current = 'connect'
    await win.reload()
    await win.waitForTimeout(1000)
    await win.getByRole('button', { name: /^(All connections|Všechna připojení)$/ }).first().click({ timeout: 2000 }).catch(() => {})
    await row.first().click({ timeout: 5000 })
    const tree = await win.locator('[data-node]').first().waitFor({ timeout: 45000 }).then(() => true, () => false)
    if (!tree) {
      note('connect-failed', name)
      await checkScreen()
      continue
    }
    await win.waitForTimeout(800)
    await checkScreen()
    await sweepMenuOf('schema', rightClick(win.locator('[data-node="schema"]')))
    const table = win.locator('[data-node="table"]').filter({ hasText: /customers|orders/ }).or(win.locator('[data-node="table"]')).first()
    await sweepMenuOf('table', rightClick(table))
    if (await win.locator('[data-node="view"]').count()) await sweepMenuOf('view', rightClick(win.locator('[data-node="view"]')))
    if (await win.locator('[data-routine]').count()) await sweepMenuOf('routine', rightClick(win.locator('[data-routine]')))
    // Columns show under an expanded table.
    if (!(await win.locator('[data-node="column"]').count())) await table.locator('button').first().click({ timeout: 3000 }).catch(() => {})
    await win.waitForTimeout(500)
    await sweepMenuOf('column', rightClick(win.locator('[data-node="column"]')))

    state.current = 'open table'
    // Each grid item starts from the table as it opens (a filter or sort from the previous item would change it).
    const freshTable = async () => {
      await closeAllTabs()
      await table.click({ timeout: 5000 })
      await win.locator('[role="gridcell"]').nth(1).waitFor({ timeout: 20000 })
    }
    const grid = await freshTable().then(() => true, () => false)
    if (grid) {
      await sweepMenuOf('cell', async () => {
        await freshTable()
        await rightClick(win.locator('[role="gridcell"]').nth(1))()
      })
      await sweepMenuOf('header', async () => {
        await freshTable()
        await rightClick(win.locator('[role="columnheader"]').nth(1))()
      })
    } else note('no-grid', name)
  }
} catch (err) {
  note('sweep-failed', String(err?.stack ?? err).slice(0, 500))
  await win.screenshot({ path: join(out, 'failure.png') }).catch(() => {})
} finally {
  await app.close().catch(() => {})
}
report(strict)
process.exit()

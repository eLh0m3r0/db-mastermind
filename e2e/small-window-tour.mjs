// Screenshots of the workbench at the smallest window (900×560, the app's minimum) in Czech, whose words are longer:
// for a review of clipped labels, overflowing toolbars and dialogs that don't fit. Navigation goes through palette
// ids and menu commands, which don't depend on the language.
// Needs `npm run db:up` (postgres) with the shop fixtures and a fresh `npm run build -w apps/desktop`.
// Usage: node e2e/small-window-tour.mjs <out-dir> [cs|en] [width] [height]
import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? join(tmpdir(), 'dbm-small')
const lang = process.argv[3] ?? 'cs'
const width = Number(process.argv[4] ?? 900)
const height = Number(process.argv[5] ?? 560)
mkdirSync(out, { recursive: true })
const dir = mkdtempSync(join(tmpdir(), 'dbm-small-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: lang, DBM_E2E_BACKGROUND: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const menu = (command) => app.evaluate(({ BrowserWindow }, command) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', command), command)
let n = 0
const shot = async (name) => {
  await win.waitForTimeout(700)
  await win.screenshot({ path: join(out, `${String(++n).padStart(2, '0')}-${name}.png`) })
}
const palette = async (id) => {
  await win.keyboard.press(`${mod}+k`)
  await win.locator(`[cmdk-item][data-value="${id}"]`).click({ timeout: 5000 })
  await win.waitForTimeout(800)
}
const escape = async () => {
  for (let i = 0; i < 3; i++) await win.keyboard.press('Escape')
}
const step = async (name, run) => {
  try {
    await run()
    await shot(name)
  } catch (err) {
    console.log(`could not show ${name}: ${String(err.message).split('\n')[0]}`)
  }
  await escape()
}

try {
  await app.evaluate(({ BrowserWindow }, [w, h]) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setMinimumSize(w, h)
    window.setSize(w, h)
  }, [width, height])
  await win.waitForTimeout(1000)
  await shot('home')
  await step('connection-form', () => menu('new-connection'))
  await step('settings', () => menu('settings'))
  await step('shortcuts', () => menu('shortcuts'))

  await api('saveConnection', { name: 'Shop', driver: 'postgres', host: '127.0.0.1', port: 54329, database: 'mastermind', user: 'postgres', password: 'mastermind' })
  await win.reload()
  await win.getByText('Shop', { exact: true }).first().dblclick()
  await win.locator('.cm-content:visible').first().waitFor({ timeout: 15000 })
  await win.locator('.cm-content:visible').first().click()
  await win.keyboard.insertText('SELECT o.*, c.name, c.email FROM shop.orders o JOIN shop.customers c ON c.id = o.customer_id')
  await win.keyboard.press(`${mod}+Enter`)
  await shot('query-results')
  await step('query-ai-panel', () => menu('toggle-ai'))
  await menu('toggle-ai')
  await step('run-many', () => menu('run-on-connections'))
  await step('shortcuts-connected', () => menu('shortcuts'))
  await step('connection-form-existing', async () => {
    await win.locator('[data-status]').first().click({ button: 'right' }).catch(() => {})
  })

  await win.keyboard.press(`${mod}+p`)
  await win.keyboard.insertText('orders')
  await win.waitForTimeout(800)
  await win.keyboard.press('Enter')
  await win.locator('[role="gridcell"]').first().waitFor({ timeout: 15000 })
  await shot('table')
  await step('table-filters', async () => {
    await win.keyboard.press(`${mod}+f`)
  })
  await step('table-cell-menu', async () => {
    await win.locator('[role="gridcell"]').nth(2).click({ button: 'right' })
  })
  await step('table-header-menu', async () => {
    await win.locator('[role="columnheader"]').nth(2).click({ button: 'right' })
  })
  await step('table-export-menu', async () => {
    await win.keyboard.press(`${mod}+Shift+e`)
  })

  for (const id of ['diagram', 'activity', 'table-sizes', 'knowledge', 'find-value', 'copy-tables', 'roles', 'compare', 'datacompare', 'dashboards', 'new-table', 'model-new']) {
    await step(id, () => palette(id))
  }
  await step('palette', async () => {
    await win.keyboard.press(`${mod}+k`)
  })
  await step('tree-table-menu', async () => {
    // The palette of the previous step is still open over the tree, and a small window hides the sidebar.
    await win.keyboard.press('Escape')
    if (!(await win.locator('[data-node="table"]:visible').count())) await menu('toggle-sidebar')
    await win.locator('[data-node="table"]:visible').first().click({ button: 'right' })
  })
  console.log(errors.length ? `page errors: ${errors.join(' | ')}` : 'page errors: none')
  console.log(`screenshots: ${n} in ${out}`)
} finally {
  await app.close()
}

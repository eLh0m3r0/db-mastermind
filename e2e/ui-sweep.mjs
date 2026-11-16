// UI sweep: runs every command palette entry and every native menu command in several situations (no connection,
// a query tab, a table tab, a model tab) and reports what looks broken: page errors, console errors, error toasts,
// English text in the Czech UI, commands with no visible effect, and every external link the app tries to open.
// Native dialogs and shell.openExternal are replaced by recorders, so nothing opens on the machine.
// Needs `npm run db:up` (postgres) with the shop fixtures and a fresh `npm run build -w apps/desktop`.
// Usage: node e2e/ui-sweep.mjs <out-dir> [cs|en] [--strict]
// --strict (CI): exit 1 on what is wrong in any context. "no-effect" stays a hint: it needs a person to judge.
// The context menus are swept by e2e/context-sweep.mjs.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mod, startSweep } from './sweep-lib.mjs'

const out = process.argv[2] ?? join(tmpdir(), 'dbm-sweep')
const lang = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'cs'
const strict = process.argv.includes('--strict')
const { app, win, api, state, note, checkScreen, act, report } = await startSweep({ out, lang })

async function paletteIds() {
  await win.keyboard.press(`${mod}+k`)
  await win.locator('[cmdk-item]').first().waitFor({ timeout: 5000 })
  const ids = await win.locator('[cmdk-group]').first().locator('[cmdk-item]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-value'), e.innerText.trim()]))
  await win.keyboard.press('Escape')
  return ids
}

async function sweepPalette(activateTab) {
  for (const [id, label] of await paletteIds()) {
    if (/quit|ukončit|close tab|zavřít záložku/i.test(label)) continue
    await activateTab?.()
    await act(
      `palette: ${label}`,
      async () => {
        await win.keyboard.press(`${mod}+k`)
        const item = win.locator(`[cmdk-item][data-value="${id}"]`)
        if (!(await item.count())) {
          await win.keyboard.press('Escape')
          return false
        }
        await item.click()
      },
      { screenshot: id },
    )
  }
}

async function sweepMenu(activateTab) {
  const items = await app.evaluate(({ Menu }) => {
    const list = []
    const walk = (menu, path) => {
      for (const [i, it] of menu.items.entries()) {
        if (it.submenu) walk(it.submenu, [...path, i])
        else if (!it.role && it.type === 'normal' && it.label) list.push({ path: [...path, i], label: it.label })
      }
    }
    walk(Menu.getApplicationMenu(), [])
    return list
  })
  for (const it of items) {
    // Closing the tab under test would leave the rest of this context without it.
    if (/close tab|zavřít záložku/i.test(it.label)) continue
    await activateTab?.()
    await act(`menu: ${it.label}`, () =>
      app.evaluate(({ Menu, BrowserWindow }, path) => {
        let item
        let menu = Menu.getApplicationMenu()
        for (const i of path) {
          item = menu.items[i]
          menu = item.submenu
        }
        // Greyed out here: nobody can click it.
        if (!item.enabled) return false
        item.click(undefined, BrowserWindow.getAllWindows()[0], BrowserWindow.getAllWindows()[0].webContents)
        return true
      }, it.path),
    )
  }
}

try {
  await win.waitForTimeout(1500)
  state.context = 'no-connection'
  await checkScreen()
  await sweepPalette()
  await sweepMenu()

  await api('saveConnection', { name: 'Shop', driver: 'postgres', host: '127.0.0.1', port: 54329, database: 'mastermind', user: 'postgres', password: 'mastermind' })
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByText('Shop', { exact: true }).first().dblclick()
  await win.locator('.cm-content:visible').first().waitFor({ timeout: 15000 })
  await win.locator('.cm-content:visible').first().click()
  await win.keyboard.insertText('SELECT * FROM shop.orders')
  await win.keyboard.press(`${mod}+Enter`)
  await win.waitForTimeout(1500)
  // A tab that can't be clicked means the context's actions would run on another tab: noted, never swallowed.
  const tabAt = async (i) =>
    win
      .locator('[role="tab"]')
      .nth(i)
      .click({ timeout: 2000 })
      .catch((err) => note('action-failed', `tab ${i}: ${String(err?.message ?? err).split('\n')[0].slice(0, 160)}`))
  /** The new tab a context's setup opened, or undefined (noted) when it opened none. */
  const opened = async (before, title) => {
    const tabs = await win.locator('[role="tab"]').count()
    const last = tabs > before ? ((await win.locator('[role="tab"]').nth(tabs - 1).innerText().catch(() => '')) ?? '') : ''
    if (tabs > before && (!title || title.test(last))) return tabs - 1
    note('context-unreached', `${state.context}: ${tabs > before ? `the new tab is “${last.trim()}”` : 'no tab opened'}`)
    return undefined
  }

  state.context = 'query-tab'
  state.current = 'setup'
  await checkScreen()
  await sweepPalette(() => tabAt(0))
  await sweepMenu(() => tabAt(0))

  state.context = 'table-tab'
  state.current = 'setup'
  const beforeTable = await win.locator('[role="tab"]').count()
  await win.keyboard.press(`${mod}+p`)
  await win.keyboard.insertText('orders')
  await win.waitForTimeout(800)
  await win.keyboard.press('Enter')
  await win.waitForTimeout(2000)
  await checkScreen()
  const tableTab = await opened(beforeTable, /orders/i)
  if (tableTab !== undefined) {
    await sweepPalette(() => tabAt(tableTab))
    await sweepMenu(() => tabAt(tableTab))
  }

  state.context = 'model-tab'
  state.current = 'setup'
  const beforeModel = await win.locator('[role="tab"]').count()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'new-model'))
  await win.waitForTimeout(1500)
  await checkScreen()
  const modelTab = await opened(beforeModel, /model/i)
  if (modelTab !== undefined) {
    await sweepPalette(() => tabAt(modelTab))
    await sweepMenu(() => tabAt(modelTab))
  }
} catch (err) {
  note('sweep-failed', String(err?.stack ?? err).slice(0, 500))
  await win.screenshot({ path: join(out, 'failure.png') }).catch(() => {})
} finally {
  await app.close().catch(() => {})
}
report(strict, ['no-connection', 'query-tab', 'table-tab', 'model-tab'])

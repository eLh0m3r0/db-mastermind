// UI sweep: runs every command palette entry and every native menu command in several situations (no connection,
// a query tab, a table tab, a model tab) and reports what looks broken: page errors, console errors, error toasts,
// English text in the Czech UI, commands with no visible effect, and every external link the app tries to open.
// Native dialogs and shell.openExternal are replaced by recorders, so nothing opens on the machine.
// Needs `npm run db:up` (postgres) with the shop fixtures and a fresh `npm run build -w apps/desktop`.
// Usage: node e2e/ui-sweep.mjs <out-dir> [cs|en] [--strict]
import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? join(tmpdir(), 'dbm-sweep')
const lang = process.argv[3] ?? 'cs'
// --strict (CI): exit 1 on what is wrong in any context. "no-effect" stays a hint: it needs a person to judge.
const strict = process.argv.includes('--strict')
const SERIOUS = new Set(['pageerror', 'console', 'error-toast', 'english', 'sweep-failed', 'errorBox'])
mkdirSync(out, { recursive: true })
const { cs } = await import('../apps/desktop/src/renderer/src/lib/i18n-cs.ts')
const untranslated = new Map(Object.entries(cs).filter(([k, v]) => k !== v && !k.includes('|') && /[a-z]{3}/.test(k)))

const dir = mkdtempSync(join(tmpdir(), 'dbm-sweep-'))
const app = await electron.launch({
  args: ['apps/desktop'],
  env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: lang, DBM_E2E_BACKGROUND: '1' },
})
const win = await app.firstWindow()
await win.setViewportSize({ width: 1400, height: 900 }).catch(() => {})

// Recorders in main: links, dialogs. Message boxes answer with their cancel button.
await app.evaluate(({ dialog, shell }) => {
  globalThis.__calls = []
  const rec = (kind, detail) => globalThis.__calls.push({ kind, detail })
  shell.openExternal = async (url) => rec('openExternal', url)
  shell.openPath = async (p) => (rec('openPath', p), '')
  shell.showItemInFolder = (p) => rec('showItemInFolder', p)
  dialog.showOpenDialog = async (...a) => (rec('openDialog', (a.at(-1) ?? {}).title ?? ''), { canceled: true, filePaths: [] })
  dialog.showSaveDialog = async (...a) => (rec('saveDialog', (a.at(-1) ?? {}).title ?? ''), { canceled: true })
  dialog.showMessageBox = async (...a) => {
    const o = a.at(-1) ?? {}
    rec('messageBox', o.message ?? '')
    return { response: o.cancelId ?? Math.max(0, (o.buttons?.length ?? 1) - 1), checkboxChecked: false }
  }
  dialog.showErrorBox = (title, content) => rec('errorBox', `${title}: ${content}`)
})
const calls = async () => app.evaluate(() => globalThis.__calls.splice(0))

const findings = []
let context = 'start'
let current = ''
const note = (kind, detail) => findings.push({ context, command: current, kind, detail })
win.on('pageerror', (e) => note('pageerror', e.message))
win.on('console', (m) => m.type() === 'error' && note('console', m.text().slice(0, 300)))

const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

/** What the user can see: used to notice a command that did nothing, and English text in the Czech UI. */
const snapshot = () =>
  win.evaluate(() => {
    const texts = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement
      if (!el || el.closest('.cm-content, [role="gridcell"], [role="row"], pre, code, .react-flow')) continue
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue
      const t = n.textContent.trim()
      if (t) texts.push(t)
    }
    for (const el of document.querySelectorAll('[title], [placeholder], [aria-label]')) {
      for (const a of ['title', 'placeholder', 'aria-label']) {
        const v = el.getAttribute(a)?.trim()
        if (v) texts.push(v)
      }
    }
    const errors = [...document.querySelectorAll('[role="status"]')].filter((s) => s.querySelector('svg.text-danger')).map((s) => s.innerText.replace(/\s+/g, ' ').trim())
    return { texts, signature: `${document.body.innerText.length}|${document.querySelectorAll('[role="dialog"], [role="menu"]').length}|${location.hash}|${document.activeElement?.tagName}`, errors }
  })

async function checkScreen() {
  const s = await snapshot()
  if (lang === 'cs') for (const t of new Set(s.texts)) if (untranslated.has(t)) note('english', t)
  for (const e of s.errors) note('error-toast', e)
  return s
}

async function closeExtras(tabsBefore) {
  for (let i = 0; i < 3; i++) await win.keyboard.press('Escape')
  const tabs = await win.locator('[role="tab"]').count()
  for (let i = tabs; i > tabsBefore; i--) {
    await win.locator('[role="tab"]').last().click({ timeout: 2000 }).catch(() => {})
    await win.keyboard.press(`${mod}+w`)
    await win.waitForTimeout(200)
    for (let j = 0; j < 2; j++) await win.keyboard.press('Escape')
  }
}

async function paletteIds() {
  await win.keyboard.press(`${mod}+k`)
  await win.locator('[cmdk-item]').first().waitFor({ timeout: 5000 })
  const ids = await win.locator('[cmdk-group]').first().locator('[cmdk-item]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-value'), e.innerText.trim()]))
  await win.keyboard.press('Escape')
  return ids
}

async function sweepPalette(activateTab) {
  const ids = await paletteIds()
  for (const [id, label] of ids) {
    if (/quit|ukončit|close tab|zavřít záložku/i.test(label)) continue
    current = `palette: ${label}`
    await activateTab?.()
    const tabsBefore = await win.locator('[role="tab"]').count()
    const before = (await snapshot()).signature
    await win.keyboard.press(`${mod}+k`)
    const item = win.locator(`[cmdk-item][data-value="${id}"]`)
    if (!(await item.count())) {
      await win.keyboard.press('Escape')
      continue
    }
    await item.click()
    await win.waitForTimeout(900)
    const s = await checkScreen()
    const c = await calls()
    for (const x of c) note(x.kind, x.detail)
    // The palette itself closes, so an unchanged screen means the command did nothing visible.
    if (s.signature === before && !c.length) note('no-effect', '')
    await win.screenshot({ path: join(out, `${context}-${id}.png`.replace(/[^\w.-]+/g, '_')) }).catch(() => {})
    await closeExtras(tabsBefore)
  }
}

async function sweepMenu(activateTab) {
  const items = await app.evaluate(({ Menu }) => {
    const list = []
    const walk = (menu, path) => {
      for (const [i, it] of menu.items.entries()) {
        if (it.submenu) walk(it.submenu, [...path, i])
        else if (!it.role && it.type === 'normal' && it.label) list.push({ path: [...path, i], label: it.label, enabled: it.enabled })
      }
    }
    walk(Menu.getApplicationMenu(), [])
    return list
  })
  for (const it of items) {
    // Closing the tab under test would leave the rest of this context without it.
    if (/close tab|zavřít záložku/i.test(it.label)) continue
    current = `menu: ${it.label}`
    await activateTab?.()
    const tabsBefore = await win.locator('[role="tab"]').count()
    const before = (await snapshot()).signature
    const clicked = await app.evaluate(({ Menu, BrowserWindow }, path) => {
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
    }, it.path)
    if (!clicked) continue
    await win.waitForTimeout(900)
    const s = await checkScreen()
    const c = await calls()
    for (const x of c) note(x.kind, x.detail)
    if (s.signature === before && !c.length) note('no-effect', '')
    await closeExtras(tabsBefore)
  }
}

try {
  await win.waitForTimeout(1500)
  context = 'no-connection'
  await checkScreen()
  await sweepPalette()
  await sweepMenu()

  const saved = await api('saveConnection', { name: 'Shop', driver: 'postgres', host: '127.0.0.1', port: 54329, database: 'mastermind', user: 'postgres', password: 'mastermind' })
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByText('Shop', { exact: true }).first().dblclick()
  await win.locator('.cm-content:visible').first().waitFor({ timeout: 15000 })
  await win.locator('.cm-content:visible').first().click()
  await win.keyboard.insertText('SELECT * FROM shop.orders')
  await win.keyboard.press(`${mod}+Enter`)
  await win.waitForTimeout(1500)
  const tabAt = async (i) => win.locator('[role="tab"]').nth(i).click({ timeout: 2000 }).catch(() => {})

  context = 'query-tab'
  current = 'setup'
  await checkScreen()
  await sweepPalette(() => tabAt(0))
  await sweepMenu(() => tabAt(0))

  context = 'table-tab'
  current = 'setup'
  await win.keyboard.press(`${mod}+p`)
  await win.keyboard.insertText('orders')
  await win.waitForTimeout(800)
  await win.keyboard.press('Enter')
  await win.waitForTimeout(2000)
  await checkScreen()
  const tableTab = (await win.locator('[role="tab"]').count()) - 1
  await sweepPalette(() => tabAt(tableTab))
  await sweepMenu(() => tabAt(tableTab))

  context = 'model-tab'
  current = 'setup'
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'new-model'))
  await win.waitForTimeout(1500)
  await checkScreen()
  const modelTab = (await win.locator('[role="tab"]').count()) - 1
  await sweepPalette(() => tabAt(modelTab))
  await sweepMenu(() => tabAt(modelTab))
  void saved
} catch (err) {
  note('sweep-failed', String(err?.stack ?? err).slice(0, 500))
  await win.screenshot({ path: join(out, 'failure.png') }).catch(() => {})
} finally {
  await app.close().catch(() => {})
}

// One line per distinct finding, with the contexts it happened in.
const grouped = new Map()
for (const f of findings) {
  const key = `${f.kind}\t${f.command}\t${f.detail}`
  if (!grouped.has(key)) grouped.set(key, new Set())
  grouped.get(key).add(f.context)
}
const lines = [...grouped].map(([k, ctx]) => `${k}\t[${[...ctx].join(', ')}]`).sort()
writeFileSync(join(out, 'findings.tsv'), lines.join('\n') + '\n')
console.log(lines.join('\n'))
console.log(`findings: ${lines.length}`)
const serious = findings.filter((f) => SERIOUS.has(f.kind))
if (strict && serious.length) {
  console.log(`serious: ${serious.length}`)
  process.exitCode = 1
}

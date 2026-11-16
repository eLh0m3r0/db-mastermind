// Shared by e2e/ui-sweep.mjs and e2e/context-sweep.mjs: launches the app with native dialogs and shell.openExternal
// replaced by recorders (nothing opens on the machine), and records what looks broken after each action: page and
// console errors, error toasts, English text in the Czech UI, actions with no visible effect.
import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `action-failed`: an item the sweep could not reach is an item nobody checked. `context-unreached`: a whole situation.
export const SERIOUS = new Set(['pageerror', 'console', 'error-toast', 'english', 'sweep-failed', 'errorBox', 'action-failed', 'context-unreached', 'nothing-swept'])
export const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

export async function startSweep({ out, lang }) {
  mkdirSync(out, { recursive: true })
  const { cs } = await import('../apps/desktop/src/renderer/src/lib/i18n-cs.ts')
  const untranslated = new Map(Object.entries(cs).filter(([k, v]) => k !== v && !k.includes('|') && /[a-z]{3}/.test(k)))
  const dir = mkdtempSync(join(tmpdir(), 'dbm-sweep-'))
  const app = await electron.launch({
    args: ['apps/desktop'],
    env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: lang, DBM_E2E_BACKGROUND: '1' },
  })
  const win = await app.firstWindow()

  // A hard limit: an action that leaves the app waiting on a question the sweep never answers used to make the run
  // blink on that dialog for many minutes. No progress for SWEEP_STALL_MIN minutes (or SWEEP_LIMIT_MIN in all)
  // ends the app; the script then reports what it reached and exits.
  const stallMs = Number(process.env.SWEEP_STALL_MIN ?? 3) * 60_000
  const limitMs = Number(process.env.SWEEP_LIMIT_MIN ?? 45) * 60_000
  const started = Date.now()
  let progress = Date.now()
  const watchdog = setInterval(() => {
    const stalled = Date.now() - progress > stallMs
    if (!stalled && Date.now() - started < limitMs) return
    clearInterval(watchdog)
    findings.push({ context: state.context, command: state.current, kind: 'sweep-failed', detail: stalled ? `no progress for ${stallMs / 60_000} min: stopped` : `over ${limitMs / 60_000} min: stopped` })
    try {
      app.process().kill('SIGKILL')
    } catch {}
    // Whatever still waits gives up; the report is printed by the script's own finally block before this.
    setTimeout(() => {
      report(true)
      process.exit(1)
    }, 60_000).unref()
  }, 10_000)
  watchdog.unref()
  await win.setViewportSize({ width: 1400, height: 900 }).catch(() => {})
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

  const findings = []
  const state = { context: 'start', current: '' }
  /** Actions that ran, by context: a context that ran none was not swept, whatever else it reported. */
  const swept = new Map()
  const note = (kind, detail) => findings.push({ context: state.context, command: state.current, kind, detail })
  win.on('pageerror', (e) => note('pageerror', e.message))
  win.on('console', (m) => m.type() === 'error' && note('console', m.text().slice(0, 300)))

  const calls = async () => app.evaluate(() => globalThis.__calls.splice(0))
  const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])

  /** What the user can see: used to notice an action that did nothing, and English text in the Czech UI. */
  const snapshot = () =>
    win.evaluate(() => {
      const texts = []
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement
        // Data (cells, rows, the editor, diagrams, the schema tree's names) is not UI text.
        // (data-value: names and values from the database, such as a column called "created" or
        // ClickHouse's database "default".)
        if (!el || el.closest('.cm-content, [role="gridcell"], [role="row"], [role="columnheader"], pre, code, .react-flow, [data-node], [data-routine], [data-value]')) continue
        const r = el.getBoundingClientRect()
        if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue
        const t = n.textContent.trim()
        if (t) texts.push(t)
      }
      for (const el of document.querySelectorAll('[title], [placeholder], [aria-label]')) {
        if (el.closest('[data-node], [data-routine], [role="gridcell"], [role="columnheader"]')) continue
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

  /** Closes what an action opened: dialogs, menus, extra tabs. */
  /**
   * Closing a table tab with unsaved cell edits (Set NULL, Clone row) asks "Discard N pending changes?": Escape keeps
   * the tab, so a sweep that only pressed Escape tried again and again on the same question. Discard is the answer.
   */
  async function answerDiscard() {
    const discard = win.getByRole('dialog').getByRole('button', { name: /^(Discard|Zahodit)$/ })
    if (await discard.count().catch(() => 0)) await discard.first().click({ timeout: 2000 }).catch(() => {})
  }

  /** Closes the last tab, answering the question about its unsaved edits. */
  async function closeLastTab() {
    await win.locator('[role="tab"]').last().click({ timeout: 2000 }).catch(() => {})
    await win.keyboard.press(`${mod}+w`)
    await win.waitForTimeout(200)
    await answerDiscard()
    await win.waitForTimeout(100)
    for (let j = 0; j < 2; j++) await win.keyboard.press('Escape')
  }

  async function closeExtras(tabsBefore) {
    for (let i = 0; i < 3; i++) await win.keyboard.press('Escape')
    const tabs = await win.locator('[role="tab"]').count()
    for (let i = tabs; i > tabsBefore; i--) await closeLastTab()
  }

  /** Runs one action and records what it left on the screen. */
  async function act(label, run, { screenshot } = {}) {
    progress = Date.now()
    state.current = label
    const tabsBefore = await win.locator('[role="tab"]').count()
    const before = (await snapshot()).signature
    try {
      if ((await run()) === false) return
      swept.set(state.context, (swept.get(state.context) ?? 0) + 1)
    } catch (err) {
      // The sweep couldn't reach the item (it moved, the menu closed): noted, and the sweep goes on.
      note('action-failed', String(err?.message ?? err).split('\n')[0].slice(0, 200))
      await closeExtras(tabsBefore)
      return
    }
    await win.waitForTimeout(900)
    const s = await checkScreen()
    const c = await calls()
    for (const x of c) note(x.kind, x.detail)
    if (s.signature === before && !c.length) note('no-effect', '')
    if (screenshot) await win.screenshot({ path: join(out, `${state.context}-${screenshot}.png`.replace(/[^\w.-]+/g, '_')) }).catch(() => {})
    await closeExtras(tabsBefore)
  }

  /**
   * One line per distinct finding with the contexts it happened in; exit code 1 under --strict when serious.
   * `contexts`: the situations the sweep meant to cover; each must have run at least one action.
   */
  function report(strict, contexts = [...swept.keys()]) {
    for (const context of contexts) if (!swept.get(context)) findings.push({ context, command: '', kind: 'nothing-swept', detail: 'no action ran in this context' })
    if (![...swept.values()].some(Boolean)) findings.push({ context: 'all', command: '', kind: 'nothing-swept', detail: 'no action ran at all' })
    console.log(`swept: ${[...swept].map(([c, n]) => `${c} ${n}`).join(', ') || 'nothing'}`)
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
  }

  return { app, win, api, state, note, calls, snapshot, checkScreen, closeExtras, closeLastTab, act, report }
}

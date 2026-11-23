// Screens for a design review, in several looks: home, query with results and an open transaction, a table with an
// edit, the ER diagram, a new model, Settings (General, Appearance), the connection form, the AI panel, the command
// palette, the close-tab question and a dashboard with charts. `node e2e/review-shots.mjs <dir>` → <look>-<nn>.png and a sheet <look>.png.
import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? tmpdir()
const looks = (process.env.LOOKS ?? 'violet,violet-dark,violet-hc,blue-dark-hc-compact,halloween,retro2001,christmas,medieval,fantasy,terminal').split(',')
const dir = mkdtempSync(join(tmpdir(), 'dbm-review-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(dir, 'h'), DBM_USER_DATA: join(dir, 'd'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: process.env.DBM_LANGUAGE ?? 'cs', DBM_E2E_BACKGROUND: '1' } })
const win = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1366, 820))
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const palette = async (text) => {
  await win.keyboard.press('Escape')
  await win.keyboard.press(`${mod}+k`)
  await win.getByPlaceholder(/command|příkaz/i).waitFor({ timeout: 5000 })
  await win.waitForTimeout(150)
  await win.getByPlaceholder(/command|příkaz/i).fill(text)
  await win.keyboard.press('Enter')
  await win.waitForTimeout(1500)
}
const tab = (re) => win.getByRole('tab', { name: re }).first()
const settings = async (section) => {
  await win.keyboard.press(`${mod}+,`)
  await win.locator('[role=dialog] nav button').filter({ hasText: section }).click()
  await win.waitForTimeout(300)
}
let n = 0
/**
 * SWEEP=1: elements of the screen that keep a default colour (white, the default violet, the default chart blue)
 * where the look has its own, by computed values (not class names).
 */
const found = new Map()
async function sweep(look) {
  const hits = await win.evaluate(() => {
    // Colours as the browser computes them (the build may write #fff for #ffffff).
    const probe = document.createElement('div')
    document.body.append(probe)
    const resolve = (value) => {
      probe.style.color = ''
      probe.style.color = value
      return getComputedStyle(probe).color
    }
    const [bg, elevated, subtle, accent] = ['--bg', '--bg-elevated', '--bg-subtle', '--accent'].map((v) => resolve(`var(${v})`))
    const defaults = new Map()
    if (![bg, elevated, subtle].includes('rgb(255, 255, 255)')) for (const w of ['rgb(255, 255, 255)', 'rgb(254, 254, 254)']) defaults.set(w, 'white')
    if (![resolve('#6d4aff'), resolve('#8b6dff')].includes(accent)) for (const v of ['#6d4aff', '#8b6dff', '#5b37f0']) defaults.set(resolve(v), 'default violet')
    for (const v of ['#2a78d6', '#3987e5']) defaults.set(resolve(v), 'default chart blue')
    probe.remove()
    defaults.delete('')
    const out = []
    for (const el of document.querySelectorAll('body *')) {
      if (!(el instanceof HTMLElement || el instanceof SVGElement)) continue
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) continue
      const s = getComputedStyle(el)
      if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) continue
      for (const [prop, value] of [['background', s.backgroundColor], ['text', el.textContent?.trim() ? s.color : ''], ['border', s.borderTopWidth !== '0px' && s.borderTopStyle !== 'none' ? s.borderTopColor : ''], ['fill', s.fill], ['stroke', s.stroke], ['outline', s.outlineStyle !== 'none' ? s.outlineColor : '']]) {
        const what = value ? defaults.get(value) : undefined
        if (!what) continue
        const name = `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? `.${el.className.split(/\s+/).filter((c) => !/[[:\]/]/.test(c)).slice(0, 3).join('.')}` : ''}${el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label')}]` : ''}`
        out.push(`${prop} ${what}: ${name}`)
      }
    }
    return [...new Set(out)]
  })
  for (const h of hits) found.set(h, [...(found.get(h) ?? []), `${look}-${String(n).padStart(2, '0')}`])
}
const shot = async (name) => {
  await win.screenshot({ path: `${out}/${name}-${String(++n).padStart(2, '0')}.png` })
  if (process.env.SWEEP) await sweep(name)
}
try {
  await win.waitForTimeout(800)
  await win.getByRole('button', { name: /demo database|ukázkovou/ }).first().click()
  // The demo opens on its orders table: the script's statements go into a query tab of their own.
  await win.getByPlaceholder(/Filter .+ tables|Filtrovat/).waitFor({ timeout: 20000 })
  await win.keyboard.press(`${mod}+t`)
  await win.waitForTimeout(800)
  await win.locator('.cm-content:visible').first().click()
  await win.keyboard.press(`${mod}+a`)
  await win.keyboard.insertText("BEGIN;\nUPDATE products SET price = price + 1 WHERE id = 1;\n-- top products\nSELECT p.id, p.name, p.price, c.name AS category FROM products p JOIN categories c ON c.id = p.category_id ORDER BY p.price DESC LIMIT 30;")
  await win.keyboard.press(`${mod}+Shift+Enter`)
  await win.waitForTimeout(800)
  await win.getByPlaceholder(/Filter .+ tables|Filtrovat/).fill('customers')
  await win.getByPlaceholder(/Filter .+ tables|Filtrovat/).press('Enter')
  await win.waitForTimeout(1000)
  const grid = win.locator('[tabindex="0"].overflow-auto').last()
  await grid.locator('div').filter({ hasText: /@/ }).first().dblclick().catch(() => {})
  await win.keyboard.type('x')
  await win.keyboard.press('Enter')
  await palette('ER diagram')
  await tab(/(Query|Dotaz) 1/).click()
  await win.getByRole('button', { name: /all connections|všechna připojení/i }).first().click()
  await win.getByRole('button', { name: /^(New model|Nový model)$/ }).first().click()
  await win.waitForTimeout(1200)
  await win.locator('.cm-content:visible').first().click().catch(() => {})
  await win.keyboard.insertText('Table shop.customer {\n  id bigint [pk]\n  name text [not null]\n  email text\n}\n\nTable shop.invoice {\n  id bigint [pk]\n  customer_id bigint [ref: > shop.customer.id]\n  total numeric(12,2)\n}\n')
  await win.waitForTimeout(1500)
  // A dashboard with charts of several series (bars and lines) and a single value: the series take the look's colours.
  {
    const connectionId = await win.evaluate(() => window.mastermind.api.listConnections().then((l) => l[0].id))
    const by = 'FROM products p JOIN categories c ON c.id = p.category_id GROUP BY c.name ORDER BY c.name'
    await win.evaluate((d) => window.mastermind.api.saveDashboard(d), {
      connectionId,
      name: 'Looks review',
      refreshSeconds: 0,
      tiles: [
        { id: 't1', title: 'Prices by category', span: 2, chart: { kind: 'bar', x: 0, ys: [1, 2, 3, 4, 5, 6] }, sql: `SELECT c.name AS category, count(*) AS items, min(p.price) AS min_price, avg(p.price) AS avg_price, max(p.price) AS max_price, sum(p.price) / 10 AS total_tenth, count(*) * 2 AS double_items ${by}` },
        { id: 't2', title: 'Price lines', span: 1, chart: { kind: 'line', x: 0, ys: [1, 2, 3] }, sql: 'SELECT id, price, price * 0.8 AS sale, price * 1.25 AS list FROM products ORDER BY id LIMIT 20' },
        { id: 't3', title: 'Products', span: 1, chart: null, sql: 'SELECT count(*) AS products FROM products' },
      ],
    })
    await tab(/(Query|Dotaz) 1/).click()
    await palette('Dashboards')
    await win.locator('[data-testid="dashboard-card"]', { hasText: 'Looks review' }).first().click()
    await win.waitForTimeout(1500)
  }

  for (const name of looks) {
    n = 0
    // <look>[-dark][-hc][-compact]
    const [id, ...mods] = name.split('-')
    await settings(/^(Appearance|Vzhled)$/)
    await win.locator(`[role=dialog] [data-look="${id}"]`).click()
    const option = async (re) => win.locator('[role=dialog]').getByRole('button', { name: re }).click({ timeout: 2000 }).catch(() => {})
    await option(mods.includes('dark') ? /^(Dark|Tmavý)$/ : /^(Light|Světlý)$/)
    await option(mods.includes('hc') ? /^(High|Vysoký)$/ : /^(Normal|Normální)$/)
    await option(mods.includes('compact') ? /^(Compact|Kompaktní)$/ : /^(Comfortable|Běžná)$/)
    await win.waitForTimeout(300)
    await shot(name) // 01 Settings → Appearance
    await win.locator('[role=dialog] nav button').filter({ hasText: /^(General|Obecné)$/ }).click()
    await win.waitForTimeout(200)
    await shot(name) // 02 Settings → General
    await win.keyboard.press('Escape')
    await tab(/(Query|Dotaz) 1/).click()
    await win.getByRole('button', { name: /all connections|všechna připojení/i }).first().click()
    await win.waitForTimeout(400)
    await shot(name) // 03 home
    for (const re of [/(Query|Dotaz) 1/, /customers/, /diagram/i, /(model|Model)/]) {
      await tab(re).click()
      await win.waitForTimeout(600)
      await shot(name) // 04 query, 05 table, 06 diagram, 07 model
    }
    await tab(/(Query|Dotaz) 1/).click()
    await win.keyboard.press(`${mod}+j`)
    await win.waitForTimeout(500)
    await shot(name) // 08 AI panel
    await win.keyboard.press(`${mod}+j`)
    await win.keyboard.press(`${mod}+k`)
    await win.waitForTimeout(400)
    await shot(name) // 09 palette
    await win.keyboard.press('Escape')
    await win.keyboard.press(`${mod}+w`)
    await win.getByRole('dialog').waitFor({ timeout: 5000 }).catch(() => {})
    await win.waitForTimeout(300)
    await shot(name) // 10 close-tab question
    await win.getByRole('dialog').getByRole('button', { name: /^(Cancel|Zrušit|Keep open|Nezavírat)$/ }).click().catch(() => {})
    await win.keyboard.press(`${mod}+Shift+n`)
    await win.waitForTimeout(500)
    await shot(name) // 11 connection form
    await win.keyboard.press('Escape')
    await win.waitForTimeout(200)
    await tab(/Looks review/).click()
    await win.waitForTimeout(800)
    await shot(name) // 12 dashboard (chart series, single value)
  }
  execFileSync('python3', ['-I', '-c', `
import sys, glob
from PIL import Image
out = sys.argv[1]
for look in sys.argv[2].split(','):
    files = sorted(glob.glob(f'{out}/{look}-[0-9][0-9].png'))
    w, h = 683, 410
    cols = 3
    rows = (len(files) + cols - 1) // cols
    sheet = Image.new('RGB', (w * cols, h * rows), 'white')
    for i, f in enumerate(files):
        sheet.paste(Image.open(f).resize((w, h)), ((i % cols) * w, (i // cols) * h))
    sheet.save(f'{out}/{look}.png')
`, out, looks.join(',')])
  console.log('errors:', errors.length ? errors : 'none')
  if (process.env.SWEEP) for (const [hit, where] of found) console.log(`SWEEP ${hit}  (${where.slice(0, 6).join(' ')}${where.length > 6 ? ` +${where.length - 6}` : ''})`)
} catch (err) {
  await win.screenshot({ path: `${out}/failure.png` }).catch(() => {})
  throw err
} finally {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
  }).catch(() => {})
  // The new model is unsaved and the query's transaction open: quitting asks about both, and the review discards them.
  let closed = false
  const closing = app.close().then(() => (closed = true))
  for (let i = 0; i < 4 && !closed; i++) {
    await win.getByRole('dialog').getByRole('button', { name: /^(Discard changes|Zahodit změny|Roll back|Rollback|Vrátit zpět|Vrátit)$/ }).first().click({ timeout: 3000 }).catch(() => {})
  }
  // (A question nobody can answer from here: the shots are taken, the app is ended.)
  await Promise.race([closing, new Promise((r) => setTimeout(r, 15000))])
  if (!closed) app.process().kill()
}

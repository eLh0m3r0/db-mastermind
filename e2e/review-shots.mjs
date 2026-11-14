// Screens for a design review, in several looks: home, query with results and an open transaction, a table with an
// edit, the ER diagram, a new model, Settings (General, Appearance), the connection form, the AI panel, the command
// palette and the close-tab question. `node e2e/review-shots.mjs <dir>` → <look>-<nn>.png and a sheet <look>.png.
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
const shot = async (name) => win.screenshot({ path: `${out}/${name}-${String(++n).padStart(2, '0')}.png` })
try {
  await win.waitForTimeout(800)
  await win.getByRole('button', { name: /demo database|ukázkovou/ }).first().click()
  await win.waitForTimeout(2000)
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
  await win.getByRole('button', { name: /All connections|Všechna připojení/ }).first().click()
  await win.getByRole('button', { name: /^(New model|Nový model)$/ }).first().click()
  await win.waitForTimeout(1200)
  await win.locator('.cm-content:visible').first().click().catch(() => {})
  await win.keyboard.insertText('Table shop.customer {\n  id bigint [pk]\n  name text [not null]\n  email text\n}\n\nTable shop.invoice {\n  id bigint [pk]\n  customer_id bigint [ref: > shop.customer.id]\n  total numeric(12,2)\n}\n')
  await win.waitForTimeout(1500)

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
    await win.getByRole('button', { name: /All connections|Všechna připojení/ }).first().click()
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
} catch (err) {
  await win.screenshot({ path: `${out}/failure.png` }).catch(() => {})
  throw err
} finally {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
  }).catch(() => {})
  await app.close()
}

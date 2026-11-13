// Every look on the screens people use: Settings → Appearance, a query with results and an open transaction, a
// table with an edit, the ER diagram, the home screen and the connection form. `node e2e/look-tour.mjs <dir>`
// writes <look>-<screen>.png and, with Python + Pillow, one contact sheet per look (<look>.png).
import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? tmpdir()
const looks = (process.env.LOOKS ?? 'violet,violet-dark,blue-dark,retro2001,terminal,halloween,christmas,medieval,fantasy').split(',')
const dir = mkdtempSync(join(tmpdir(), 'dbm-looks-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(dir, 'h'), DBM_USER_DATA: join(dir, 'd'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: process.env.DBM_LANGUAGE ?? 'cs', DBM_E2E_BACKGROUND: '1' } })
const win = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800))
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const tab = (name) => win.getByRole('tab', { name: new RegExp(`^${name}`) }).first()
const settings = async () => {
  await win.keyboard.press(`${mod}+,`)
  await win.locator('[role=dialog] nav button').filter({ hasText: /^(Appearance|Vzhled)$/ }).click()
  await win.waitForTimeout(250)
}
try {
  await win.waitForTimeout(800)
  await win.getByRole('button', { name: /demo database|ukázkovou/ }).first().click()
  await win.waitForTimeout(2000)
  // A query tab with results and an open transaction.
  await win.locator('.cm-content:visible').first().click()
  await win.keyboard.press(`${mod}+a`)
  await win.keyboard.insertText("BEGIN;\nUPDATE products SET price = price + 1 WHERE id = 1;\n-- prices\nSELECT id, name, price, 'note' AS label FROM products LIMIT 30;")
  await win.keyboard.press(`${mod}+Shift+Enter`)
  await win.waitForTimeout(800)
  // A table tab with a pending edit.
  await win.getByPlaceholder(/Filter .+ tables|Filtrovat/).fill('customers')
  await win.getByPlaceholder(/Filter .+ tables|Filtrovat/).press('Enter')
  await win.waitForTimeout(1000)
  const grid = win.locator('[tabindex="0"].overflow-auto').last()
  const cell = grid.locator('[role=gridcell], div').filter({ hasText: /@/ }).first()
  await cell.dblclick().catch(() => {})
  await win.keyboard.type('x')
  await win.keyboard.press('Enter')
  // The ER diagram.
  await win.keyboard.press('Escape')
  await win.locator('body').click({ position: { x: 5, y: 790 } })
  await win.keyboard.press(`${mod}+k`)
  await win.getByPlaceholder(/command|příkaz/i).waitFor({ timeout: 5000 })
  await win.keyboard.type('ER diagram')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(2500)

  for (const name of looks) {
    const [id, mode] = name.split('-')
    await settings()
    await win.locator(`[role=dialog] [data-look="${id}"]`).click()
    if (mode) await win.locator('[role=dialog]').getByRole('button', { name: /^(Dark|Tmavý)$/ }).click().catch(() => {})
    else if (id === 'violet') await win.locator('[role=dialog]').getByRole('button', { name: /^(Light|Světlý)$/ }).click().catch(() => {})
    await win.waitForTimeout(300)
    await win.screenshot({ path: `${out}/${name}-1-settings.png` })
    await win.keyboard.press('Escape')
    for (const [i, t] of [[2, /(Query|Dotaz) 1/], [3, /customers/], [4, /diagram/i]]) {
      await win.getByRole('tab', { name: t }).first().click()
      await win.waitForTimeout(500)
      await win.screenshot({ path: `${out}/${name}-${i}.png` })
    }
    await win.getByRole('button', { name: /All connections|Všechna připojení/ }).first().click()
    await win.waitForTimeout(400)
    await win.screenshot({ path: `${out}/${name}-5-home.png` })
    await win.getByRole('tab').first().click()
    await win.keyboard.press(`${mod}+Shift+n`)
    await win.waitForTimeout(500)
    await win.screenshot({ path: `${out}/${name}-6-form.png` })
    await win.keyboard.press('Escape')
    await win.waitForTimeout(200)
  }
  try {
    execFileSync('python3', ['-I', '-c', `
import sys, glob
from PIL import Image
out = sys.argv[1]
for look in sys.argv[2].split(','):
    files = sorted(glob.glob(f'{out}/{look}-[0-9]*.png'))
    if not files: continue
    ims = [Image.open(f) for f in files]
    w, h = 960, 600
    sheet = Image.new('RGB', (w * 2, h * 3), 'white')
    for i, im in enumerate(ims[:6]):
        sheet.paste(im.resize((w, h)), ((i % 2) * w, (i // 2) * h))
    sheet.save(f'{out}/{look}.png')
`, out, looks.join(',')])
  } catch (err) {
    console.log('no contact sheets:', err.message)
  }
  console.log('errors:', errors.length ? errors : 'none')
} finally {
  // The open transaction would make quitting ask (a native dialog): roll it back.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
  }).catch(() => {})
  await app.close()
}

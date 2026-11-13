// Settings → Appearance: density, accent colors and the playful looks (an easter egg), each applied to the demo
// database with a table and a query result on screen; the choice survives a restart of the window.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? tmpdir()
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui99-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: process.env.DBM_LANGUAGE ?? 'en', DBM_E2E_BACKGROUND: '1' } })
const win = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800))
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const check = (label, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) process.exitCode = 1
}
const appearance = async () => {
  await win.keyboard.press(`${mod}+,`)
  await win.locator('[role=dialog] nav button').filter({ hasText: /^(Appearance|Vzhled)$/ }).click()
}
const pick = async (id) => {
  await appearance()
  await win.locator(`[role=dialog] [data-look="${id}"]`).click()
  await win.keyboard.press('Escape')
  await win.waitForTimeout(300)
}
const rootClasses = () => win.evaluate(() => document.documentElement.className)
try {
  await win.waitForTimeout(800)
  await win.getByRole('button', { name: /demo database|ukázkovou/ }).first().click()
  await win.waitForTimeout(2000)
  await win.getByPlaceholder(/Filter .+ tables|Filtrovat/).fill('orders')
  await win.getByPlaceholder(/Filter .+ tables|Filtrovat/).press('Enter')
  await win.waitForTimeout(1200)
  await win.keyboard.press(`${mod}+t`)
  await win.locator('.cm-content:visible').first().click()
  await win.keyboard.insertText('SELECT * FROM products LIMIT 20')
  await win.keyboard.press(`${mod}+Enter`)
  await win.waitForTimeout(800)

  await appearance()
  await win.screenshot({ path: `${out}/r99-settings.png` })
  check('theme and contrast moved to Appearance', (await win.locator('[role=dialog]').getByText(/^(Contrast|Kontrast)$/).count()) === 1)
  await win.locator('[role=dialog]').getByRole('button', { name: /^(Compact|Kompaktní)$/ }).click()
  await win.keyboard.press('Escape')
  await win.waitForTimeout(400)
  check('compact density applies', (await rootClasses()).includes('compact'))
  await win.screenshot({ path: `${out}/r99-compact.png` })

  for (const id of ['blue', 'rose', 'retro2001', 'terminal', 'commander', 'halloween', 'christmas', 'medieval', 'fantasy']) {
    await pick(id)
    check(`look ${id} applies`, (await rootClasses()).includes(`look-${id}`))
    await win.screenshot({ path: `${out}/r99-${id}.png` })
  }
  check('a dark look forces the dark palette', (await rootClasses()).split(' ').includes('dark'))
  await win.reload()
  await win.waitForTimeout(1500)
  check('the look survives a reload', (await rootClasses()).includes('look-fantasy'))
  // Clicking the chosen playful look again goes back to the usual one.
  await appearance()
  await win.locator('[role=dialog] [data-look="fantasy"]').click()
  await win.keyboard.press('Escape')
  await win.waitForTimeout(300)
  check('clicking it again restores the usual look', (await rootClasses()).includes('look-violet'))
  console.log('errors:', errors.length ? errors : 'none')
} catch (err) {
  await win.screenshot({ path: `${out}/r99-failure.png` }).catch(() => {})
  console.log('errors:', errors)
  throw err
} finally {
  await app.close()
}

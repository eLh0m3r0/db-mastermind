// Settings → Appearance: the look first (accent colors and the playful looks as the same cards), then only what applies
// to it (mode and contrast for the standard looks), density; colors really change (also inside the ER diagram, whose
// library adds its own "dark" class); the choice survives a reload. Screens of every look: e2e/look-tour.mjs.
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
  check('mode and contrast are offered for a standard look', (await win.locator('[role=dialog]').getByText(/^(Contrast|Kontrast)$/).count()) === 1)
  await win.locator('[role=dialog]').getByRole('button', { name: /^(Compact|Kompaktní)$/ }).click()
  await win.keyboard.press('Escape')
  await win.waitForTimeout(400)
  check('compact density applies', (await rootClasses()).includes('compact'))
  await win.screenshot({ path: `${out}/r99-compact.png` })

  const accent = () => win.evaluate(() => getComputedStyle(document.querySelector('.bg-accent') ?? document.body).backgroundColor)
  for (const id of ['blue', 'rose', 'retro2001', 'terminal', 'halloween', 'christmas', 'medieval', 'fantasy']) {
    const before = await accent()
    await pick(id)
    check(`look ${id} applies and changes the colors`, (await rootClasses()).includes(`look-${id}`) && (await accent()) !== before)
    await win.screenshot({ path: `${out}/r99-${id}.png` })
  }
  await appearance()
  check('a look with its own colors hides mode and contrast', (await win.getByTestId('own-palette').count()) === 1 && (await win.locator('[role=dialog]').getByText(/^(Contrast|Kontrast)$/).count()) === 0)
  await win.keyboard.press('Escape')
  check('the title bar carries no look picture (it sat next to the AI button)', (await win.locator('.drag-region [data-testid=look-decoration]').count()) === 0)
  // A look with a font of its own: Font → Standard keeps the usual one.
  await pick('retro2001')
  const font = () => win.evaluate(() => getComputedStyle(document.body).fontFamily)
  check('Retro 2001 brings its own font', /Tahoma/.test(await font()))
  await appearance()
  await win.locator('[role=dialog]').getByRole('button', { name: /^Standard$/ }).click()
  await win.keyboard.press('Escape')
  await win.waitForTimeout(200)
  check('Font → Standard keeps the usual font', !/Tahoma/.test(await font()) && (await rootClasses()).includes('standard-font'))
  await pick('halloween')
  await appearance()
  check('looks without a font of their own offer no Font setting', (await win.locator('[role=dialog]').getByText(/^Font$/).count()) === 0)
  await win.keyboard.press('Escape')
  await pick('fantasy')
  // Inside the diagram (React Flow sets its own "dark" class) the look's accent applies too.
  await win.keyboard.press(`${mod}+k`)
  await win.keyboard.type('ER diagram')
  await win.keyboard.press('Enter')
  await win.locator('.react-flow__node .bg-accent').first().waitFor({ timeout: 10000 })
  const header = await win.locator('.react-flow__node .bg-accent').first().evaluate((e) => getComputedStyle(e).backgroundColor)
  check('diagram headers take the look’s accent', header === (await win.evaluate(() => getComputedStyle(document.querySelector('[role=tab] .bg-accent') ?? document.body).backgroundColor)))
  check('a dark look forces the dark palette', (await rootClasses()).split(' ').includes('dark'))
  await win.reload()
  await win.waitForTimeout(1500)
  check('the look survives a reload', (await rootClasses()).includes('look-fantasy'))
  await pick('violet')
  check('back to the usual look', (await rootClasses()).includes('look-violet') && (await win.getByTestId('look-decoration').count()) === 0)
  console.log('errors:', errors.length ? errors : 'none')
} catch (err) {
  await win.screenshot({ path: `${out}/r99-failure.png` }).catch(() => {})
  console.log('errors:', errors)
  throw err
} finally {
  await app.close()
}

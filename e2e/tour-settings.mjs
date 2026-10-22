// Screenshots of the home screen, the demo database and every Settings section: `node e2e/tour-settings.mjs <dir>`
// (DBM_LANGUAGE picks the language; Czech by default).
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const dir = mkdtempSync(join(tmpdir(), 'dbm-cs-'))
const app = await electron.launch({ args: ['apps/desktop', ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [])], env: { ...process.env, HOME: dir, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: process.env.DBM_LANGUAGE ?? 'cs' } })
const win = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800))
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
try {
  await win.waitForTimeout(1000)
  await win.screenshot({ path: `${out}/cs-0-home.png` })
  await win.getByRole('button', { name: /ukázkovou|demo database/ }).first().click()
  await win.waitForTimeout(2500)
  await win.screenshot({ path: `${out}/cs-1-demo.png` })
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,')
  await win.waitForTimeout(800)
  await win.screenshot({ path: `${out}/cs-2-settings.png` })
  const items = win.locator('[role=dialog] nav button')
  const names = await items.allInnerTexts()
  console.log('sections:', names)
  for (let i = 0; i < names.length; i++) {
    await items.nth(i).click()
    await win.waitForTimeout(400)
    await win.screenshot({ path: `${out}/cs-s${i}.png` })
  }
} finally {
  console.log('errors:', errors.length ? errors : 'none')
  await app.close()
}

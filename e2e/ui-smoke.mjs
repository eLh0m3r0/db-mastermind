// UI smoke test of a packaged build on any OS: launches the real executable with Playwright, opens the demo
// database and walks the main screens, saving screenshots. Usage: node e2e/ui-smoke.mjs <exe> <out-dir>
import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [exe, out = 'ui-shots'] = process.argv.slice(2)
mkdirSync(out, { recursive: true })
const userData = mkdtempSync(join(tmpdir(), 'dbm-uismoke-'))
const app = await electron.launch({
  executablePath: exe,
  args: process.platform === 'linux' ? ['--no-sandbox'] : [],
  env: { ...process.env, DBM_USER_DATA: userData, DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' },
})
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1366, 820))
const shot = (name) => win.screenshot({ path: join(out, `${name}.png`) })
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
let failed = false
try {
  await win.waitForTimeout(1500)
  await shot('01-home')
  await win.getByRole('button', { name: 'Try the demo database' }).click()
  await win.getByPlaceholder(/Filter \d+ tables/).waitFor({ timeout: 30000 })
  await win.getByPlaceholder(/Filter \d+ tables/).fill('orders')
  await win.getByPlaceholder(/Filter \d+ tables/).press('Enter')
  await win.waitForTimeout(1500)
  await shot('02-table')
  await win.keyboard.press(`${mod}+t`)
  await win.waitForTimeout(500)
  await win.locator('.cm-content').last().click()
  await win.keyboard.type('select status, count(*) as n from orders group by status order by n desc')
  await win.keyboard.press('Escape')
  await win.keyboard.press(`${mod}+Enter`)
  await win.getByText('shipped').first().waitFor({ timeout: 15000 })
  await shot('03-query')
  await win.keyboard.press(`${mod}+k`)
  await win.keyboard.type('ER diagram')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(3000)
  await shot('04-diagram')
} catch (err) {
  failed = true
  console.error('UI smoke failed:', err.message.split('\n')[0])
  await shot('99-failure').catch(() => {})
} finally {
  await app.close()
}
if (errors.length) console.error('Renderer errors:', errors)
if (failed || errors.length) process.exit(1)
console.log('UI SMOKE OK')

// Pinned columns stay put while the grid scrolls sideways; clicks on them hit the right cell.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: mkdtempSync(join(tmpdir(), 'dbm-ui37-')), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 700))
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  await api('createSampleDatabase')
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Demo coffee shop/ }).first().click()
  await win.waitForTimeout(1500)
  await win.getByText('customers', { exact: true }).first().click()
  await win.waitForTimeout(1500)
  await win.getByText('last_name', { exact: true }).first().click({ button: 'right' })
  await win.getByText('Pin columns up to here').click()
  await win.waitForTimeout(300)
  const grid = win.locator('div[tabindex="0"].overflow-auto').last()
  await grid.evaluate((el) => (el.scrollLeft = el.scrollWidth))
  await win.waitForTimeout(400)
  console.log('scrollLeft:', await grid.evaluate((el) => el.scrollLeft))
  await win.screenshot({ path: `${out}/r6-pinned.png` })
  // Click the second row's last_name (pinned) after scrolling, then open it.
  const box = await win.getByText('last_name', { exact: true }).first().boundingBox()
  await win.mouse.click(box.x + 20, box.y + 30 + 34)
  await win.keyboard.press('Shift+Enter')
  await win.waitForTimeout(400)
  console.log('viewer title:', await win.locator('[role="dialog"] h2, [role="dialog"] header').first().innerText().catch(() => '?'))
  await win.keyboard.press('Escape')
  await win.reload()
  await win.waitForTimeout(1500)
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/r6-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

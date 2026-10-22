// Live designer + AI: the assistant's DBML becomes pending design changes and a migration.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: mkdtempSync(join(tmpdir(), 'dbm-ui45-')), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
// Keep the window out of the way: off to the right and unfocused.
await app.evaluate(({ BrowserWindow, screen }) => { const w = BrowserWindow.getAllWindows()[0]; const a = screen.getPrimaryDisplay().workArea; w.setBounds({ x: a.x + a.width - 24, y: a.y + 40, width: 1440, height: 900 }); w.blur() })
win.setDefaultTimeout(30000)
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  await api('updateSettings', { ai: { providers: [{ id: 'claude-code', enabled: true, model: 'haiku' }], activeProvider: 'claude-code', dataSharing: 'schema', autoRunReadQueries: true } })
  await api('createSampleDatabase')
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Demo coffee shop/ }).first().click()
  await win.waitForTimeout(1500)
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('Open ER diagram')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(2000)
  await win.getByRole('button', { name: 'Design', exact: true }).click()
  await win.getByRole('button', { name: 'Design with AI…' }).click()
  await win.getByRole('dialog').locator('textarea').fill('add a nullable deleted_at column (TEXT) to the customers table for soft delete; change nothing else')
  await win.keyboard.press('Enter')
  const apply = win.getByRole('button', { name: 'Apply to design' }).last()
  await apply.waitFor({ timeout: 60000 })
  await apply.click()
  await win.waitForTimeout(800)
  console.log('review:', await win.getByRole('button', { name: /Review migration/ }).innerText())
  await win.getByRole('button', { name: /Review migration/ }).click()
  await win.waitForTimeout(800)
  const script = await win.locator('[role="dialog"] pre').last().innerText()
  console.log('script:', script.replace(/\n/g, ' ⏎ ').slice(0, 300))
  await win.screenshot({ path: `${out}/r14-ai-design.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/r14-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

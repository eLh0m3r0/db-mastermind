// Inline ⌘I and Fix with AI with Codex as the provider (needs the codex CLI signed in; two real model calls).
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui80-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
win.setDefaultTimeout(60000)
await app.evaluate(({ BrowserWindow, screen }) => { const w = BrowserWindow.getAllWindows()[0]; const a = screen.getPrimaryDisplay().workArea; w.setBounds({ x: a.x + a.width - 24, y: a.y + 40, width: 1440, height: 900 }); w.blur() })
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const editor = () => win.locator('.cm-content:visible').first()
const waitForAi = async () => {
  for (let i = 0; i < 90; i++) {
    await win.waitForTimeout(2000)
    if (!(await win.getByRole('button', { name: 'Write SQL' }).count())) return
  }
  throw new Error('AI did not finish in 3 minutes')
}
try {
  await win.waitForTimeout(800)
  const s = await api('getSettings')
  await api('updateSettings', { ai: { ...s.ai, providers: [{ id: 'codex' }], activeProvider: 'codex', autoRunReadQueries: true } })
  await api('createSampleDatabase')
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Demo coffee shop/ }).first().click()
  await win.waitForTimeout(1500)

  await editor().click()
  await win.keyboard.press('Meta+i')
  await win.waitForTimeout(300)
  await win.keyboard.type('number of orders per status')
  await win.keyboard.press('Enter')
  await waitForAi()
  const written = await editor().innerText()
  console.log('⌘I wrote SELECT on orders:', /select/i.test(written) && /orders/i.test(written), '|', written.replace(/\s+/g, ' ').slice(0, 160))

  await win.keyboard.press('Meta+a')
  await win.keyboard.press('Backspace')
  await win.keyboard.insertText('SELECT first_name, last_nme FROM customers LIMIT 3;')
  await win.keyboard.press('Meta+Enter')
  await win.getByRole('button', { name: 'Fix with AI' }).click()
  await waitForAi()
  await win.keyboard.press('Meta+Enter')
  await win.waitForTimeout(2000)
  const fixed = await editor().innerText()
  console.log('fixed:', /last_name/.test(fixed), '| error still shown:', await win.getByRole('button', { name: 'Fix with AI' }).count(), '|', fixed.replace(/\s+/g, ' ').slice(0, 120))
  console.log('ok')
} catch (err) {
  await win.screenshot({ path: join(dir, 'flow80-fail.png') }).catch(() => {})
  console.log('screenshot', join(dir, 'flow80-fail.png'))
  throw err
} finally {
  await app.close()
}

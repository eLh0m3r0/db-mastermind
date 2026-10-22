// Fix with AI: a failing statement is rewritten by AI (Claude Code provider) and runs.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const userData = mkdtempSync(join(tmpdir(), 'dbm-ui16-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: userData, DBM_NO_UPDATE_CHECK: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  await api('updateSettings', { ai: { activeProvider: 'claude-code', providers: [{ id: 'claude-code', enabled: true }], dataSharing: 'schema-and-samples', autoRunReadQueries: true } })
  await api('createSampleDatabase')
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Demo coffee shop/ }).first().click()
  await win.waitForTimeout(1500)
  await win.locator('.cm-content').first().click()
  await win.keyboard.insertText('SELECT first_name, last_nme, count(*) AS orders FROM customers JOIN orders ON orders.customer = customers.id GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 5;')
  await win.keyboard.press('Meta+Enter')
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: 'Fix with AI' }).click()
  for (let i = 0; i < 90; i++) {
    await win.waitForTimeout(2000)
    if (!(await win.getByRole('button', { name: 'Write SQL' }).count())) break
  }
  await win.waitForTimeout(300)
  await win.keyboard.press('Meta+Enter')
  await win.waitForTimeout(2000)
  console.log('sql:', (await win.locator('.cm-content').first().innerText()).slice(0, 400))
  await win.screenshot({ path: `${out}/c1-fix-ai.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/99-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

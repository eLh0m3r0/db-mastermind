// Model + AI: the assistant extends the model, "Apply to model" puts it into the editor and diagram.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: mkdtempSync(join(tmpdir(), 'dbm-ui21-')), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
win.on('dialog', (d) => d.accept())
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
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('New model')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(800)
  await win.locator('.cm-content').last().click()
  await win.keyboard.insertText('Table customers {\n  id integer [pk, increment]\n  name varchar [not null]\n}\n')
  await win.getByRole('button', { name: 'Design with AI' }).click()
  await win.waitForTimeout(500)
  const input = win.getByPlaceholder(/Ask about/)
  await input.fill((await input.inputValue()).replace('Help me design', 'Extend this model with orders and order items for a small coffee shop. Do not ask questions. Help me design'))
  await input.press('Enter')
  await win.getByRole('button', { name: 'Apply to model' }).first().waitFor({ timeout: 240000 })
  await win.getByRole('button', { name: 'Apply to model' }).first().click()
  await win.waitForTimeout(2500)
  const text = await win.locator('.cm-content').first().innerText()
  console.log('model has orders:', /Table\s+"?order/i.test(text), '| lines:', text.split('\n').length)
  await win.screenshot({ path: `${out}/f2-model-ai.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/99-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

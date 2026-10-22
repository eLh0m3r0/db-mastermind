// Value editor: Shift+Enter on a table cell, JSON validation, Minify, Apply.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: mkdtempSync(join(tmpdir(), 'dbm-ui35-')), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
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
  await win.getByText('products', { exact: true }).first().click()
  await win.waitForTimeout(1500)
  const cell = win.getByText('Espresso Blend 500 g', { exact: true }).first()
  await cell.click()
  await win.keyboard.press('Shift+Enter')
  const area = win.locator('textarea').last()
  await area.waitFor({ timeout: 5000 })
  console.log('draft:', await area.inputValue())
  await area.fill('{"a": 1')
  console.log('warning shown:', await win.getByText(/Invalid JSON/).count(), 'apply disabled:', await win.getByRole('button', { name: 'Apply' }).isDisabled())
  await area.fill('{\n  "a": 1,\n  "b": [1, 2]\n}')
  await win.getByRole('button', { name: 'Minify' }).click()
  console.log('minified:', await area.inputValue())
  await win.screenshot({ path: `${out}/r3-value-editor.png` })
  await win.getByRole('button', { name: 'Apply' }).click()
  await win.waitForTimeout(500)
  console.log('cell now:', await win.getByText('{"a":1,"b":[1,2]}').count())
  await win.screenshot({ path: `${out}/r4-after-apply.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/r3-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

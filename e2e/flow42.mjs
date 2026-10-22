// Split view: a query next to a table; Cmd+Enter runs only the focused pane.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: mkdtempSync(join(tmpdir(), 'dbm-ui42-')), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const ws = () => win.evaluate(() => document.querySelectorAll('[role="tab"]').length)
try {
  await win.waitForTimeout(800)
  await api('createSampleDatabase')
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Demo coffee shop/ }).first().click()
  await win.waitForTimeout(1500)
  await win.locator('.cm-content').first().click()
  await win.keyboard.insertText('SELECT 7 AS seven')
  await win.getByText('customers', { exact: true }).first().click()
  await win.waitForTimeout(1200)
  // Put the table on the right, the query stays on the left.
  await win.getByRole('tab', { name: /customers/ }).click({ button: 'right' })
  await win.getByText('Open to the side').click()
  await win.waitForTimeout(600)
  console.log('tabs:', await ws(), 'visible editors:', await win.locator('.cm-content:visible').count(), 'table visible:', await win.getByText('Dvořák').first().isVisible())
  // Focus the query pane and run it.
  await win.locator('.cm-content:visible').first().click()
  await win.keyboard.press('Meta+Enter')
  await win.waitForTimeout(1000)
  console.log('query ran:', await win.getByText('seven', { exact: true }).first().isVisible())
  await win.screenshot({ path: `${out}/r11-split.png` })
  // Close the split with the shortcut.
  await win.keyboard.press('Meta+\\')
  await win.waitForTimeout(400)
  console.log('after ⌘\\\\: table visible:', await win.getByText('Dvořák').first().isVisible(), 'editor visible:', await win.locator('.cm-content:visible').count())
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/r11-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

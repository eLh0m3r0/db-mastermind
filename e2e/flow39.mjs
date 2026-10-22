// Migration review: leave individual changes out of the script.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: mkdtempSync(join(tmpdir(), 'dbm-ui38-')), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const review = async () => `${await win.locator('.react-flow__node').count()} nodes`
try {
  await win.waitForTimeout(800)
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
  await win.getByRole('button', { name: 'New table', exact: true }).first().click()
  await win.waitForTimeout(300)
  await win.getByRole('button', { name: 'New table', exact: true }).first().click()
  await win.waitForTimeout(300)
  await win.getByRole('button', { name: /Review migration/ }).click()
  await win.waitForTimeout(800)
  const pre = win.locator('[role="dialog"] pre').last()
  const before = await pre.innerText()
  console.log('script has both:', before.includes('new_table_1'), before.includes('new_table_2'))
  await win.locator('[role="dialog"] label').filter({ hasText: 'new_table_1' }).locator('input').uncheck()
  await win.waitForTimeout(300)
  const after = await pre.innerText()
  console.log('after uncheck:', after.includes('new_table_1'), after.includes('new_table_2'))
  console.log('title:', await win.locator('[role="dialog"]').getByText(/^Migration ·/).innerText())
  await win.screenshot({ path: `${out}/r8-toggle.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/r7-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

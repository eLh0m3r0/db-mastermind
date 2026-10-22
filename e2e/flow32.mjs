// Pinned results: keep one result while running the next query.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: mkdtempSync(join(tmpdir(), 'dbm-ui32-')), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const run = async (sql) => {
  await win.locator('.cm-content').first().click()
  await win.keyboard.press('Meta+a')
  await win.keyboard.insertText(sql)
  await win.keyboard.press('Meta+Enter')
  await win.waitForTimeout(1000)
}
try {
  await win.waitForTimeout(800)
  await api('createSampleDatabase')
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Demo coffee shop/ }).first().click()
  await win.waitForTimeout(1500)
  await run("SELECT country, count(*) AS customers FROM customers GROUP BY country ORDER BY 2 DESC")
  await win.getByRole('button', { name: 'Keep this result (pin)' }).click()
  await run("SELECT city, count(*) AS customers FROM customers GROUP BY city ORDER BY 2 DESC")
  console.log('tabs:', (await win.locator('button', { hasText: /^(Pinned|Result)/ }).allInnerTexts()).map((s) => s.replace(/\s+/g, ' ')).join(' | '))
  await win.screenshot({ path: `${out}/r0-pinned-result.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

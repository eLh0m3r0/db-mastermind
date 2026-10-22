// Model + AI task: "Suggest indexes" proposes an updated model that applies to the editor.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: mkdtempSync(join(tmpdir(), 'dbm-ui31-')), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
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
  await win.getByRole('button', { name: 'From database' }).click()
  await win.waitForTimeout(1000)
  const before = (await win.locator('.cm-content').first().innerText()).match(/\[name:/g)?.length ?? 0
  await win.getByRole('button', { name: 'Design with AI' }).click()
  await win.getByText('Suggest indexes', { exact: true }).click()
  await win.getByRole('button', { name: 'Apply to model' }).first().waitFor({ timeout: 300000 })
  await win.getByRole('button', { name: 'Apply to model' }).first().click()
  await win.waitForTimeout(1500)
  const text = await win.locator('.cm-content').first().innerText()
  console.log('named indexes before/after:', before, (text.match(/\[name:/g)?.length ?? 0), '| indexes blocks:', (text.match(/indexes\s*\{/gi) ?? []).length)
  await win.screenshot({ path: `${out}/q0-model-indexes.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/99-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

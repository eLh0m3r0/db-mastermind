// Model: import a pg_dump schema, then write it as SQL Server DDL.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const [out, file] = process.argv.slice(2)
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: mkdtempSync(join(tmpdir(), 'dbm-ui24-')), DBM_NO_UPDATE_CHECK: '1' } })
const win = await app.firstWindow()
win.on('dialog', (d) => d.accept())
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await api('createSampleDatabase')
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Demo coffee shop/ }).first().click()
  await win.waitForTimeout(1500)
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('New model')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(800)
  await win.getByRole('button', { name: 'Import SQL…' }).click()
  await win.waitForTimeout(2500)
  await win.screenshot({ path: `${out}/j0-model-import.png` })
  await win.getByRole('button', { name: 'SQL DDL' }).click()
  await win.getByText('SQL Server', { exact: true }).click()
  await win.waitForTimeout(1200)
  console.log('ddl:', (await win.locator('.cm-content').last().innerText()).slice(0, 500))
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/99-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

// Typing in the connection form keeps the focus in that field (it used to jump to the URL field after each key).
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui65-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: dir, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  await api('saveConnection', { id: '', name: 'Some DB', driver: 'postgres', host: 'db.example.com', port: 5432, user: 'me', database: 'app' })
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByText('Some DB', { exact: true }).first().click({ button: 'right' })
  await win.getByText('Edit…', { exact: true }).first().click()
  await win.waitForTimeout(600)
  const name = win.getByRole('dialog').locator('input').nth(1)
  await name.click()
  await name.press('End')
  await win.keyboard.type(' renamed', { delay: 60 })
  const focused = await win.evaluate(() => (document.activeElement instanceof HTMLInputElement ? document.activeElement.value : null))
  console.log('focused field value:', JSON.stringify(focused))
  console.log('url field value:', JSON.stringify(await win.getByRole('dialog').locator('input').first().inputValue()))
} finally {
  await app.close()
}

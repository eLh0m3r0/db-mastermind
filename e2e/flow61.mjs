// Large schema (PG database "huge": 20 schemas × 250 tables, 4980 foreign keys): times connecting, filtering the
// sidebar, opening a table, autocomplete and the ER diagram of one schema.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui61-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: dir, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const time = async (label, fn) => {
  const t = Date.now()
  await fn()
  console.log(`${label}: ${Date.now() - t} ms`)
}
try {
  await win.waitForTimeout(800)
  await api('saveConnection', { id: '', name: 'Huge', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'huge' })
  await win.reload()
  await win.waitForTimeout(1000)
  await time('connect + sidebar', async () => {
    await win.getByText('Huge', { exact: true }).first().dblclick()
    await win.getByPlaceholder(/Filter .+ tables/).waitFor({ timeout: 60000 })
  })
  console.log('placeholder:', await win.getByPlaceholder(/Filter .+ tables/).getAttribute('placeholder'))
  await win.screenshot({ path: `${out}/r61-sidebar.png` })
  await time('sidebar filter "t249"', async () => {
    await win.getByPlaceholder(/Filter .+ tables/).fill('t249')
    await win.getByText('t249', { exact: true }).first().waitFor()
  })
  await time('open table app7.t249', async () => {
    await win.getByPlaceholder(/Filter .+ tables/).fill('app7.t249')
    await win.getByPlaceholder(/Filter .+ tables/).press('Enter')
    await win.getByText(/rows/).first().waitFor({ timeout: 30000 })
  })
  await win.screenshot({ path: `${out}/r61-table.png` })
  const heap = await win.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null))
  console.log('renderer heap MB:', heap)
  // Autocomplete in a new query tab.
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+t' : 'Control+t')
  await win.waitForTimeout(800)
  const editor = win.locator('.cm-content:visible').first()
  await editor.click()
  await time('autocomplete "select * from app12.t2"', async () => {
    await win.keyboard.type('select * from app12.t2')
    await win.locator('.cm-tooltip-autocomplete').waitFor({ timeout: 15000 })
  })
  await win.screenshot({ path: `${out}/r61-autocomplete.png` })
  // Whole-database ER diagram from the command palette.
  await win.keyboard.press('Escape')
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
  await win.keyboard.type('Open ER diagram')
  await time('ER diagram (whole database)', async () => {
    await win.keyboard.press('Enter')
    await win.locator('.react-flow__node').first().waitFor({ timeout: 120000 })
    await win.waitForTimeout(500)
  })
  console.log('diagram nodes rendered:', await win.locator('.react-flow__node').count())
  await win.screenshot({ path: `${out}/r61-diagram.png` })
  const heap2 = await win.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null))
  console.log('renderer heap MB after diagram:', heap2)
  console.log('errors:', errors.length ? errors : 'none')
} catch (err) {
  await win.screenshot({ path: `${out}/r61-failure.png` })
  console.log('errors:', errors)
  throw err
} finally {
  await app.close()
}

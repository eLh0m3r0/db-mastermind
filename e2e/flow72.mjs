// The explorer's "Filter N tables" counts only visible schemas; a script run adds one History entry, not one per statement.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui72-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: dir, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
try {
  await win.waitForTimeout(800)
  const c = await api('saveConnection', { id: '', name: 'PG', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' })
  await win.reload()
  await win.waitForTimeout(800)
  await win.getByText('PG', { exact: true }).first().dblclick()
  const filter = win.getByPlaceholder(/Filter .+ tables/)
  await filter.waitFor()
  const before = await filter.getAttribute('placeholder')
  const schema = (await api('getSchema', c.id)).tables.find((t) => t.schema && t.schema !== 'public')?.schema
  await api('setExplorerPrefs', c.id, { hiddenSchemas: [schema] })
  await win.reload()
  await win.waitForTimeout(800)
  await win.getByText('PG', { exact: true }).first().dblclick()
  await filter.waitFor()
  console.log('placeholder:', before, '→ hiding', schema, '→', await filter.getAttribute('placeholder'))
  // A 3-statement script.
  await win.keyboard.press(`${mod}+t`)
  await win.locator('.cm-content:visible').first().click()
  await win.keyboard.type('select 1;\nselect 2;\nselect 3;')
  await win.keyboard.press(`Shift+${mod}+Enter`)
  await win.waitForTimeout(1500)
  await win.getByRole('button', { name: 'History', exact: true }).click()
  await win.waitForTimeout(600)
  console.log('history entries mentioning "select 3":', await win.getByText('select 3').count(), '| shows "3 statements":', await win.getByText('3 statements').count())
  console.log('errors:', errors.length ? errors : 'none')
} finally {
  await app.close()
}

// Designer: a new table is scrolled into view and selected; structural edits are separate undo steps (typing still
// coalesces); the foreign-key editor shows full column names; the toolbar fits at 1024–1440 px.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui73-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: dir, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
try {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await win.waitForTimeout(800)
  await api('saveConnection', { id: '', name: 'PG', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' })
  await win.reload(); await win.waitForTimeout(800)
  await win.getByText('PG', { exact: true }).first().dblclick()
  await win.getByPlaceholder(/Filter .+ tables/).waitFor()
  await win.keyboard.press(`${mod}+k`); await win.keyboard.type('Open ER diagram'); await win.keyboard.press('Enter')
  await win.locator('.react-flow__node').first().waitFor({ timeout: 30000 })
  await win.locator('select').filter({ hasText: 'shop' }).first().selectOption('shop')
  await win.waitForTimeout(1500)
  await win.getByRole('button', { name: /^Design$/ }).first().click()
  await win.getByRole('button', { name: 'New table' }).click()
  await win.waitForTimeout(800)
  const node = win.locator('.react-flow__node', { hasText: 'new_table_1' })
  const box = await node.boundingBox()
  const pane = await win.locator('.react-flow').boundingBox()
  console.log('new table inside the canvas:', !!box && box.x >= pane.x && box.x + box.width <= pane.x + pane.width && box.y >= pane.y && box.y + box.height <= pane.y + pane.height, '| editor open:', await win.getByText('New table', { exact: true }).count() > 1)
  // Add a column, then quickly a foreign key: two undo steps.
  await win.getByRole('button', { name: 'Add', exact: true }).first().click()
  await win.waitForTimeout(150)
  const fkSection = win.getByText('Foreign keys', { exact: false }).first()
  await fkSection.locator('xpath=..').getByRole('button', { name: 'Add', exact: true }).click().catch(async () => {
    await win.getByRole('button', { name: 'Add', exact: true }).nth(1).click()
  })
  await win.waitForTimeout(300)
  await win.screenshot({ path: `${out}/r73-fk.png` })
  const cols = async () => (await node.innerText()).split('\n').length
  const before = await cols()
  await win.keyboard.press('Escape')
  await win.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } })
  await win.keyboard.press(`${mod}+z`)
  await win.waitForTimeout(300)
  console.log('after 1 undo the table is still there:', await node.count(), '| rows', before, '→', await cols())
  await win.keyboard.press(`${mod}+z`)
  await win.waitForTimeout(300)
  console.log('after 2 undos the table is still there:', await node.count(), '| rows', await cols())
  await win.keyboard.press(`${mod}+z`)
  await win.waitForTimeout(300)
  console.log('after 3 undos the table is gone:', (await node.count()) === 0)
  console.log('errors:', errors.length ? errors : 'none')
} finally {
  await app.close()
}

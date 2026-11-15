// Long-tail UI (1.3.1): menu items that used to do nothing. Help → Keyboard Shortcuts opens a list made from the
// keymap; ⇧⌘E opens the results' export menu; Query → History switches the sidebar; Disconnect stays disconnected
// with a tab of that connection open; Run on Several Connections from a table tab takes typed SQL.
// Needs `npm run db:up` (postgres) and the shop fixtures.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? tmpdir()
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui109-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const menu = (command) => app.evaluate(({ BrowserWindow }, command) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', command), command)
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const check = (label, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) process.exitCode = 1
}
try {
  await win.waitForTimeout(1000)
  await menu('shortcuts')
  const dialog = win.getByRole('dialog')
  await dialog.waitFor({ timeout: 5000 })
  const listed = await dialog.innerText()
  check('Help → Keyboard Shortcuts lists the keymap', /Command palette/.test(listed) && /Run statement or selection/.test(listed) && /Export results/.test(listed) && /⇧⌘E|Ctrl\+Shift\+E/.test(listed))
  await win.screenshot({ path: `${out}/r109-shortcuts.png` })
  await win.keyboard.press('Escape')

  await api('saveConnection', { name: 'Shop', driver: 'postgres', host: '127.0.0.1', port: 54329, database: 'mastermind', user: 'postgres', password: 'mastermind' })
  await win.reload()
  await win.getByText('Shop', { exact: true }).first().dblclick()
  await win.locator('.cm-content:visible').first().waitFor({ timeout: 15000 })
  await win.locator('.cm-content:visible').first().click()
  await win.keyboard.insertText('SELECT * FROM shop.orders ORDER BY id')
  await win.keyboard.press(`${mod}+Enter`)
  await win.getByText('Result 1').first().waitFor({ timeout: 10000 })
  await win.keyboard.press(`${mod}+Shift+e`)
  await win.getByRole('menu').waitFor({ timeout: 3000 }).catch(() => {})
  const exportMenu = (await win.getByRole('menu').count()) ? await win.getByRole('menu').innerText() : ''
  check('⇧⌘E opens the export menu of the results', /CSV/.test(exportMenu))
  await win.keyboard.press('Escape')

  await menu('history')
  await win.waitForTimeout(400)
  check('Query → History switches the sidebar to History', (await win.locator('button[aria-pressed="true"]', { hasText: 'History' }).count()) === 1)
  await menu('saved-queries')
  await win.waitForTimeout(400)
  check('Query → Saved Queries switches it to Saved', (await win.locator('button[aria-pressed="true"]', { hasText: 'Saved' }).count()) === 1)

  await menu('disconnect')
  await win.waitForTimeout(2500)
  const dots = await win.locator('[data-status]').evaluateAll((els) => els.map((e) => e.getAttribute('data-status')))
  check('Disconnect stays disconnected while a tab of the connection is open', dots.length > 0 && dots.every((s) => s === 'disconnected'))

  await win.locator('.cm-content:visible').first().click()
  await win.keyboard.press(`${mod}+Enter`)
  await win.waitForTimeout(2000)
  const after = await win.locator('[data-status]').evaluateAll((els) => els.map((e) => e.getAttribute('data-status')))
  check('running a query connects again', after.includes('connected'))

  await win.keyboard.press(`${mod}+p`)
  await win.keyboard.insertText('customers')
  await win.waitForTimeout(800)
  await win.keyboard.press('Enter')
  await win.waitForTimeout(1500)
  const enabled = (id) => app.evaluate(({ Menu }, id) => Menu.getApplicationMenu().getMenuItemById(id)?.enabled, id)
  check('in a table tab Run and Format SQL are greyed out, Export is not', (await enabled('run-current')) === false && (await enabled('format-sql')) === false && (await enabled('export')) === true)
  await win.locator('[role="tab"]').first().click()
  await win.waitForTimeout(400)
  check('in a query tab Run is available again', (await enabled('run-current')) === true)
  await win.locator('[role="tab"]').last().click()
  await win.waitForTimeout(400)
  await menu('run-on-connections')
  await win.getByTestId('run-many-sql').waitFor({ timeout: 5000 })
  await win.getByTestId('run-many-sql').fill('SELECT count(*) AS n FROM shop.customers')
  await win.getByTestId('run-many-start').click()
  await win.waitForTimeout(2500)
  const result = await win.getByTestId('run-many').innerText()
  check('Run on Several Connections from a table tab runs typed SQL', /Shop/.test(result) && /1 row/.test(result))
  await win.screenshot({ path: `${out}/r109-run-many.png` })
  check('no page errors', errors.length === 0)
  if (errors.length) console.log(errors)
} catch (err) {
  console.log('FAIL', err)
  await win.screenshot({ path: `${out}/r109-failure.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await app.close()
}

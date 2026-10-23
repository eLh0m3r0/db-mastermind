// Czech UI details: `node e2e/flow87.mjs <screenshot dir>`. CSV export for Czech Excel (semicolons, decimal commas),
// the separator setting, and the app's own error messages in Czech.
import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'dbm-shots87-'))
const home = mkdtempSync(join(tmpdir(), 'dbm-ui87-'))
const data = join(home, 'data')
mkdirSync(data, { recursive: true })
const file = join(home, 'shop.db')
const db = new DatabaseSync(file)
db.exec("CREATE TABLE products (name text, price real, code text); INSERT INTO products VALUES ('Káva; \"dvojitá\"', 10.5, '1.5'), ('Čaj', 7.25, NULL)")
db.close()
const now = new Date().toISOString()
writeFileSync(join(data, 'connections.json'), JSON.stringify([{ id: 'shop', name: 'Shop', driver: 'sqlite', filePath: file, createdAt: now, updatedAt: now }]))

const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: home, DBM_USER_DATA: data, DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'cs' }, timeout: 60_000 })
const win = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  w.setBounds({ x: -4000, y: 0, width: 1280, height: 800 })
  w.blur()
})
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args).then((v) => ({ v }), (e) => ({ e: e.message })), [fn, args])
try {
  await win.waitForTimeout(1000)
  await api('connect', 'shop')

  // CSV in the Czech UI: semicolons and decimal commas, text kept as it is.
  const csv = join(home, 'export.csv')
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
  }, csv)
  await api('exportQuery', { format: 'csv', connectionId: 'shop', sql: 'SELECT * FROM products', defaultName: 'products' })
  const text = readFileSync(csv, 'utf8')
  check('CSV for Czech Excel', text === '﻿name;price;code\r\n"Káva; ""dvojitá""";10,5;1.5\r\nČaj;7,25;\r\n', JSON.stringify(text))

  // The setting shows the separator in use and can switch back to commas.
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,')
  await win.waitForTimeout(600)
  await win.locator('[role=dialog] nav button', { hasText: 'Editor a data' }).click()
  await win.waitForTimeout(500)
  const select = win.locator('[role=dialog] select').filter({ has: win.locator('option[value=";"]') })
  check('setting shows semicolon by default in Czech', (await select.inputValue()) === ';')
  await win.screenshot({ path: join(out, '87-csv-setting.png') })
  await select.selectOption(',')
  await win.waitForTimeout(300)
  await win.keyboard.press('Escape')
  await api('exportQuery', { format: 'csv', connectionId: 'shop', sql: 'SELECT * FROM products', defaultName: 'products' })
  check('comma chosen: plain CSV', readFileSync(csv, 'utf8').startsWith('﻿name,price,code\r\n"Káva; ""dvojitá""",10.5,1.5'))

  // The app's own messages arrive in Czech: importing a file no tool wrote.
  const junk = join(home, 'notes.txt')
  writeFileSync(junk, 'just some notes')
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
  }, junk)
  await win.getByRole('button', { name: 'Importovat připojení' }).first().click()
  await win.waitForTimeout(400)
  await win.getByText(/^Ze souboru/).first().click()
  await win.waitForTimeout(1000)
  const body = await win.locator('body').innerText()
  check('app message in Czech', body.includes('Neznámý soubor: vyberte export připojení'), body.slice(-400).replace(/\n/g, ' | '))
  await win.screenshot({ path: join(out, '87-czech-error.png') })
} finally {
  console.log('page errors:', errors.length ? errors : 'none')
  await app.close()
}
if (results.includes(false)) process.exit(1)

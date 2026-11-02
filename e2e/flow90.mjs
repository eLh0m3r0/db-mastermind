// Run all → Copy all / Download all, and the explorer reconnecting by itself after the server was unreachable.
// `node e2e/flow90.mjs [screenshot dir]`. Part 2 needs PostgreSQL on 54329 (npm run db:up postgres); it goes through
// a local TCP proxy the flow switches off and on, like a VPN.
import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'

const out = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'dbm-shots90-'))
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const errors = []
const home = mkdtempSync(join(tmpdir(), 'dbm-ui90-'))
const data = join(home, 'data')
mkdirSync(data, { recursive: true })
const app = await electron.launch({
  args: ['apps/desktop'],
  env: { ...process.env, HOME: home, DBM_USER_DATA: data, DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' },
  timeout: 60_000,
})
const win = await app.firstWindow()
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText())
const menuItem = (name) => win.getByRole('menuitem', { name }).or(win.locator('[role=menu] button', { hasText: name })).first()
// The sidebar shows the current connection; others are picked from its header menu.
const openBehindVpn = async () => {
  await win.getByRole('button', { name: /Demo coffee shop|Behind VPN/ }).first().click()
  await win.waitForTimeout(300)
  await menuItem('Behind VPN').click()
  // The new tab's connection, not the demo's explorer still on screen.
  await win.getByRole('button', { name: /Behind VPN/ }).first().waitFor()
  await win.waitForTimeout(1000)
}

// A "VPN" between the app and PostgreSQL: closed = connection refused.
let proxy
const sockets = new Set()
const port = 54000 + Math.floor(Math.random() * 900)
const vpnUp = () =>
  new Promise((resolve) => {
    proxy = createServer((client) => {
      const upstream = createConnection(54329, '127.0.0.1')
      for (const s of [client, upstream]) {
        sockets.add(s)
        s.on('error', () => {})
        s.on('close', () => sockets.delete(s))
      }
      client.pipe(upstream).pipe(client)
    }).listen(port, '127.0.0.1', resolve)
  })
const vpnDown = () => new Promise((resolve) => {
  for (const s of sockets) s.destroy()
  proxy ? proxy.close(() => resolve()) : resolve()
})

try {
  await win.waitForTimeout(800)
  await api('createSampleDatabase')
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Demo coffee shop/ }).first().click()
  await win.getByPlaceholder(/Filter \d+ tables/).waitFor({ timeout: 20000 })

  // Part 1: several result sets.
  const editor = win.locator('.cm-content:visible').first()
  await editor.click()
  await win.keyboard.type("SELECT 1 AS id, 'Káva' AS name;\nSELECT 2 AS n;\n")
  await win.keyboard.press('Meta+Shift+Enter')
  await win.getByRole('button', { name: /Result 2/ }).waitFor({ timeout: 15000 })
  const group = win.locator('[data-all-results]')
  check('Copy all / Download all appear after a run with two results', await group.isVisible())
  await win.screenshot({ path: join(out, '90-all-results.png') })

  await group.getByRole('button', { name: 'Copy all' }).click()
  await menuItem('JSON').click()
  await win.waitForTimeout(300)
  const json = JSON.parse(await clipboard())
  check('Copy all as JSON: every result with its statement', json.length === 2 && json[0].result === 'Result 1' && json[0].rows[0].name === 'Káva' && json[1].rows[0].n === 2 && /SELECT 2/.test(json[1].sql), JSON.stringify(json))

  await group.getByRole('button', { name: 'Copy all' }).click()
  await menuItem('TSV (Excel)').click()
  await win.waitForTimeout(300)
  const tsv = await clipboard()
  check('Copy all as TSV: blocks under the result names', tsv === 'Result 1\nid\tname\n1\tKáva\n\nResult 2\nn\n2', JSON.stringify(tsv))

  await win.getByRole('button', { name: 'Copy', exact: true }).click()
  await menuItem('JSON').click()
  await win.waitForTimeout(300)
  check('Copy one result as JSON', JSON.stringify(JSON.parse(await clipboard())) === '[{"n":2}]', await clipboard())

  const xlsx = join(home, 'all.xlsx')
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, xlsx)
  await group.getByRole('button', { name: 'Download all' }).click()
  await menuItem(/Excel/).click()
  await win.waitForTimeout(1000)
  const parts = unzipSync(readFileSync(xlsx))
  const workbook = strFromU8(parts['xl/workbook.xml'])
  check('Download all as Excel: a sheet per result', /<sheet name="Result 1"[^>]*\/><sheet name="Result 2"/.test(workbook) && strFromU8(parts['xl/worksheets/sheet1.xml']).includes('Káva'), workbook.match(/<sheets>.*<\/sheets>/)?.[0])

  const zip = join(home, 'all.zip')
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, zip)
  await group.getByRole('button', { name: 'Download all' }).click()
  await menuItem(/^CSV/).click()
  await win.waitForTimeout(1000)
  check('Download all as CSV: a ZIP with a file per result', Object.keys(unzipSync(readFileSync(zip))).join() === 'Result 1.csv,Result 2.csv')

  // Part 2: a query tab of a connection behind a VPN; the app reconnects it while the VPN is down.
  const conn = await api('saveConnection', { id: '', name: 'Behind VPN', driver: 'postgres', host: '127.0.0.1', port, user: 'postgres', password: 'mastermind', database: 'mastermind' })
  await vpnUp()
  await win.reload()
  await win.waitForTimeout(1000)
  await openBehindVpn()
  await win.getByPlaceholder(/Filter \d+ tables/).waitFor({ timeout: 15000 })
  const vpnOff = async () => {
    await vpnDown()
    await api('disconnect', conn.id)
    await win.waitForTimeout(1500) // the workspace (open tabs) is saved
    await win.reload()
  }
  await vpnOff()
  const retrying = win.getByText('Server unreachable, trying again automatically…')
  await retrying.waitFor({ timeout: 15000 })
  check('unreachable server: the explorer says it keeps trying', true)
  await win.screenshot({ path: join(out, '90-unreachable.png') })

  // A query run from the tab reconnects in main: the explorer follows at once.
  await vpnUp()
  await api('runQuery', { runId: 'q', connectionId: conn.id, sql: 'SELECT 1' })
  const started = Date.now()
  await win.getByPlaceholder(/Filter \d+ tables/).waitFor({ timeout: 4000 })
  check('a query that reconnected shows the explorer connected', true, `${Date.now() - started} ms`)

  // Nothing runs: the background retry reconnects by itself.
  await vpnOff()
  await retrying.waitFor({ timeout: 15000 })
  await vpnUp()
  const t0 = Date.now()
  await win.getByPlaceholder(/Filter \d+ tables/).waitFor({ timeout: 20000 })
  check('the explorer reconnects by itself when the server is back', true, `${Date.now() - t0} ms`)
  await win.screenshot({ path: join(out, '90-reconnected.png') })
} catch (err) {
  check('flow', false, err.message)
  await win.screenshot({ path: join(out, '90-failure.png') }).catch(() => {})
} finally {
  console.log('page errors:', errors.length ? errors : 'none')
  await app.close()
  await vpnDown()
}
console.log('screenshots:', out)
if (results.includes(false)) process.exit(1)

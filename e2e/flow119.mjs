// Dashboards are found again and can live in the knowledge base (owner, 1.5.3): `node e2e/flow119.mjs <screenshot dir>`.
// The demo SQLite database, no container. A pinned result's dashboard is in the Saved tab, opens from there, renames
// (the Saved tab and the tab follow), survives a restart with its tiles, opens from Query → Dashboards, and is deleted
// from the Saved tab. With a knowledge base folder: a local one moves there as a readable file, a new pin goes there,
// a hand edit of the file is followed by the open tab, another connection without the folder sees none, and another
// profile pointing at the same folder sees and opens it.
import { _electron as electron } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? tmpdir()
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui119-'))
const kb = join(dir, 'kb')
mkdirSync(kb)
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` (${detail})`}`)
  if (!ok) process.exitCode = 1
}

async function launch(profile) {
  const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, profile), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' } })
  const win = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await win.waitForTimeout(900)
  const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
  const menu = (command) => app.evaluate(({ BrowserWindow }, command) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', command), command)
  return { app, win, api, menu }
}

let s = await launch('data')
const errors = []
s.win.on('pageerror', (e) => errors.push(e.message))
const saved = () => s.win.locator('[data-testid="saved-dashboards"]')
const savedRow = (name) => saved().locator('button', { hasText: name })
const tabTitles = () => s.win.locator('[data-tab-id], [role="tab"]').allInnerTexts()
const bigNumber = () => s.win.locator('.text-\\[34px\\]').first().innerText().catch(() => '')

/** Runs SQL in a new query tab of the current connection and pins its result to a new dashboard. */
async function pin(sql) {
  await s.win.keyboard.press('ControlOrMeta+t')
  await s.win.waitForTimeout(500)
  await s.win.locator('.cm-content:visible').first().click()
  await s.win.keyboard.insertText(sql)
  await s.win.keyboard.press('ControlOrMeta+Enter')
  await s.win.getByRole('button', { name: 'Add to dashboard' }).first().waitFor({ timeout: 10000 })
  await s.win.getByRole('button', { name: 'Add to dashboard' }).first().click()
  await s.win.getByRole('menuitem', { name: 'New dashboard' }).click()
  await s.win.waitForTimeout(700)
}

try {
  // A. Local (the demo has no knowledge base).
  await s.win.getByRole('button', { name: 'Try the demo database' }).click()
  await s.win.getByPlaceholder(/Filter .+ tables/).waitFor({ timeout: 20000 })
  const demo = (await s.api('listConnections'))[0]
  await pin('select count(*) as orders from orders')
  await s.menu('saved-queries')
  await s.win.waitForTimeout(500)
  check('the pinned dashboard is in the Saved tab, with its tiles', (await savedRow('Dashboard 1').count()) === 1 && /1 tile/.test(await savedRow('Dashboard 1').innerText()))
  check('the Saved tab searches both', (await s.win.getByPlaceholder('Search saved…').count()) === 1)
  await savedRow('Dashboard 1').click()
  await s.win.waitForTimeout(1500)
  check('it opens from the Saved tab and its tile runs', /^\d+$/.test((await bigNumber()).trim()), await bigNumber())
  await s.win.getByTestId('dashboard-name').fill('Order counts')
  await s.win.getByTestId('dashboard-name').press('Enter')
  await s.win.waitForTimeout(900)
  check('a rename reaches the Saved tab', (await savedRow('Order counts').count()) === 1 && (await savedRow('Dashboard 1').count()) === 0)
  check('…and the tab title', (await tabTitles()).some((x) => x.includes('Order counts')), (await tabTitles()).join('|'))
  await pin('select count(*) as customers from customers')
  check('a new dashboard after a rename is named Dashboard 1 again, not a duplicate', (await savedRow('Dashboard 1').count()) === 1)
  // Restart with the dashboard tab open.
  await savedRow('Order counts').click()
  await s.win.waitForTimeout(800)
  await s.app.close()
  s = await launch('data')
  s.win.on('pageerror', (e) => errors.push(e.message))
  await s.win.waitForTimeout(2000)
  check('after a restart the dashboard tab is back with its tile', /^\d+$/.test((await bigNumber()).trim()), await bigNumber())
  await s.menu('saved-queries')
  await s.win.waitForTimeout(400)
  check('…and it is still listed', (await savedRow('Order counts').count()) === 1)
  await s.menu('dashboards')
  await s.win.waitForTimeout(600)
  check('Query → Dashboards opens the overview of the connection', (await s.win.getByTestId('dashboard-card').count()) === 2)
  await savedRow('Dashboard 1').click({ button: 'right' })
  await s.win.getByRole('menuitem', { name: 'Delete' }).click()
  await s.win.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  await s.win.waitForTimeout(600)
  check('Delete in the Saved tab removes it', (await savedRow('Dashboard 1').count()) === 0 && (await s.win.getByTestId('dashboard-card').count()) === 1)

  // The demo comes with a knowledge base: its dashboards are files there, readable.
  const demoFile = join(demo.knowledgeBasePath ?? '', 'dashboards', 'Order counts.md')
  const demoText = existsSync(demoFile) ? readFileSync(demoFile, 'utf8') : ''
  check('with a knowledge base a dashboard is a readable file in it', demoText.startsWith('---\ndashboard: true\n---\n# Order counts\n\n## ') && demoText.includes('```sql\nselect count(*) as orders from orders\n```\n'), JSON.stringify(demoText))

  // B. Another connection without a knowledge base: none of the demo's dashboards; a pin there stays on this computer.
  const other = await s.api('saveConnection', { id: '', name: 'Other', driver: 'sqlite', filePath: demo.filePath })
  check('another connection without the folder lists no dashboard', (await s.api('listDashboards', other.id)).length === 0)
  await s.win.reload()
  await s.win.waitForTimeout(1200)
  await s.win.getByText('Demo coffee shop', { exact: true }).first().click()
  await s.win.getByText('Other', { exact: true }).first().dblclick()
  await s.win.getByPlaceholder(/Filter .+ tables/).waitFor({ timeout: 20000 })
  await s.menu('saved-queries')
  await s.win.waitForTimeout(500)
  check('…and its Saved tab shows none', (await saved().count()) === 0)
  await pin('select count(*) as orders from orders')
  const local = (await s.api('listDashboards', other.id))[0]
  check('a pin there is kept on this computer (not shared)', !!local && !local.shared && local.name === 'Dashboard 1')

  // C. That connection gets a knowledge base folder: its local dashboard moves there as a file, by the user's choice.
  await s.api('saveConnection', { ...other, knowledgeBasePath: kb })
  await s.win.reload()
  await s.win.waitForTimeout(1500)
  await s.menu('saved-queries')
  await s.win.waitForTimeout(500)
  check('the local one stays local until moved', (await s.api('listDashboards', other.id)).map((d) => [d.name, !!d.shared]).join() === 'Dashboard 1,false')
  await savedRow('Dashboard 1').click({ button: 'right' })
  await s.win.getByRole('menuitem', { name: 'Move to the knowledge base' }).click()
  await s.win.waitForTimeout(800)
  const file = join(kb, 'dashboards', 'Dashboard 1.md')
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  check('Move to the knowledge base writes it there', text.startsWith('---\ndashboard: true\n---\n# Dashboard 1\n') && (await s.api('listDashboards', other.id))[0]?.shared === true, JSON.stringify(text))
  await s.win.screenshot({ path: join(out, 'r119-saved.png') })

  // D. A hand edit of the file (a pull, OneDrive): the open dashboard follows when the window comes back.
  await savedRow('Dashboard 1').click()
  await s.win.waitForTimeout(1200)
  writeFileSync(file, text.replace(/\n## [^\n]+\n/, '\n## All orders\n'))
  await s.win.evaluate(() => window.dispatchEvent(new Event('focus')))
  await s.win.waitForTimeout(1200)
  check('the open dashboard follows a change of its file', (await s.win.locator('input[value="All orders"]').count()) === 1)
  await s.app.close()

  // E. Another profile with a connection on the same folder sees and opens it.
  s = await launch('data-2')
  s.win.on('pageerror', (e) => errors.push(e.message))
  const teammate = await s.api('saveConnection', { id: '', name: 'Shop (teammate)', driver: 'sqlite', filePath: demo.filePath, knowledgeBasePath: kb })
  check('another profile on the same folder lists it', (await s.api('listDashboards', teammate.id)).map((d) => d.name).join('|') === 'Dashboard 1')
  await s.win.reload()
  await s.win.waitForTimeout(1200)
  await s.win.getByText('Shop (teammate)', { exact: true }).first().dblclick()
  await s.win.getByPlaceholder(/Filter .+ tables/).waitFor({ timeout: 20000 })
  await s.menu('saved-queries')
  await s.win.waitForTimeout(600)
  check('…shown with the knowledge base icon', (await savedRow('Dashboard 1').locator('svg.lucide-book-open').count()) === 1)
  await savedRow('Dashboard 1').click()
  await s.win.waitForTimeout(1500)
  check('…and opens with its tiles', /^\d+$/.test((await bigNumber()).trim()), await bigNumber())
  await s.win.screenshot({ path: join(out, 'r119-teammate.png') })
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await s.win.screenshot({ path: join(out, 'r119-error.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await s.app.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
}

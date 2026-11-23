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
const savedRow = (name) => s.win.getByTestId('saved-dashboard').filter({ hasText: name })
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

  // B. Two places: new ones stay on this computer, also with a knowledge base; Share with the team writes the files.
  const kbDir = demo.knowledgeBasePath
  check('a new dashboard stays on this computer (the demo has a knowledge base)', !existsSync(join(kbDir, 'dashboards', 'Order counts.md')) && (await s.api('listDashboards', demo.id)).every((d) => !d.shared))
  await s.api('saveQuery', { name: 'Paid orders', sql: "select * from orders where status = 'paid'", connectionId: demo.id })
  await s.api('saveQuery', { name: 'Scratch', sql: 'select 1', connectionId: demo.id })
  await s.menu('saved-queries')
  await s.win.waitForTimeout(4500)
  check('with nothing shared the Saved tab has no headings', (await s.win.getByTestId('saved-team').count()) === 0 && !(await s.win.getByTestId('saved-local').innerText()).includes('THIS COMPUTER'))
  const share = async (row) => {
    await row.click({ button: 'right' })
    await s.win.getByRole('menuitem', { name: 'Share with the team' }).click()
    await s.win.getByRole('dialog').getByRole('button', { name: 'Share' }).click()
    await s.win.waitForTimeout(900)
  }
  await share(s.win.getByTestId('saved-dashboard').filter({ hasText: 'Order counts' }))
  await share(s.win.getByTestId('saved-query').filter({ hasText: 'Paid orders' }))
  await s.win.waitForTimeout(4500)
  const dashText = existsSync(join(kbDir, 'dashboards', 'Order counts.md')) ? readFileSync(join(kbDir, 'dashboards', 'Order counts.md'), 'utf8') : ''
  const queryText = existsSync(join(kbDir, 'queries', 'Paid orders.sql')) ? readFileSync(join(kbDir, 'queries', 'Paid orders.sql'), 'utf8') : ''
  check('Share with the team writes the dashboard file', dashText.startsWith('---\ndashboard: true\n---\n# Order counts\n'), JSON.stringify(dashText.slice(0, 80)))
  check('…and the query file, plain SQL', queryText === "select * from orders where status = 'paid'\n", JSON.stringify(queryText))
  const teamText = await s.win.getByTestId('saved-team').innerText().catch(() => '')
  const localText = await s.win.getByTestId('saved-local').innerText().catch(() => '')
  check('the Saved tab shows This computer and Team, each with its own', /THIS COMPUTER/.test(localText) && /Scratch/.test(localText) && !/Order counts|Paid orders/.test(localText) && /TEAM/.test(teamText) && /Order counts/.test(teamText) && /Paid orders/.test(teamText), `${localText} || ${teamText}`)
  check('…the Team heading names the folder', teamText.includes(kbDir.split('/').pop()))
  await s.win.screenshot({ path: join(out, 'r119-saved-two-places.png') })

  // C. The Knowledge tab by kind; each row opens as what it is.
  await s.win.keyboard.press('ControlOrMeta+k')
  await s.win.keyboard.insertText('Open knowledge base')
  await s.win.keyboard.press('Enter')
  await s.win.getByTestId('kb-sections').waitFor({ timeout: 10000 })
  await s.win.waitForTimeout(1200)
  const sections = await s.win.getByTestId('kb-sections').innerText()
  check('the Knowledge tab shows Notes, Dashboards and Queries apart', /NOTES/.test(sections) && /DASHBOARDS/.test(sections) && /QUERIES/.test(sections) && !/^Order counts$/m.test(sections.split('DASHBOARDS')[0] ?? ''), sections.slice(0, 300))
  await s.win.screenshot({ path: join(out, 'r119-knowledge-sections.png') })
  await s.win.getByTestId('kb-dashboard').first().click()
  await s.win.waitForTimeout(1200)
  check('a dashboard row opens the dashboard', (await s.win.getByTestId('dashboard-name').count()) === 1)
  await s.win.keyboard.press('ControlOrMeta+k')
  await s.win.keyboard.insertText('Open knowledge base')
  await s.win.keyboard.press('Enter')
  await s.win.getByTestId('kb-query').first().click()
  await s.win.waitForTimeout(1000)
  check('a query row opens a query tab (nothing runs)', ((await s.win.locator('.cm-content:visible').first().innerText()) ?? '').includes("status = 'paid'") && (await s.win.getByText(/rows? ·|\d+ rows/).count()) === 0)

  // The same two screens in a look, for the review.
  await s.api('updateSettings', { look: 'medieval' })
  await s.win.reload()
  await s.win.waitForTimeout(1500)
  await s.menu('saved-queries')
  await s.win.waitForTimeout(1500)
  await s.win.screenshot({ path: join(out, 'r119-saved-medieval.png') })
  await s.win.keyboard.press('ControlOrMeta+k')
  await s.win.keyboard.insertText('Open knowledge base')
  await s.win.keyboard.press('Enter')
  await s.win.waitForTimeout(1500)
  await s.win.screenshot({ path: join(out, 'r119-knowledge-medieval.png') })
  await s.api('updateSettings', { look: 'violet' })

  // D. A connection of another database lists neither.
  const other = await s.api('saveConnection', { id: '', name: 'Other', driver: 'sqlite', filePath: demo.filePath })
  check('another connection lists none of them', (await s.api('listDashboards', other.id)).length === 0 && (await s.api('listSavedQueries')).every((q) => q.connectionId !== other.id))
  await s.app.close()

  // E. Another profile on the same folder sees both under Team and opens them.
  s = await launch('data-2')
  s.win.on('pageerror', (e) => errors.push(e.message))
  const teammate = await s.api('saveConnection', { id: '', name: 'Shop (teammate)', driver: 'sqlite', filePath: demo.filePath, knowledgeBasePath: kbDir })
  await s.win.reload()
  await s.win.waitForTimeout(1200)
  await s.win.getByText('Shop (teammate)', { exact: true }).first().dblclick()
  await s.win.getByPlaceholder(/Filter .+ tables/).waitFor({ timeout: 20000 })
  await s.menu('saved-queries')
  await s.win.waitForTimeout(1500)
  const theirs = await s.win.getByTestId('saved-team').innerText().catch(() => '')
  check('another profile on the same folder sees both under Team', /Order counts/.test(theirs) && /Paid orders/.test(theirs) && (await s.win.getByTestId('saved-local').count()) === 0, theirs)
  await s.win.getByTestId('saved-dashboard').filter({ hasText: 'Order counts' }).click()
  await s.win.waitForTimeout(1500)
  check('…and opens the dashboard with its tiles', /^\d+$/.test((await bigNumber()).trim()), await bigNumber())
  await s.win.getByTestId('saved-query').filter({ hasText: 'Paid orders' }).click()
  await s.win.waitForTimeout(800)
  check('…and the query', ((await s.win.locator('.cm-content:visible').first().innerText()) ?? '').includes("status = 'paid'"))
  void teammate
  await s.app.close()

  // F. Keep on this computer only takes each back and removes its file.
  s = await launch('data')
  s.win.on('pageerror', (e) => errors.push(e.message))
  await s.menu('saved-queries')
  await s.win.waitForTimeout(1500)
  const keep = async (row) => {
    await row.click({ button: 'right' })
    await s.win.getByRole('menuitem', { name: 'Keep on this computer only' }).click()
    await s.win.getByRole('dialog').getByRole('button', { name: 'Keep on this computer only' }).click()
    await s.win.waitForTimeout(900)
  }
  await s.win.screenshot({ path: join(out, 'r119-saved-light.png') })
  await keep(s.win.getByTestId('saved-dashboard').filter({ hasText: 'Order counts' }))
  await keep(s.win.getByTestId('saved-query').filter({ hasText: 'Paid orders' }))
  await s.win.waitForTimeout(4500)
  check('Keep on this computer only removes the files', !existsSync(join(kbDir, 'dashboards', 'Order counts.md')) && !existsSync(join(kbDir, 'queries', 'Paid orders.sql')))
  check('…and both are back under This computer', (await s.win.getByTestId('saved-team').count()) === 0 && /Order counts/.test(await s.win.getByTestId('saved-local').innerText()) && /Paid orders/.test(await s.win.getByTestId('saved-local').innerText()))
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await s.win.screenshot({ path: join(out, 'r119-error.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await s.app.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
}

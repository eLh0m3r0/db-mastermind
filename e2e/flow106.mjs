// Agents and notes (Milestone 11, F): a connection an agent proposes (a file the MCP server writes) shows as a
// notice; Review opens the connection form prefilled and read-only, saving removes the proposal; ✕ dismisses another
// for good. A knowledge base note runs its SQL block in place (reads only; a write is sent to the editor instead).
// Needs `npm run db:up` (postgres) and the shop fixtures.
import { _electron as electron } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? tmpdir()
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui106-'))
const data = join(dir, 'data')
const proposals = join(data, 'connection-proposals')
const propose = (name, extra = {}) => {
  mkdirSync(proposals, { recursive: true })
  const file = `${Date.now()}-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}.json`
  writeFileSync(join(proposals, file), JSON.stringify({ name, driver: 'postgres', host: '127.0.0.1', port: 54329, database: 'mastermind', user: 'postgres', proposedBy: 'claude-code', proposedAt: new Date().toISOString(), ...extra }))
  return file
}
const waiting = () => (existsSync(proposals) ? readdirSync(proposals).filter((f) => f.endsWith('.json')).length : 0)

const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: data, DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const check = (label, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) process.exitCode = 1
}
try {
  await win.waitForTimeout(1000)
  // The app is running: a proposal written now shows at once (the folder is watched).
  propose('Shop staging')
  await win.getByText('claude-code proposes a connection: Shop staging').waitFor({ timeout: 10000 })
  check('a proposal shows as a notice while the app runs', true)
  await win.screenshot({ path: `${out}/r106-proposal.png` })
  await win.getByRole('button', { name: 'Review…' }).click()
  await win.getByRole('dialog').waitFor({ timeout: 5000 })
  // The form fills itself in right after it opens.
  await win.getByRole('dialog').locator('input[value="Shop staging"]').waitFor({ timeout: 5000 }).catch(() => {})
  const host = await win.getByRole('dialog').locator('input[value="127.0.0.1"]').count()
  check('Review opens the connection form prefilled', host === 1 && (await win.getByRole('dialog').locator('input[value="Shop staging"]').count()) === 1)
  await win.screenshot({ path: `${out}/r106-form.png` })
  await win.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
  await win.waitForTimeout(800)
  const saved = (await api('listConnections')).find((c) => c.name === 'Shop staging')
  check('saving adds the connection, read-only, and removes the proposal', !!saved && saved.readOnly === true && waiting() === 0)

  propose('Ignore me')
  await win.getByText('claude-code proposes a connection: Ignore me').waitFor({ timeout: 10000 })
  await win.locator('[role="status"]').filter({ hasText: 'Ignore me' }).getByRole('button', { name: 'Dismiss' }).click()
  await win.waitForTimeout(500)
  check('✕ dismisses the proposal for good', waiting() === 0 && (await api('listConnections')).every((c) => c.name !== 'Ignore me'))

  // A note with a SQL block, run in place.
  const id = saved.id
  await api('saveConnection', { ...saved, password: 'mastermind' })
  await api('kbEnsureFolder', id)
  await api('kbWrite', id, 'orders.md', '# Orders\n\nPaid orders:\n\n```sql\nSELECT status, count(*) AS n FROM shop.orders GROUP BY status ORDER BY status\n```\n\nNever run from here:\n\n```sql\nDELETE FROM shop.orders WHERE id = -1\n```\n')
  await win.reload()
  await win.getByText('Shop staging', { exact: true }).first().dblclick()
  await win.locator('.cm-content:visible').first().waitFor({ timeout: 15000 })
  await win.keyboard.press('ControlOrMeta+k')
  await win.keyboard.insertText('Open knowledge base')
  await win.keyboard.press('Enter')
  await win.getByText('orders.md').first().click()
  await win.getByTestId('run-block').first().waitFor({ timeout: 10000 })
  await win.getByTestId('run-block').first().click()
  await win.getByTestId('inline-result').first().waitFor({ timeout: 10000 })
  const result = await win.getByTestId('inline-result').first().innerText()
  check('a SQL block runs in place and shows its rows', /paid/.test(result) && /60/.test(result))
  await win.screenshot({ path: `${out}/r106-notebook.png` })
  await win.getByTestId('run-block').nth(1).click()
  await win.waitForTimeout(800)
  check('a write in a note is refused (reads only)', /reads only/.test(await win.getByTestId('inline-result').nth(1).innerText()))
  check('no page errors', errors.length === 0)
  if (errors.length) console.log(errors)
} catch (err) {
  console.log('FAIL', err)
  await win.screenshot({ path: `${out}/r106-failure.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await app.close()
}

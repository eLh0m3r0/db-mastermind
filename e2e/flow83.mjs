// Knowledge base location from the UI: the header shows where the notes live; Change… copies them into a chosen
// folder, shares one folder between two connections (dev/test of one project), moves them to the team folder and
// back; a team connection can point elsewhere only for this user and go back to the team's; the connection form
// shows the same. Usage: node e2e/flow83.mjs <screenshot dir>
import { _electron as electron } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'dbm-shots83-'))
const home = mkdtempSync(join(tmpdir(), 'dbm-ui83-'))
const files = join(home, 'db')
mkdirSync(files)
for (const name of ['dev', 'test', 'shared']) {
  const db = new DatabaseSync(join(files, `${name}.db`))
  db.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL)')
  db.close()
}
const team = join(home, 'team')
mkdirSync(team)
const repo = join(home, 'project-notes')
mkdirSync(repo)

const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: home, DBM_USER_DATA: join(home, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
// Off-screen and in the background: the test must not take the user's focus.
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  w.setBounds({ x: 4000, y: 0, width: 1280, height: 820 })
  w.blur()
})
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const shot = (name) => win.screenshot({ path: join(out, `r83-${name}.png`) })
const step = async (name, fn) => {
  try {
    await fn()
  } catch (err) {
    await shot(`fail-${name}`)
    throw new Error(`${name}: ${err.message}`)
  }
}
const pickFolder = (path) => app.evaluate(({ dialog }, p) => (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })), path)
const bar = () => win.locator('.border-b', { has: win.getByRole('button', { name: 'Change…' }) }).filter({ visible: true }).first()
const change = async (item) => {
  await win.getByRole('button', { name: 'Change…' }).filter({ visible: true }).first().click()
  await win.getByRole('menuitem', { name: item }).click()
}
const openKb = async (name) => {
  const back = win.getByRole('button', { name: 'All connections' })
  if (await back.count()) await back.first().click()
  await win.getByText(name, { exact: true }).first().dblclick()
  await win.waitForTimeout(800)
  // The command palette opens the knowledge base of the connection just opened.
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
  await win.keyboard.type('Open knowledge base')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(600)
}

try {
  await win.waitForTimeout(800)
  const dev = await api('saveConnection', { id: '', name: 'Shop dev', driver: 'sqlite', filePath: join(files, 'dev.db') })
  const test = await api('saveConnection', { id: '', name: 'Shop test', driver: 'sqlite', filePath: join(files, 'test.db') })
  await api('setTeamFolder', team)
  await win.reload()
  await win.waitForTimeout(1000)

  await step('create', async () => {
    await openKb('Shop dev')
    await win.getByRole('button', { name: 'Create knowledge base' }).click()
    await bar().getByText('This computer').waitFor({ timeout: 10000 })
    await win.getByTitle('New file').first().click()
    await win.getByRole('dialog').locator('input').fill('orders.md')
    await win.keyboard.press('Enter')
    await win.getByText('orders.md').filter({ visible: true }).first().waitFor({ timeout: 10000 })
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
  })
  await shot('this-computer')
  console.log('1 header:', (await bar().innerText()).replace(/\s+/g, ' '))

  await step('choose folder (copy)', async () => {
    await pickFolder(repo)
    await change('Choose folder…')
    await win.getByRole('button', { name: 'Copy notes' }).click()
    await bar().getByText('…/ui83', { exact: false }).or(bar().getByText('project-notes', { exact: false })).first().waitFor({ timeout: 10000 })
  })
  console.log('2 chosen folder:', (await bar().innerText()).replace(/\s+/g, ' '), '| copied:', readdirSync(repo).join(','))

  await step('same as', async () => {
    await openKb('Shop test')
    await win.getByRole('button', { name: 'Create knowledge base' }).click()
    await bar().waitFor({ timeout: 10000 })
    await win.getByRole('button', { name: 'Change…' }).filter({ visible: true }).first().click()
    await win.getByRole('menuitem', { name: 'Use the same as…' }).click()
    await win.getByRole('menuitem', { name: 'Shop dev' }).click()
    await bar().getByText('Also used by Shop dev').waitFor({ timeout: 10000 })
    await win.getByText('orders.md').filter({ visible: true }).first().waitFor({ timeout: 10000 })
  })
  await shot('shared')
  // A note written through one connection shows in the other.
  await api('kbWrite', test.id, 'customers.md', '# Customers\n')
  console.log('3 shared:', (await bar().innerText()).replace(/\s+/g, ' '), '| dev sees:', (await api('kbList', dev.id)).map((f) => f.path).join(','))

  await step('team', async () => {
    await openKb('Shop dev')
    await change('Move to the team folder')
    await win.getByRole('button', { name: 'Copy to team folder' }).click()
    await bar().getByText('Team folder').waitFor({ timeout: 10000 })
  })
  console.log('4 team:', (await bar().innerText()).replace(/\s+/g, ' '), '| in team folder:', readdirSync(join(team, 'knowledge', dev.id)).join(','))

  await step('back', async () => {
    await change('Back to this computer')
    // This computer's folder already has the first note, so nothing is offered for copying.
    await bar().getByText('This computer').waitFor({ timeout: 10000 })
  })
  console.log('5 back:', (await bar().innerText()).replace(/\s+/g, ' '))

  // A team connection: the team's notes, or (for this user only) another folder.
  writeFileSync(join(team, 'connections.json'), JSON.stringify({ format: 'db-mastermind-connections', version: 1, connections: [{ id: 'team-shared', name: 'Shared DB', driver: 'sqlite', filePath: join(files, 'shared.db') }] }))
  mkdirSync(join(team, 'knowledge', 'team-shared'), { recursive: true })
  writeFileSync(join(team, 'knowledge', 'team-shared', 'team.md'), '# Team notes\n')
  await api('setTeamFolder', team)
  await win.reload()
  await win.waitForTimeout(1200)
  await step('team connection', async () => {
    await openKb('Shared DB')
    await bar().getByText('Shared through the team folder.').waitFor({ timeout: 10000 })
  })
  await shot('team-connection')
  const mine = join(home, 'my-notes')
  mkdirSync(mine)
  await step('personal', async () => {
    await pickFolder(mine)
    await change('Choose folder…')
    await win.getByRole('button', { name: 'Use it for me' }).click()
    await win.getByRole('button', { name: 'Use it empty' }).click()
    await bar().getByText('Only for you: colleagues use the team’s knowledge base.').waitFor({ timeout: 10000 })
  })
  await win.reload()
  await win.waitForTimeout(1200)
  const kept = await api('kbLocation', 'team-shared')
  console.log('6 personal after reload:', kept.personal, kept.path === mine, '| team copy untouched:', existsSync(join(team, 'knowledge', 'team-shared', 'team.md')))
  await step('back to team', async () => {
    await openKb('Shared DB')
    await change('Use the team’s knowledge base')
    await bar().getByText('Shared through the team folder.').waitFor({ timeout: 10000 })
  })
  console.log('7 team again:', (await api('kbLocation', 'team-shared')).place)

  // The connection form (database connections; file databases have no Advanced section).
  await api('saveConnection', { id: '', name: 'Shop PG', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', database: 'mastermind' })
  await win.reload()
  await win.waitForTimeout(1000)
  await step('form', async () => {
    const back = win.getByRole('button', { name: 'All connections' })
    if (await back.count()) await back.first().click()
    await win.getByText('Shop PG', { exact: true }).first().click({ button: 'right' })
    await win.getByText('Edit…', { exact: true }).first().click()
    await win.getByRole('dialog').getByRole('button', { name: 'Advanced', exact: true }).click()
    const dialog = win.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Change…' }).click()
    await win.getByRole('menuitem', { name: 'Use the same as…' }).click()
    await win.getByRole('menuitem', { name: 'Shop test' }).click()
    await dialog.getByText('Also used by', { exact: false }).waitFor({ timeout: 10000 })
  })
  await shot('form')
  const formPath = await win.getByRole('dialog').locator('input.font-mono').last().inputValue()
  console.log('8 form:', (await win.getByRole('dialog').getByText('Also used by', { exact: false }).innerText()).trim(), '| path field follows:', formPath.endsWith('project-notes'))
  await win.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
  await win.waitForTimeout(600)
  const pg = (await api('listConnections')).find((c) => c.name === 'Shop PG')
  console.log('  saved with the shared folder:', pg.knowledgeBasePath?.endsWith('project-notes'))
  console.log('errors:', errors.length ? errors : 'none')
} finally {
  await app.close()
}

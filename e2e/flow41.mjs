// Team folder: shared connections, queries and knowledge base, reloaded when colleagues change files.
import { _electron as electron } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui41-'))
const teamDir = join(dir, 'team')
mkdirSync(join(teamDir, 'queries', 'Reports'), { recursive: true })
mkdirSync(join(teamDir, 'knowledge', 'team-shop'), { recursive: true })
writeFileSync(join(teamDir, 'knowledge', 'team-shop', 'orders.md'), '# Orders\nStatus codes: N = new.')
writeFileSync(join(teamDir, 'connections.json'), JSON.stringify({ format: 'db-mastermind-connections', version: 1, connections: [{ name: 'Shop', driver: 'sqlite', filePath: join(dir, 'shop.db') }] }))
writeFileSync(join(teamDir, 'queries', 'Reports', 'Count.sql'), '-- connection: Shop\nSELECT 42 AS answer\n')
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(1000)
  console.log('status:', JSON.stringify(await api('setTeamFolder', teamDir)))
  const conns = await api('listConnections')
  console.log('connections:', JSON.stringify(conns.map((c) => ({ id: c.id, team: c.team, kb: c.knowledgeBasePath?.endsWith('team-shop') }))))
  const queries = await api('listSavedQueries')
  console.log('queries:', JSON.stringify(queries.map((q) => [q.id, q.folder, q.connectionId])))
  await api('saveQuery', { name: 'Mine', sql: 'SELECT 1', folder: 'Team/Reports', connectionId: 'team-shop' })
  console.log('written:', readFileSync(join(teamDir, 'queries', 'Reports', 'Mine.sql'), 'utf8').replace(/\n/g, '⏎'))
  // A colleague adds a connection.
  const raw = JSON.parse(readFileSync(join(teamDir, 'connections.json'), 'utf8'))
  raw.connections.push({ name: 'Colleague DB', driver: 'sqlite', filePath: join(dir, 'c.db') })
  writeFileSync(join(teamDir, 'connections.json'), JSON.stringify(raw))
  await win.waitForTimeout(2000)
  console.log('sidebar shows colleague DB:', await win.getByText('Colleague DB').count())
  // Share a personal connection with the team.
  const mine = await api('saveConnection', { id: '', name: 'My local', driver: 'sqlite', filePath: join(dir, 'mine.db'), password: 'x' })
  await api('addConnectionToTeam', mine.id)
  const after = JSON.parse(readFileSync(join(teamDir, 'connections.json'), 'utf8')).connections
  console.log('team file:', after.map((c) => c.name).join(', '), 'has password:', after.some((c) => 'password' in c))
  console.log('delete team conn:', await api('deleteConnection', mine.id).then(() => 'deleted', (e) => e.message.split('\n')[0].replace(/^.*Error: /, '')))
  await win.screenshot({ path: `${out}/r10-team-sidebar.png` })
  await win.keyboard.press('Meta+,')
  await win.waitForTimeout(400)
  await win.screenshot({ path: `${out}/r10-team-settings.png` })
  await api('setTeamFolder', null)
  console.log('after stop:', (await api('listConnections')).map((c) => `${c.name}${c.team ? '*' : ''}`).join(', '), existsSync(teamDir))
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/r10-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

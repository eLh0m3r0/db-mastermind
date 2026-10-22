// Managed configuration: predefined connection (locked), AI off, MCP read-only.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui40-'))
const managedPath = join(dir, 'dbmastermind-managed.json')
writeFileSync(managedPath, JSON.stringify({
  connections: [{ id: 'team-dwh', name: 'Team DWH', driver: 'sqlite', filePath: join(dir, 'dwh.db'), readOnly: true, color: '#2563eb', password: 'ignored' }],
  policies: { allowAi: false, allowMcpWrites: false, disableUpdateCheck: true },
}))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: join(dir, 'data'), DBM_MANAGED_CONFIG: managedPath, DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(1200)
  const list = await api('listConnections')
  console.log('connections:', JSON.stringify(list.map((c) => ({ id: c.id, managed: c.managed, aiEnabled: c.aiEnabled, readOnly: c.readOnly, password: c.password }))))
  const saved = await api('saveConnection', { ...list[0], host: 'x', filePath: '/tmp/other.db', name: 'Renamed' })
  console.log('after edit:', saved.name, saved.filePath === list[0].filePath)
  console.log('delete:', await api('deleteConnection', 'team-dwh').then(() => 'deleted', (e) => e.message.split('\n')[0]))
  await win.getByText('Team DWH').first().click({ button: 'right' })
  console.log('delete item disabled:', await win.getByRole('button', { name: /Delete \(managed/ }).isDisabled().catch(() => 'not found'))
  await win.keyboard.press('Escape')
  await win.screenshot({ path: `${out}/r9-managed-sidebar.png` })
  await win.keyboard.press('Meta+,')
  await win.getByRole('button', { name: 'About' }).click()
  await win.waitForTimeout(300)
  console.log('about:', await win.getByText(/predefined connections/).innerText())
  await win.screenshot({ path: `${out}/r9-managed-about.png` })
  await win.getByRole('dialog').getByRole('button', { name: 'AI assistant' }).click()
  console.log('ai notice:', await win.getByText('Your organization turned AI off (managed configuration).').count())
  const info = await api('getAppInfo')
  console.log('info.managed:', JSON.stringify(info.managed))
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/r9-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

// Diagrams shared through the team folder.
import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui50-'))
const teamDir = join(dir, 'team')
mkdirSync(teamDir)
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  const id = await api('createSampleDatabase')
  await api('setTeamFolder', teamDir)
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Demo coffee shop/ }).first().click()
  await win.waitForTimeout(1500)
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('Open ER diagram')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(2000)
  await win.getByRole('button', { name: 'Diagrams' }).click()
  await win.getByText('Save as new diagram…').click()
  await win.getByPlaceholder('e.g. Sales, Billing, Warehouse').fill('Orders')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: 'Orders' }).click()
  await win.getByText('Share with the team folder').click()
  await win.waitForTimeout(800)
  console.log('files:', readdirSync(join(teamDir, 'diagrams')))
  console.log('connection in file:', JSON.parse(readFileSync(join(teamDir, 'diagrams', 'Orders.json'), 'utf8')).connection)
  const list = await api('listDiagrams', id)
  console.log('listed:', JSON.stringify(list.map((d) => [d.name, !!d.team])))
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

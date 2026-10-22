// Share connections: export without secrets, import into a fresh profile.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = mkdtempSync(join(tmpdir(), 'dbm-share-'))
const file = join(out, 'team.json')
async function launch() {
  const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: mkdtempSync(join(tmpdir(), 'dbm-ui17-')), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
  const win = await app.firstWindow()
  await win.waitForTimeout(800)
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
  return { app, win, api }
}
const a = await launch()
await a.api('saveConnection', { id: '', name: 'Prod CRM', driver: 'postgres', host: 'db.example.com', user: 'analyst', password: 'secret!', database: 'crm', environment: 'production', ssh: { enabled: true, host: 'bastion', user: 'me', authMethod: 'password', password: 'sshsecret' } })
console.log('exported to', await a.api('exportConnections'))
await a.app.close()
const text = readFileSync(file, 'utf8')
console.log('contains secrets:', /secret/.test(text), '| host kept:', text.includes('db.example.com'))
const b = await launch()
console.log('imported:', await b.api('importConnections', 'file'))
console.log('list:', JSON.stringify((await b.api('listConnections')).map((c) => [c.name, c.host, c.environment, c.password ?? null])))
await b.app.close()

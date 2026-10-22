// SSH host key in the app (needs the `ssh` and `postgres` services): connect through the tunnel, see the remembered
// key in the connection's SSH settings, a forged key refused with a clear message, Forget, connect again.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui63-'))
const data = join(dir, 'data')
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: dir, DBM_USER_DATA: data, DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  const c = await api('saveConnection', { id: '', name: 'Behind bastion', driver: 'postgres', host: 'postgres', port: 5432, user: 'postgres', password: 'mastermind', database: 'mastermind', ssh: { enabled: true, host: '127.0.0.1', port: 2222, user: 'dbm', authMethod: 'password', password: 'sshsecret' } })
  await api('connect', c.id)
  const key = await api('sshHostKey', '127.0.0.1', 2222)
  console.log('remembered:', key)
  console.log('file:', readFileSync(join(data, 'known-hosts.json'), 'utf8').trim().replace(/\s+/g, ' '))
  await api('disconnect', c.id)
  // A forged key in the store, as if another server answered.
  writeFileSync(join(data, 'known-hosts.json'), JSON.stringify({ '[127.0.0.1]:2222': 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }))
  const refused = await api('connect', c.id).then(() => 'connected?!', (e) => e.message)
  console.log('forged:', refused.slice(0, 120))
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByText('Behind bastion', { exact: true }).first().click({ button: 'right' })
  await win.getByText('Edit…', { exact: true }).first().click()
  await win.getByRole('button', { name: 'SSH tunnel' }).click()
  await win.waitForTimeout(500)
  await win.screenshot({ path: `${out}/r63-ssh-key.png` })
  await win.getByText('Forget', { exact: true }).click()
  await win.waitForTimeout(500)
  console.log('after forget:', await win.getByText('Remembered on the first connection').count())
  await win.keyboard.press('Escape')
  await api('connect', c.id)
  console.log('reconnected, key again:', await api('sshHostKey', '127.0.0.1', 2222) === key)
  console.log('errors:', errors.length ? errors : 'none')
} finally {
  await app.close()
}

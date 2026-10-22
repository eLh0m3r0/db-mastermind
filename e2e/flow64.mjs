// A connection without a saved password (as imported from Beekeeper Studio): connecting asks for it, a wrong one is
// rejected with the server's reason, the right one connects and is saved; cancelling shows no error.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui64-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: dir, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  const c = await api('saveConnection', { id: '', name: 'Imported PG', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', database: 'mastermind' })
  await win.reload()
  await win.waitForTimeout(1000)
  const open = async () => {
    await win.getByText('Imported PG', { exact: true }).first().dblclick()
    await win.getByText('Password for postgres on Imported PG').waitFor({ timeout: 15000 })
  }
  // Cancel: no error toast.
  await open()
  console.log('prompt says:', await win.getByText('No password is saved for this connection.').count())
  await win.getByRole('button', { name: 'Cancel' }).click()
  await win.waitForTimeout(800)
  console.log('error toast after cancel:', await win.getByText('Could not connect to Imported PG').count())
  // Wrong, then right.
  await open()
  await win.locator('input[type=password]').last().fill('wrong')
  await win.keyboard.press('Enter')
  await win.getByText('The server rejected the password.').waitFor({ timeout: 15000 })
  console.log('rejected detail:', (await win.getByText(/password authentication failed/).first().innerText()).slice(0, 60))
  await win.screenshot({ path: `${out}/r64-rejected.png` })
  await win.locator('input[type=password]').last().fill('mastermind')
  await win.getByRole('button', { name: 'Connect', exact: true }).click()
  await win.getByPlaceholder(/Filter .+ tables/).waitFor({ timeout: 15000 })
  const saved = (await api('listConnections')).find((x) => x.id === c.id)
  console.log('connected; password saved:', saved.password === 'mastermind')
  console.log('errors:', errors.length ? errors : 'none')
} catch (err) {
  await win.screenshot({ path: `${out}/r64-failure.png` })
  console.log('errors:', errors)
  throw err
} finally {
  await app.close()
}

// Company sign-ins (Milestone 11, C): a PostgreSQL connection whose password comes from a command (a password manager)
// connects without a saved password; one through an SSH jump host connects too; the connection form shows both, and
// SQL Server's Microsoft Entra ID choice (explained, with a service principal option) fails clearly on a server that
// doesn't take it. Needs `npm run db:up` (postgres, mssql, ssh).
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? tmpdir()
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui107-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const check = (label, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) process.exitCode = 1
}
const editConnection = async (name) => {
  await win.getByRole('button', { name: 'All connections' }).click().catch(() => {})
  await win.getByText(name, { exact: true }).first().click({ button: 'right' })
  await win.getByText('Edit…', { exact: true }).click()
  await win.getByRole('dialog').waitFor({ timeout: 5000 })
}
try {
  await win.waitForTimeout(800)
  const node = process.execPath.replace(/"/g, '\\"')
  const vault = await api('saveConnection', { id: '', name: 'Vault PG', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', database: 'mastermind', passwordCommand: `"${node}" -e "console.log('mastermind')"` })
  await api('saveConnection', { id: '', name: 'Jump PG', driver: 'postgres', host: 'postgres', port: 5432, user: 'postgres', password: 'mastermind', database: 'mastermind', ssh: { enabled: true, host: 'localhost', port: 2222, user: 'dbm', authMethod: 'password', password: 'sshsecret', jump: { host: '127.0.0.1', port: 2222 } } })
  await api('saveConnection', { id: '', name: 'Entra MS', driver: 'mssql', host: '127.0.0.1', port: 14339, database: 'master', options: { authentication: 'entra', trustServerCertificate: true } })
  await win.reload()

  // Password from a command.
  await win.getByText('Vault PG', { exact: true }).first().dblclick()
  await win.locator('[data-sidebar-filter]').waitFor({ timeout: 20000 })
  check('a password command connects without a saved password', (await api('listConnections')).find((c) => c.id === vault.id)?.password === undefined)
  await editConnection('Vault PG')
  check('the form shows the password command instead of a password', (await win.getByTestId('password-command').inputValue()).includes("console.log('mastermind')"))
  await win.screenshot({ path: `${out}/r107-password-command.png` })
  await win.keyboard.press('Escape')

  // SSH through a jump host.
  await win.getByRole('button', { name: 'All connections' }).click()
  await win.getByText('Jump PG', { exact: true }).first().dblclick()
  await win.locator('[data-sidebar-filter]').waitFor({ timeout: 20000 })
  check('a connection through an SSH jump host connects', (await win.getByText('shop', { exact: true }).count()) > 0)
  await editConnection('Jump PG')
  await win.getByRole('dialog').getByRole('button', { name: /SSH tunnel/ }).click()
  check('the SSH section shows the jump host', (await win.getByTestId('ssh-jump-host').inputValue()) === '127.0.0.1')
  await win.screenshot({ path: `${out}/r107-jump.png` })
  await win.keyboard.press('Escape')

  // Microsoft Entra ID on a server that doesn't take it.
  await editConnection('Entra MS')
  await win.getByRole('button', { name: 'Microsoft Entra ID', pressed: true }).waitFor({ timeout: 5000 }).catch(() => {})
  const pressed = await win.getByRole('button', { name: 'Microsoft Entra ID', pressed: true }).count()
  const explained = await win.getByRole('dialog').getByText(/az login/).count()
  check(`Entra ID is the chosen sign-in and explained (${pressed}, ${explained})`, pressed === 1 && explained >= 1)
  check('no NTLM domain field next to Entra ID', (await win.getByText('Windows domain (NTLM, optional)').count()) === 0)
  await win.getByText('Use a service principal…').click()
  check('a service principal asks for tenant, client id and secret', (await win.getByText('Tenant ID', { exact: true }).count()) === 1 && (await win.getByText('Client secret', { exact: true }).count()) === 1)
  await win.screenshot({ path: `${out}/r107-entra.png` })
  await win.keyboard.press('Escape')
  const outcome = await api('connect', (await api('listConnections')).find((c) => c.name === 'Entra MS').id).then(() => 'connected', (e) => e.message)
  check('Entra ID on a plain SQL Server fails with an explanation, not a password prompt', /did not accept Microsoft Entra ID/.test(outcome))
  check('no page errors', errors.length === 0)
  if (errors.length) console.log(errors)
} catch (err) {
  console.log('FAIL', err)
  await win.screenshot({ path: `${out}/r107-failure.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await app.close()
}

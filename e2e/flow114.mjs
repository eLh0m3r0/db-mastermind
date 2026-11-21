// Services by name (Milestone 12, A3): a pasted Supabase pooler URL names the service under the host
// ("Supabase (PostgreSQL)"), explains port 6543, fills the empty name and turns TLS to require because the URL says
// nothing about it; a URL that does say (sslmode=disable) keeps its word; a plain host names no service. Nothing
// connects anywhere.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? tmpdir()
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui114-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` (${detail})`}`)
  if (!ok) process.exitCode = 1
}
const paste = async (url) => {
  await win.getByPlaceholder(/Paste a connection URL/).fill(url)
  await win.getByPlaceholder(/Paste a connection URL/).press('Enter')
  await win.waitForTimeout(400)
}
const sslMode = async () => {
  await win.getByRole('button', { name: /^SSL \/ TLS/ }).click()
  const mode = await win.locator('select:visible').first().inputValue()
  await win.getByRole('button', { name: /^General/ }).click()
  return mode
}
try {
  await win.getByRole('button', { name: 'New connection' }).first().click()
  await win.getByPlaceholder(/Paste a connection URL/).waitFor({ timeout: 10000 })
  // (The services are named in a line under the field: a placeholder that long was cut.)
  check('the paste field names a few services', /Supabase, Neon/.test(await win.getByTestId('url-services-hint').innerText()))

  await paste('postgresql://postgres.abcdefghijklmnop:not-a-real-password@aws-0-eu-central-1.pooler.supabase.com:6543/postgres')
  const line = win.getByTestId('connection-service')
  check('the service under the host', (await line.innerText()).startsWith('Supabase (PostgreSQL)'), await line.innerText())
  check('port 6543 is explained', /transaction pooler/.test(await line.innerText()))
  check('the empty name is the service’s', (await win.getByPlaceholder('Production CRM').inputValue()) === 'Supabase')
  check('TLS required for the service', (await sslMode()) === 'require')
  await win.screenshot({ path: `${out}/r114-supabase.png` })

  // A URL that says what it wants about TLS keeps it; the name the user gave stays.
  await win.getByPlaceholder('Production CRM').fill('Branch DB')
  await paste('postgres://app:x@ep-cool-river-123456.eu-central-1.aws.neon.tech/neondb?sslmode=disable')
  check('Neon is named', (await line.innerText()).startsWith('Neon (PostgreSQL)'))
  check('no pooler note on another port', !/transaction pooler/.test(await line.innerText()))
  check('the URL’s own sslmode is kept', (await sslMode()) === 'disable')
  check('a name the user gave stays', (await win.getByPlaceholder('Production CRM').inputValue()) === 'Branch DB')

  await paste('postgres://postgres:x@127.0.0.1:54329/mastermind')
  check('a plain host names no service', (await line.count()) === 0)
  // Typed by hand: the line follows the host.
  await win.getByPlaceholder('localhost').fill('shop.database.windows.net')
  await win.getByRole('button', { name: 'SQL Server', exact: true }).click()
  await win.waitForTimeout(300)
  check('a host typed by hand: Azure SQL (SQL Server)', (await line.innerText()).startsWith('Azure SQL (SQL Server)'), await line.count() ? await line.innerText() : 'none')
  await win.screenshot({ path: `${out}/r114-azure.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  process.exitCode = 1
  await win.screenshot({ path: `${out}/r114-error.png` }).catch(() => {})
} finally {
  check('no page errors', errors.length === 0, JSON.stringify(errors.slice(0, 3)))
  await app.close()
}

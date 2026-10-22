// Review fixes, in the running app: `node e2e/flow84.mjs <screenshot dir>`
// 1. Saved secrets that can't be decrypted (keychain unavailable) survive saving: renaming the connection and the
//    last-used time written on connect keep their ciphertext. Same for an AI provider's API key.
// 2. A raw SQL grid filter that smuggles in a DELETE is refused and the table keeps its rows.
// 3. A connection the organization turned AI off for shows AI off and locked, whatever the user had set.
import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'dbm-shots84-'))
const home = mkdtempSync(join(tmpdir(), 'dbm-ui84-'))
const data = join(home, 'data')
mkdirSync(data, { recursive: true })
const file = join(home, 'shop.db')
const db = new DatabaseSync(file)
db.exec("CREATE TABLE items (id integer primary key, name text); INSERT INTO items (name) VALUES ('apple'), ('pear'), ('plum')")
db.close()

// Ciphertexts this machine can't open (as when the keychain doesn't answer).
const sealedPassword = 'enc:v2:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const sealedSsh = 'enc:v1:Tm90IGEgcmVhbCBzZWNyZXQ='
const sealedKey = 'enc:v1:YW5vdGhlciBzZWNyZXQ='
const now = new Date().toISOString()
writeFileSync(
  join(data, 'connections.json'),
  JSON.stringify([
    { id: 'shop', name: 'Shop', driver: 'sqlite', filePath: file, password: sealedPassword, createdAt: now, updatedAt: now },
    { id: 'pg', name: 'Behind SSH', driver: 'postgres', host: 'db.internal', ssh: { host: 'bastion', user: 'me', authMethod: 'password', password: sealedSsh }, createdAt: now, updatedAt: now },
    { id: 'erp', name: 'ERP', driver: 'sqlite', filePath: file, ai: { access: 'write', agents: true, agentWrites: true }, createdAt: now, updatedAt: now },
  ]),
)
writeFileSync(join(data, 'settings.json'), JSON.stringify({ language: 'en', ai: { providers: [{ id: 'anthropic', enabled: true, apiKey: sealedKey }] } }))
const managed = join(home, 'managed.json')
writeFileSync(managed, JSON.stringify({ connections: [{ id: 'erp', name: 'ERP', driver: 'sqlite', filePath: file, aiEnabled: false }] }))

const app = await electron.launch({
  args: ['apps/desktop'],
  env: { ...process.env, HOME: home, DBM_USER_DATA: data, DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_MANAGED_CONFIG: managed },
  timeout: 60_000,
})
const win = await app.firstWindow()
// Off-screen and in the background: never in the way of whoever uses this Mac.
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  w.setBounds({ x: -4000, y: 0, width: 1280, height: 800 })
  w.blur()
})
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
try {
  await win.waitForTimeout(1000)

  // 1. Undecryptable secrets survive saves.
  const list = await api('listConnections')
  const shop = list.find((c) => c.id === 'shop')
  check('undecryptable password is not handed out', shop.password === undefined)
  await api('saveConnection', { ...shop, name: 'Shop (renamed)' })
  await api('connect', 'shop')
  await api('updateSettings', { pageSize: 300 })
  await win.waitForTimeout(500)
  const saved = JSON.parse(readFileSync(join(data, 'connections.json'), 'utf8'))
  check('password ciphertext kept after rename + connect', saved.find((c) => c.id === 'shop').password === sealedPassword)
  check('connection renamed', saved.find((c) => c.id === 'shop').name === 'Shop (renamed)')
  check('SSH password ciphertext kept', saved.find((c) => c.id === 'pg').ssh.password === sealedSsh)
  const settings = JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8'))
  check('API key ciphertext kept', settings.ai.providers.find((p) => p.id === 'anthropic').apiKey === sealedKey, settings.ai.providers[0].apiKey)
  check('the managed connection is listed as AI locked off', list.find((c) => c.id === 'erp').aiLockedOff === true)

  // 2. A raw filter with a DELETE, typed in the grid.
  await win.reload()
  await win.waitForTimeout(1200)
  await win.getByText('Shop (renamed)', { exact: true }).first().click()
  await win.waitForTimeout(1200)
  await win.getByText('items', { exact: true }).first().click()
  await win.waitForTimeout(1200)
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f')
  await win.waitForTimeout(500)
  // Only the raw condition: drop the empty one the filter bar starts with.
  await win.getByRole('button', { name: 'Remove condition' }).first().click()
  await win.getByRole('button', { name: 'Raw SQL' }).click()
  const raw = win.getByPlaceholder('raw SQL condition, e.g. total > discount * 2')
  await raw.fill("1=1); DELETE FROM items; --")
  await raw.press('Enter')
  await win.waitForTimeout(1200)
  await win.screenshot({ path: join(out, '84-raw-filter.png') })
  const body = await win.locator('body').innerText()
  check('grid shows the refusal', /A SQL filter can only be a condition that reads/.test(body))
  const check2 = new DatabaseSync(file)
  const n = check2.prepare('SELECT count(*) AS n FROM items').get().n
  check2.close()
  check('table keeps its rows', n === 3, `${n} rows`)
  await raw.fill("name LIKE 'p%'")
  await raw.press('Enter')
  await win.waitForTimeout(1200)
  await win.screenshot({ path: join(out, '84-raw-filter-ok.png') })
  const after = await win.locator('body').innerText()
  check('a normal raw filter still works', /pear/.test(after) && /plum/.test(after) && !/apple/.test(after), after.slice(0, 600).replace(/\n/g, ' | '))

  // 3. AI permissions: ERP is off and locked.
  await win.keyboard.press('Escape')
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,')
  await win.waitForTimeout(600)
  await win.locator('[role=dialog] nav button', { hasText: 'AI permissions' }).click()
  await win.waitForTimeout(600)
  await win.screenshot({ path: join(out, '84-ai-permissions.png') })
  const row = win.locator('[role=dialog]').locator('div', { has: win.getByText('ERP', { exact: true }) }).last()
  const select = row.locator('select').first()
  check('ERP shows AI off', (await select.inputValue()) === 'off')
  check('ERP selector is locked', await select.isDisabled())
  const effective = await win.evaluate(() => window.mastermind.api.aiChat ? 'has chat' : 'no chat')
  void effective
} finally {
  console.log('page errors:', errors.length ? errors : 'none')
  console.log('screenshots:', out)
  await app.close()
}
if (results.includes(false)) process.exit(1)

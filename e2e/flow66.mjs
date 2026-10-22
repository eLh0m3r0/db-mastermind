// Import from Beekeeper Studio carries its saved passwords (decrypted with Beekeeper's local key, as Beekeeper does),
// and importing again fills in the password of a connection imported earlier without one. A fake Beekeeper profile
// in a temporary HOME; the passwords are encrypted the way Beekeeper's simple-encryptor does it.
import { _electron as electron } from '@playwright/test'
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const home = mkdtempSync(join(tmpdir(), 'dbm-ui66-'))
const appData = process.platform === 'darwin' ? join(home, 'Library', 'Application Support') : process.platform === 'win32' ? join(home, 'AppData', 'Roaming') : join(home, '.config')
const bk = join(appData, 'beekeeper-studio')
mkdirSync(bk, { recursive: true })
const encrypt = (key, value) => {
  const k = createHash('sha256').update(key).digest()
  const iv = randomBytes(16)
  const c = createCipheriv('aes-256-cbc', k, iv)
  const body = iv.toString('hex') + c.update(JSON.stringify(value), 'utf8', 'base64') + c.final('base64')
  return createHmac('sha256', k).update(body).digest('hex') + body
}
const userKey = randomBytes(32).toString('hex')
writeFileSync(join(bk, '.key'), encrypt('38782F413F442A472D4B6150645367566B59703373367639792442264529482B', { encryptionKey: userKey }))
const db = new DatabaseSync(join(bk, 'app.db'))
db.exec(`CREATE TABLE saved_connection (id INTEGER PRIMARY KEY, connectionType TEXT, host TEXT, port INTEGER, username TEXT, defaultDatabase TEXT, path TEXT,
  name TEXT, password TEXT, rememberPassword INTEGER, sshEnabled INTEGER, sshHost TEXT, sshPort INTEGER, sshMode TEXT, sshUsername TEXT, sshPassword TEXT,
  sshKeyfile TEXT, sshKeyfilePassword TEXT, ssl INTEGER, sslRejectUnauthorized INTEGER, trustServerCertificate INTEGER, domain TEXT)`)
const add = db.prepare('INSERT INTO saved_connection (connectionType, host, port, username, defaultDatabase, name, password, rememberPassword, sshEnabled, sshHost, sshPort, sshMode, sshUsername, sshPassword) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
add.run('postgresql', '127.0.0.1', 54329, 'postgres', 'mastermind', 'Local PG', encrypt(userKey, 'mastermind'), 1, 0, null, null, 'agent', null, null)
add.run('postgresql', 'db.internal', 5432, 'app', 'prod', 'Behind SSH', encrypt(userKey, 'dbpass'), 1, 1, 'bastion', 22, 'userpass', 'me', encrypt(userKey, 'sshpass'))
add.run('mysql', 'mysql.internal', 3306, 'root', 'shop', 'Not remembered', encrypt(userKey, 'nope'), 0, 0, null, null, 'agent', null, null)
db.close()

const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: home, APPDATA: join(home, 'AppData', 'Roaming'), DBM_USER_DATA: join(home, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  // An earlier import (before passwords were read) left this one without a password, and its database was changed since.
  await api('saveConnection', { id: '', name: 'Local PG', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', database: 'postgres' })
  console.log('import:', JSON.stringify(await api('importConnections', 'beekeeper')))
  const list = await api('listConnections')
  for (const c of list) console.log(' ', c.name, '| db:', c.database, '| password:', c.password ?? null, '| ssh password:', c.ssh?.password ?? null)
  console.log('again:', JSON.stringify(await api('importConnections', 'beekeeper')))
  const pg = list.find((c) => c.name === 'Local PG')
  await api('connect', pg.id)
  console.log('Local PG connects with the imported password')
} finally {
  await app.close()
}

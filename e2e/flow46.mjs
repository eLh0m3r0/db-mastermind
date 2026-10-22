// Backup and restore: PostgreSQL through pg_dump/pg_restore, SQLite through VACUUM INTO.
import { _electron as electron } from '@playwright/test'
import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui46-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const stubDialogs = (path) => app.evaluate(({ dialog }, path) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
}, path)
const count = async (id) => (await api('runQuery', { connectionId: id, sql: 'SELECT count(*) FROM bk', runId: 'c' + Math.random() }))[0]
try {
  await win.waitForTimeout(800)
  const pg = await api('saveConnection', { id: '', name: 'backup test', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'dbm_backup_test' })
  await stubDialogs(join(dir, 'pg.dump'))
  const b = await api('backupDatabase', pg.id)
  console.log('pg backup:', b.bytes > 1000, existsSync(join(dir, 'pg.dump')))
  await api('connect', pg.id)
  await api('runQuery', { connectionId: pg.id, sql: 'DROP TABLE bk', runId: 'd' })
  console.log('after drop:', (await count(pg.id)).error ? 'table gone' : 'still there?')
  const r = await api('restoreDatabase', pg.id)
  console.log('restore:', !!r.path, 'rows:', JSON.stringify((await count(pg.id)).results?.[0]?.rows))
  const sq = await api('createSampleDatabase')
  await stubDialogs(join(dir, 'shop.db'))
  const s = await api('backupDatabase', sq)
  console.log('sqlite backup bytes:', s.bytes, statSync(join(dir, 'shop.db')).size > 10000)
  const ms = await api('saveConnection', { id: '', name: 'ms', driver: 'mssql', host: '127.0.0.1', database: 'ERP' })
  console.log('mssql:', (await api('backupDatabase', ms.id)).sql.split('\n')[1])
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

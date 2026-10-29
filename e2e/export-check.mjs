// Excel and CSV export in the running app, from the demo database: `node e2e/export-check.mjs [out dir]`.
// DBM_EXE runs a packaged app instead of the development build (the Windows install check uses it on x64 and Arm).
import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'

const out = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'dbm-export-'))
mkdirSync(out, { recursive: true })
const home = mkdtempSync(join(tmpdir(), 'dbm-export-home-'))
const data = join(home, 'data')
mkdirSync(data)
const env = { ...process.env, HOME: home, USERPROFILE: home, DBM_USER_DATA: data, DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'cs', DBM_E2E_BACKGROUND: '1' }
const app = await electron.launch(process.env.DBM_EXE ? { executablePath: process.env.DBM_EXE, args: [], env, timeout: 90_000 } : { args: ['apps/desktop'], env, timeout: 90_000 })
const win = await app.firstWindow()
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args).then((v) => ({ v }), (e) => ({ e: e.message })), [fn, args])
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const saveTo = (path) => app.evaluate(({ dialog }, p) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: p })
}, path)
try {
  await win.waitForTimeout(1500)
  const id = (await api('createSampleDatabase')).v
  await api('connect', id)

  for (const [name, request] of [
    ['table.xlsx', () => api('exportTable', { format: 'xlsx', connectionId: id, table: { name: 'orders' } })],
    ['query.xlsx', () => api('exportQuery', { format: 'xlsx', connectionId: id, sql: 'SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id', defaultName: 'q' })],
  ]) {
    const path = join(out, name)
    await saveTo(path)
    const r = await request()
    if (r.e) {
      check(`${name} exported`, false, r.e)
      continue
    }
    const parts = unzipSync(readFileSync(path))
    const sheet = strFromU8(parts['xl/worksheets/sheet1.xml'])
    const rows = (sheet.match(/<row /g) ?? []).length
    check(`${name}: a complete workbook`, !!parts['[Content_Types].xml'] && !!parts['xl/workbook.xml'] && rows === 1201 && sheet.endsWith('</worksheet>'), `${statSync(path).size} bytes, ${rows} rows`)
  }
  const csv = join(out, 'table.csv')
  await saveTo(csv)
  await api('exportTable', { format: 'csv', connectionId: id, table: { name: 'orders' } })
  const lines = readFileSync(csv, 'utf8').trim().split(/\r?\n/).length
  check('CSV export has every row', lines === 1201, `${lines} lines`)
} finally {
  await app.close()
}
if (results.includes(false)) process.exit(1)

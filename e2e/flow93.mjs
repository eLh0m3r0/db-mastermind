// Diagram to PDF: the whole model on one page, and at readable size on several A4 pages.
import { _electron as electron } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'dbm-ui93-'))
const model = join(dir, 'wide.dbml')
// Twelve related tables: wide enough that full size needs more than one sheet.
const tables = Array.from({ length: 12 }, (_, i) => `Table area_${i} {\n  id int [pk]\n  name varchar(80)\n  created_at timestamp\n  ${i ? `parent_id int [ref: > area_${i - 1}.id]` : 'note text'}\n}`)
writeFileSync(model, `${tables.join('\n')}\n`)
const pdf = { one: join(dir, 'one.pdf'), many: join(dir, 'many.pdf') }
const app = await electron.launch({ args: ['apps/desktop', model], env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' } })
const win = await app.firstWindow()
const pages = (file) => (existsSync(file) ? (readFileSync(file, 'latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length : -1)
try {
  await win.locator('.react-flow__node').nth(11).waitFor({ timeout: 20000 })
  for (const [kind, label] of [['one', 'PDF, one page'], ['many', 'PDF, readable size on several pages']]) {
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, pdf[kind])
    await win.getByRole('button', { name: 'Export', exact: true }).click()
    await win.getByText(label, { exact: true }).click()
    await win.getByText('Diagram saved').last().waitFor({ timeout: 60000 })
    await win.waitForTimeout(600)
    const head = existsSync(pdf[kind]) ? readFileSync(pdf[kind], 'latin1').slice(0, 5) : ''
    console.log(`${kind}:`, head, 'pages', pages(pdf[kind]), 'kB', existsSync(pdf[kind]) ? Math.round(readFileSync(pdf[kind]).length / 1024) : 0)
    // The toast of the first export must be gone before the second is awaited.
    await win.waitForTimeout(5000)
  }
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
} finally {
  await app.close()
}

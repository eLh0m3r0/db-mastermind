// Prisma schema import into a model document.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui51-'))
const file = join(dir, 'schema.prisma')
writeFileSync(file, readFileSync('packages/core/test/prisma.test.ts', 'utf8').split('const schema = `')[1].split('`')[0])
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, file)
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
try {
  await win.waitForTimeout(800)
  await win.evaluate(() => window.mastermind.api.createSampleDatabase())
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Demo coffee shop/ }).first().click()
  await win.waitForTimeout(1500)
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('New model')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Import SQL/ }).click()
  await win.waitForTimeout(1500)
  const text = await win.locator('.cm-content:visible').first().innerText()
  console.log('tables:', ['Table users', 'Table Post', 'Table Profile', 'Table Membership', 'Enum Role'].map((s) => text.includes(s)))
  console.log('ref:', text.includes('Ref: Post.author_id > users.id [delete: cascade]'))
  console.log('diagram tables:', await win.locator('.react-flow__node').count())
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

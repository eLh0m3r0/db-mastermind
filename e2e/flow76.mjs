// Model (DBML) editor: ⌘F opens search (it typed into the model instead); a model change compared with the database
// becomes an ADD COLUMN migration.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const dir = mkdtempSync(join(tmpdir(), 'dbm-b5-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: dir, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
try {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await win.waitForTimeout(800)
  await win.getByRole('button', { name: /demo database/ }).first().click()
  await win.getByPlaceholder(/Filter .+ tables/).waitFor({ timeout: 20000 })
  await win.keyboard.press(`${mod}+k`); await win.keyboard.type('Open ER diagram'); await win.keyboard.press('Enter')
  await win.locator('.react-flow__node').first().waitFor({ timeout: 20000 })
  await win.getByRole('button', { name: 'Export' }).click()
  await win.getByText('Edit as model (DBML)…').click()
  await win.waitForTimeout(1200)
  // Change the model: add a column to customers in the DBML text.
  const ed = win.locator('.cm-content:visible').first()
  await ed.click()
  await win.keyboard.press(`${mod}+f`)
  await win.waitForTimeout(300)
  console.log('search panel open:', await win.locator('.cm-search').count())
  await win.keyboard.type('Table customers')
  await win.keyboard.press('Enter')
  await win.keyboard.press('Escape')
  await win.keyboard.press('End')
  await win.keyboard.press('Enter')
  await win.keyboard.type('  loyalty_points integer')
  await win.waitForTimeout(400)
  
  
  await win.getByRole('button', { name: /Compare/ }).filter({ visible: true }).first().click()
  await win.waitForTimeout(800)
  await win.getByRole('button', { name: 'Compare', exact: true }).last().click()
  await win.waitForTimeout(2500)
  await win.screenshot({ path: `${out}/b5-compare.png` })
  console.log('mentions loyalty_points:', await win.getByText(/loyalty_points/).count(), '| ADD COLUMN:', await win.getByText(/ADD COLUMN|Add column/i).count())
  console.log('errors:', errors.length ? errors : 'none')
} finally { await app.close() }

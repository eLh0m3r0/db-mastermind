// Query a CSV file with SQL (built-in DuckDB): palette → file dialog (stubbed) → results.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const [out, file] = process.argv.slice(2)
const userData = mkdtempSync(join(tmpdir(), 'dbm-ui13-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: userData, DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
try {
  await win.waitForTimeout(1000)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('Query a CSV')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(3000)
  await win.screenshot({ path: `${out}/a0-csv.png` })
  // Aggregate with Czech column names.
  const editor = win.locator('.cm-content').first()
  await editor.click()
  await win.keyboard.press('Meta+a')
  await win.keyboard.insertText(`SELECT pobočka, sum(množství * cena) AS tržba, count(*) AS prodeje\nFROM read_csv('${file.replaceAll("'", "''")}', decimal_separator = ',')\nGROUP BY ALL\nORDER BY tržba DESC;`)
  await win.keyboard.press('Meta+Enter')
  await win.waitForTimeout(2000)
  await win.screenshot({ path: `${out}/a1-csv-agg.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/99-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

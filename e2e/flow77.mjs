// The assistant's "Insert" puts a whole statement on its own lines (it used to glue it onto the statement at the
// cursor: "LIMIT 3;SELECT …"). Uses the same event the AI panel sends, so no model is needed.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui77-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: dir, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
try {
  await win.waitForTimeout(800)
  await win.getByRole('button', { name: /demo database/ }).first().click()
  await win.waitForTimeout(2000)
  const editor = win.locator('.cm-content:visible').first()
  await editor.click()
  await win.keyboard.type('SELECT 1;')
  await win.waitForTimeout(800)
  // The workspace is saved as tabs change; its active tab is the editor typed into.
  const tabId = await win.evaluate(() => window.mastermind.api.loadWorkspace().then((w) => w?.activeTabId))
  if (!tabId) throw new Error('no active tab')
  const insert = (text) => win.evaluate(([tabId, text]) => window.dispatchEvent(new CustomEvent('editor:insert', { detail: { tabId, text, block: true } })), [tabId, text])
  await insert('SELECT 2;')
  await insert('SELECT 3;\n')
  const text = await win.evaluate(() => [...document.querySelectorAll('.cm-content:not([aria-hidden]) .cm-line')].filter((l) => l.offsetParent).map((l) => l.textContent).join('\n'))
  console.log(JSON.stringify(text))
  if (text !== 'SELECT 1;\n\nSELECT 2;\n\nSELECT 3;') throw new Error('unexpected editor text')
  console.log('ok')
} finally {
  await app.close()
}

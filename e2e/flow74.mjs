// Dialogs keep Tab inside (it walked on into the sidebar behind), and with a confirmation stacked on a dialog,
// Esc closes only the top one.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui74-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: dir, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const inDialog = () => win.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))
try {
  await win.waitForTimeout(800)
  await win.getByRole('button', { name: 'New connection' }).first().click()
  await win.waitForTimeout(400)
  let escaped = 0
  for (let i = 0; i < 60; i++) { await win.keyboard.press('Tab'); if (!(await inDialog())) escaped++ }
  for (let i = 0; i < 20; i++) { await win.keyboard.press('Shift+Tab'); if (!(await inDialog())) escaped++ }
  console.log('Tab presses that left the dialog:', escaped)
  console.log('color swatches named:', await win.getByRole('button', { name: 'Purple' }).count())
  await win.keyboard.press('Escape')
  // A confirmation over the settings dialog: Esc closes the confirmation only.
  await api('saveConnection', { id: '', name: 'X', driver: 'sqlite', filePath: join(dir, 'x.db') })
  await win.reload(); await win.waitForTimeout(800)
  await win.getByText('X', { exact: true }).first().click({ button: 'right' })
  await win.getByText('Delete', { exact: true }).click()
  await win.waitForTimeout(300)
  console.log('dialogs open:', await win.getByRole('dialog').count())
  await win.keyboard.press('Escape')
  await win.waitForTimeout(300)
  console.log('after Esc:', await win.getByRole('dialog').count(), '| connection kept:', (await api('listConnections')).some((c) => c.name === 'X'))
} finally {
  await app.close()
}

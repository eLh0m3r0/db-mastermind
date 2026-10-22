// "Design with AI…" asks in a multiline dialog. Enter used to only add a line (⌘Enter sent it) while the AI panel
// next to it sends on Enter, so the request looked stuck. Enter now sends and Shift+Enter adds a line. No model is
// needed: a fresh profile has no AI provider, so the request just lands in the panel.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui78-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: dir, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
win.setDefaultTimeout(15000)
// Keep the window out of the way: off to the right and unfocused.
await app.evaluate(({ BrowserWindow, screen }) => { const w = BrowserWindow.getAllWindows()[0]; const a = screen.getPrimaryDisplay().workArea; w.setBounds({ x: a.x + a.width - 24, y: a.y + 40, width: 1440, height: 900 }); w.blur() })
try {
  await win.waitForTimeout(800)
  await win.getByRole('button', { name: /demo database/ }).first().click()
  await win.waitForTimeout(2000)
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('Open ER diagram')
  await win.keyboard.press('Enter')
  await win.getByRole('button', { name: 'Design', exact: true }).click()
  await win.getByRole('button', { name: 'Design with AI…' }).click()
  const dialog = win.getByRole('dialog')
  const box = dialog.locator('textarea')
  await box.click()
  await win.keyboard.type('add a reviews table')
  await win.keyboard.press('Shift+Enter')
  await win.keyboard.type('with a rating')
  if ((await box.inputValue()) !== 'add a reviews table\nwith a rating') throw new Error(`Shift+Enter: ${JSON.stringify(await box.inputValue())}`)
  if (!(await dialog.getByText('Enter to send').isVisible())) throw new Error('no Enter hint')
  await win.keyboard.press('Enter')
  await dialog.waitFor({ state: 'hidden', timeout: 5000 })
  // The request reached the assistant panel.
  await win.getByText('AI assistant').first().waitFor({ timeout: 5000 })
  console.log('ok')
} catch (err) {
  await win.screenshot({ path: join(dir, 'flow78-fail.png') }).catch(() => {})
  console.log('screenshot', join(dir, 'flow78-fail.png'))
  throw err
} finally {
  await app.close()
}

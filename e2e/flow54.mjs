// Help → Check for Updates answers in a development build.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: mkdtempSync(join(tmpdir(), 'dbm-ui54-')), DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
try {
  await win.waitForTimeout(1000)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'check-updates'))
  await win.waitForTimeout(800)
  console.log('toast:', await win.getByText('Updates are checked in installed builds only').count())
  const menu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find((i) => i.role === 'help')?.submenu?.items.map((i) => i.label))
  console.log('help menu:', JSON.stringify(menu))
} finally {
  await app.close()
}

// Dev helper: launches the built app with a throwaway profile and saves screenshots.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'e2e-shots'
const userData = process.env.DBM_USER_DATA ?? mkdtempSync(join(tmpdir(), 'dbm-ui-'))
const app = await electron.launch({
  args: ['apps/desktop'],
  env: { ...process.env, DBM_USER_DATA: userData, DBM_NO_UPDATE_CHECK: '1' },
})
const win = await app.firstWindow()
win.on('console', (m) => console.log(`[console.${m.type()}]`, m.text()))
win.on('pageerror', (e) => console.log('[pageerror]', e.message))
await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {})
await win.waitForTimeout(1500)
await win.screenshot({ path: `${out}/home.png` })
console.log('userData', userData)
await app.close()

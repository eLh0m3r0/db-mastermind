// Settings → AI assistant → Test for the agent CLIs reports whether they are signed in, not only that they exist.
// Signed out is simulated with empty config folders (CODEX_HOME / CLAUDE_CONFIG_DIR); no model calls.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
async function run(label, extraEnv) {
  const dir = mkdtempSync(join(tmpdir(), 'dbm-ui81-'))
  const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, ...extraEnv, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
  const win = await app.firstWindow()
  win.setDefaultTimeout(60000)
  await app.evaluate(({ BrowserWindow, screen }) => { const w = BrowserWindow.getAllWindows()[0]; const a = screen.getPrimaryDisplay().workArea; w.setBounds({ x: a.x + a.width - 24, y: a.y + 40, width: 1440, height: 900 }); w.blur() })
  try {
    await win.waitForTimeout(800)
    await win.keyboard.press('Meta+,')
    await win.getByRole('dialog').getByRole('button', { name: 'AI assistant' }).click()
    for (const provider of ['Codex CLI', 'Claude Code']) {
      await win.getByRole('dialog').getByRole('button', { name: new RegExp(provider) }).first().click()
      await win.getByRole('dialog').getByRole('button', { name: 'Test', exact: true }).click()
      const result = win.getByRole('dialog').getByText(/signed in|isn't signed in|not found/i).first()
      await result.waitFor({ timeout: 30000 })
      console.log(label, provider, '→', (await result.innerText()).replace(/\s+/g, ' '))
    }
  } catch (err) {
    await win.screenshot({ path: join(dir, 'flow81-fail.png') }).catch(() => {})
    console.log('screenshot', join(dir, 'flow81-fail.png'))
    throw err
  } finally {
    await app.close()
  }
}
await run('signed in:', {})
const empty = mkdtempSync(join(tmpdir(), 'dbm-noauth-'))
await run('signed out:', { CODEX_HOME: empty, CLAUDE_CONFIG_DIR: empty })

// One-click "Add to" MCP clients, against a throwaway home folder.
import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const home = mkdtempSync(join(tmpdir(), 'dbm-home-'))
mkdirSync(join(home, '.cursor'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: home, PATH: '/usr/bin:/bin', DBM_USER_DATA: join(home, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
try {
  await win.waitForTimeout(1000)
  await win.keyboard.press('Meta+,')
  await win.getByRole('button', { name: 'MCP server' }).click()
  await win.getByRole('button', { name: 'Cursor', exact: true }).click()
  await win.getByRole('button', { name: 'Codex', exact: true }).click()
  await win.waitForTimeout(800)
  await win.screenshot({ path: `${out}/r2-mcp-add.png` })
  console.log(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'))
  console.log(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'))
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

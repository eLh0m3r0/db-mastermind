// macOS self-update: run an installed bundle (an older version), let it download, verify and unpack the latest
// release, quit, and check the bundle was replaced. Usage: node e2e/mac-update-check.mjs "<path>/DB Mastermind.app" <latest>
import { _electron as electron } from '@playwright/test'
import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const [bundle, latest] = process.argv.slice(2)
const data = mkdtempSync(join(tmpdir(), 'dbm-macupd-'))
// Empty while the bundle is being swapped (it is moved aside for a moment).
const version = () => {
  try {
    return execSync(`defaults read "${bundle}/Contents/Info" CFBundleShortVersionString`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return ''
  }
}
console.log('installed:', version())
const app = await electron.launch({ executablePath: `${bundle}/Contents/MacOS/DB Mastermind`, env: { ...process.env, DBM_USER_DATA: data, DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const log = join(data, 'logs', 'updater.log')
let text = ''
for (let i = 0; i < 300 && !/downloaded|ERROR/.test(text); i++) {
  await new Promise((r) => setTimeout(r, 2000))
  text = existsSync(log) ? readFileSync(log, 'utf8') : ''
}
console.log(text.trim())
if (!/downloaded/.test(text)) throw new Error('The update was not downloaded')
await win.getByText('Restart now').first().waitFor({ timeout: 30000 })
await app.evaluate(({ app }) => app.quit()).catch(() => {})
for (let i = 0; i < 90 && version() !== latest; i++) await new Promise((r) => setTimeout(r, 2000))
console.log('after quitting:', version())
if (version() !== latest) throw new Error(`Expected ${latest} after quitting, found ${version()}`)
// The script removes the old bundle right after the swap.
for (let i = 0; i < 30 && (existsSync(`${bundle}.old`) || existsSync(`${bundle}.new`)); i++) await new Promise((r) => setTimeout(r, 1000))
if (existsSync(`${bundle}.old`) || existsSync(`${bundle}.new`)) throw new Error('A temporary bundle was left behind')
console.log(`Updated to ${latest}`)

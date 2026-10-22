import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const widths = (process.argv[3] ?? '1440').split(',').map(Number)
const dir = mkdtempSync(join(tmpdir(), 'dbm-tb-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: dir, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: process.env.LANG2 ?? 'en' } })
const win = await app.firstWindow()
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
try {
  await win.waitForTimeout(800)
  await api('saveConnection', { id: '', name: 'PG', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' })
  await win.reload(); await win.waitForTimeout(800)
  await win.getByText('PG', { exact: true }).first().dblclick()
  await win.getByPlaceholder(/Filter .+ tables/).waitFor()
  await win.keyboard.press(`${mod}+k`); await win.keyboard.type('Open ER diagram'); await win.keyboard.press('Enter')
  await win.locator('.react-flow__node').first().waitFor({ timeout: 30000 })
  await win.getByRole('button', { name: /^Design$/ }).first().click()
  await win.waitForTimeout(800)
  for (const w of widths) {
    await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setSize(w, 860), w)
    await win.waitForTimeout(600)
    await win.screenshot({ path: `${out}/tb-${w}.png` })
    const over = await win.evaluate(() => [...document.querySelectorAll('button')].filter((b) => b.offsetParent && b.getBoundingClientRect().right > window.innerWidth + 1).map((b) => b.textContent?.trim() || b.getAttribute('aria-label')))
    console.log(w, 'buttons past the right edge:', JSON.stringify(over))
  }
} finally { await app.close() }

// Update checks can be turned off: `node e2e/flow88.mjs <screenshot dir>`. Settings → General → Updates saves
// checkForUpdates; About names the author and links to the website. Czech UI.
import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'dbm-shots88-'))
const home = mkdtempSync(join(tmpdir(), 'dbm-ui88-'))
const data = join(home, 'data')
mkdirSync(data, { recursive: true })

const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: home, DBM_USER_DATA: data, DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'cs' }, timeout: 60_000 })
const win = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  w.setBounds({ x: -4000, y: 0, width: 1280, height: 800 })
  w.blur()
})
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
try {
  await win.waitForTimeout(1000)
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,')
  await win.waitForTimeout(600)
  const box = win.getByRole('checkbox', { name: 'Automaticky hledat nové verze' })
  check('update checkbox is on by default', await box.isChecked())
  check('the hint says nothing personal is sent', (await win.locator('[role=dialog]').innerText()).includes('Nic o vás ani o vašich databázích se neodesílá'))
  await win.screenshot({ path: join(out, '88-updates-setting.png') })
  await box.click()
  await win.waitForTimeout(500)
  const saved = JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8'))
  check('turning it off is saved', saved.checkForUpdates === false && !(await box.isChecked()), JSON.stringify(saved.checkForUpdates))
  await win.locator('[role=dialog] nav button', { hasText: 'O aplikaci' }).click()
  await win.waitForTimeout(400)
  let opened = ''
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url) => {
      globalThis.__opened = url
    }
  })
  await win.locator('[role=dialog]').getByRole('button', { name: 'Web', exact: true }).click()
  await win.waitForTimeout(300)
  opened = await app.evaluate(() => globalThis.__opened)
  check('About links to the website', opened === 'https://dbmastermind.app', opened)
  const about = await win.locator('[role=dialog]').innerText()
  check('About names the author', about.includes('Autor') && about.includes('Václav Mudra'))
  await win.locator('[role=dialog]').getByRole('button', { name: 'vaclavmudra.com' }).click()
  await win.waitForTimeout(300)
  opened = await app.evaluate(() => globalThis.__opened)
  check("author's website opens", opened === 'https://vaclavmudra.com', opened)
  await win.screenshot({ path: join(out, '88-about.png') })
} finally {
  console.log('page errors:', errors.length ? errors : 'none')
  await app.close()
}
if (results.includes(false)) process.exit(1)

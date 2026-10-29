// Command palette order: `node e2e/flow89.mjs <screenshot dir>`. Commands come first, then connections, then
// tables, with or without a search; Enter runs the first command; Czech labels match without diacritics.
import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'dbm-shots89-'))
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const errors = []

async function launch(language) {
  const home = mkdtempSync(join(tmpdir(), 'dbm-ui89-'))
  const data = join(home, 'data')
  mkdirSync(data, { recursive: true })
  const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: home, DBM_USER_DATA: data, DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: language }, timeout: 60_000 })
  const win = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setBounds({ x: -4000, y: 0, width: 1280, height: 800 })
    w.blur()
  })
  win.on('pageerror', (e) => errors.push(e.message))
  await win.waitForTimeout(1000)
  return { app, win }
}
const headings = (win) => win.locator('[cmdk-group-heading]').allInnerTexts()
const selected = (win) => win.locator('[cmdk-item][data-selected="true"]').innerText()

let { app, win } = await launch('en')
try {
  await win.getByRole('button', { name: 'Try the demo database' }).click()
  await win.getByPlaceholder(/Filter \d+ tables/).waitFor({ timeout: 20000 })
  await win.keyboard.press(`${mod}+k`)
  await win.waitForTimeout(300)
  check('empty search: commands, connections, tables', JSON.stringify(await headings(win)) === JSON.stringify(['COMMANDS', 'CONNECTIONS', 'TABLES']), JSON.stringify(await headings(win)))
  check('the first item is a command', (await selected(win)).includes('New query tab'), await selected(win))
  await win.keyboard.type('co')
  await win.waitForTimeout(300)
  check('"co" matches all three, still in that order', JSON.stringify(await headings(win)) === JSON.stringify(['COMMANDS', 'CONNECTIONS', 'TABLES']), JSON.stringify(await headings(win)))
  await win.screenshot({ path: join(out, '89-palette-order.png') })
  await win.keyboard.press(`${mod}+a`)
  await win.keyboard.type('diagram')
  await win.waitForTimeout(300)
  check('"diagram" selects the command, not a table', (await selected(win)).includes('Open ER diagram'), await selected(win))
  await win.keyboard.press('Enter')
  await win.locator('.react-flow__node').first().waitFor({ timeout: 20000 })
  check('Enter runs it', true)
  await win.keyboard.press(`${mod}+k`)
  await win.keyboard.type('order_it')
  await win.waitForTimeout(300)
  check('a table name still finds the table', (await selected(win)).includes('order_items'), await selected(win))
  await win.keyboard.press('Escape')
  await win.keyboard.press(`${mod}+p`)
  await win.keyboard.type('pay')
  await win.waitForTimeout(300)
  check('⌘P lists only tables', JSON.stringify(await headings(win)) === JSON.stringify(['TABLES']) && (await selected(win)).includes('payments'), JSON.stringify(await headings(win)))
  await win.keyboard.press('Escape')
} finally {
  await app.close()
}

;({ app, win } = await launch('cs'))
try {
  await win.keyboard.press(`${mod}+k`)
  await win.keyboard.type('nastaveni')
  await win.waitForTimeout(300)
  check('Czech label without diacritics', (await selected(win)).includes('Nastavení'), await selected(win))
  await win.screenshot({ path: join(out, '89-palette-cs.png') })
} finally {
  console.log('page errors:', errors.length ? errors : 'none')
  await app.close()
}
if (results.includes(false)) process.exit(1)

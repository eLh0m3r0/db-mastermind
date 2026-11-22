// Editor completions: PostgreSQL functions from pg_catalog (random() was missing), columns without a table prefix
// in PostgreSQL and SQLite (a column called id was never offered), COUNT offered once, as count().
// Needs postgres (npm run db:up) with the shop fixtures.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const out = process.argv[2] ?? tmpdir()
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui110-'))
const liteFile = join(dir, 'lite.db')
const lite = new DatabaseSync(liteFile)
lite.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT)')
lite.close()

const app = await electron.launch({
  args: ['apps/desktop'],
  env: { ...process.env, HOME: dir, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' },
})
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
let failed = 0
const check = (label, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) failed++
}

/** Types into a fresh editor and returns the completion labels (with their details) shown. */
async function complete(text) {
  const editor = win.locator('.cm-content:visible').first()
  await editor.click()
  await win.keyboard.press(`${mod}+a`)
  await win.keyboard.press('Backspace')
  await win.keyboard.type(text, { delay: 15 })
  const tip = win.locator('.cm-tooltip-autocomplete')
  await tip.waitFor({ timeout: 10000 }).catch(() => {})
  await win.waitForTimeout(300)
  return tip.locator('li').evaluateAll((lis) => lis.map((li) => li.querySelector('.cm-completionLabel')?.textContent ?? ''))
}

async function openConsole(name, switchFrom) {
  // Once a connection is open the sidebar shows its tree; others are picked from the switcher in its header.
  if (switchFrom) await win.getByText(switchFrom, { exact: true }).first().click()
  await win.getByText(name, { exact: true }).first().dblclick()
  await win.getByPlaceholder(/Filter .+ tables/).waitFor({ timeout: 30000 })
  await win.keyboard.press(`${mod}+t`)
  await win.locator('.cm-content:visible').first().waitFor()
  // The schema snapshot arrives after the tab opens.
  await win.waitForTimeout(1500)
}

try {
  await win.waitForTimeout(800)
  // The PostgreSQL form's default schema (search_path) field.
  await win.getByRole('button', { name: 'New connection' }).first().click()
  await win.waitForTimeout(500)
  await win.getByRole('button', { name: 'PostgreSQL', exact: true }).click()
  await win.getByRole('button', { name: 'Advanced', exact: true }).click()
  await win.getByTestId('pg-search-path').fill('shop, public')
  await win.screenshot({ path: `${out}/r110-search-path.png` })
  check('search_path field in Advanced', (await win.getByTestId('pg-search-path').inputValue()) === 'shop, public')
  await win.keyboard.press('Escape')

  // (On the demo database: no server needed for this part.)
  await api('createSampleDatabase')
  await win.reload()
  await win.waitForTimeout(1000)
  await openConsole('Demo coffee shop')
  // Enter accepts the highlighted suggestion the moment the list shows, at machine and at human typing speed (it
  // used to insert a line break for a moment after the list appeared: CodeMirror's interaction delay).
  for (const [speed, delay, pause] of [['machine', 0, 0], ['human', 110, 180]]) {
    const ed = win.locator('.cm-content:visible').first()
    await ed.click()
    await win.keyboard.press(`${mod}+a`)
    await win.keyboard.press('Backspace')
    await win.keyboard.type('select * from orders o join ', { delay })
    await win.locator('.cm-tooltip-autocomplete li[aria-selected="true"]').waitFor({ timeout: 10000 }).catch(() => {})
    if (pause) await win.waitForTimeout(pause)
    const highlighted = await win.locator('.cm-tooltip-autocomplete li[aria-selected="true"] .cm-completionLabel').textContent().catch(() => '')
    await win.keyboard.press('Enter')
    await win.waitForTimeout(200)
    const text = await ed.innerText()
    check(`${speed} speed: Enter takes the highlighted "${highlighted}" (${JSON.stringify(text)})`, !!highlighted && !text.includes('\n') && text.includes(highlighted.split(' ')[0]))
  }
  // The instant the list appears (CodeMirror ignored Enter for its first 75 ms and the line broke instead).
  {
    const ed = win.locator('.cm-content:visible').first()
    await ed.click()
    await win.keyboard.press(`${mod}+a`)
    await win.keyboard.press('Backspace')
    await win.evaluate(() => {
      const observer = new MutationObserver(() => {
        if (!document.querySelector('.cm-tooltip-autocomplete li[aria-selected="true"]')) return
        observer.disconnect()
        const content = [...document.querySelectorAll('.cm-content')].find((c) => c.offsetWidth > 0)
        content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }))
      })
      observer.observe(document.body, { subtree: true, childList: true, attributes: true })
    })
    await win.keyboard.type('select * from orders o join ', { delay: 0 })
    await win.waitForTimeout(600)
    const text = await ed.innerText()
    check(`Enter the instant the list shows takes the suggestion: ${JSON.stringify(text)}`, !text.includes('\n') && /join \w/.test(text))
  }
  // Tab accepts too; with no list, Enter is a new line.
  {
    const ed = win.locator('.cm-content:visible').first()
    await ed.click()
    await win.keyboard.press(`${mod}+a`)
    await win.keyboard.press('Backspace')
    await win.keyboard.type('select * from custo', { delay: 0 })
    await win.locator('.cm-tooltip-autocomplete li[aria-selected="true"]').waitFor({ timeout: 10000 }).catch(() => {})
    const highlighted = await win.locator('.cm-tooltip-autocomplete li[aria-selected="true"] .cm-completionLabel').textContent().catch(() => '')
    await win.keyboard.press('Tab')
    await win.waitForTimeout(200)
    check(`Tab takes the highlighted "${highlighted}": ${JSON.stringify(await ed.innerText())}`, !!highlighted && (await ed.innerText()).trim() === `select * from ${highlighted}`)
    await win.keyboard.press('Escape')
    const listShown = await win.locator('.cm-tooltip-autocomplete').count()
    await win.keyboard.press('Enter')
    await win.waitForTimeout(150)
    check(`with no list (${listShown} shown), Enter is a new line`, listShown === 0 && (await ed.locator('.cm-line').count()) === 2)
  }

  await api('saveConnection', { id: '', name: 'Shop PG', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind', options: { searchPath: 'shop' } })
  await api('saveConnection', { id: '', name: 'Lite', driver: 'sqlite', filePath: liteFile })
  await win.reload()
  await win.waitForTimeout(1000)

  // The demo database from the part above is still the open one: Shop PG is picked from the switcher.
  await openConsole('Shop PG', 'Demo coffee shop')
  // With search_path shop, its tables need no schema.
  let labels = await complete('select * from custo')
  check(`default schema's tables unqualified: ${labels.slice(0, 3).join(', ')}`, labels[0] === 'customers')
  await win.keyboard.press('Escape')
  labels = await complete('select * from shop.customers order by rand')
  check(`"order by rand" offers random: ${labels.slice(0, 5).join(', ')}`, labels[0] === 'random')
  await win.screenshot({ path: `${out}/r110-random.png` })
  await win.keyboard.press('Enter')
  const doc = await win.locator('.cm-content:visible').first().innerText()
  check(`random applied as a call: ${JSON.stringify(doc)}`, doc.trim().endsWith('random()'))

  labels = await complete('select * from shop.customers c where em')
  check(`unqualified column "em" → email: ${labels.slice(0, 5).join(', ')}`, labels[0] === 'email')
  // A column typed before the FROM that names its table.
  await win.keyboard.press('Escape')
  const editor = win.locator('.cm-content:visible').first()
  await editor.click()
  await win.keyboard.press(`${mod}+a`)
  await win.keyboard.press('Backspace')
  await win.keyboard.type('select  from shop.customers', { delay: 10 })
  for (let i = 0; i < ' from shop.customers'.length; i++) await win.keyboard.press('ArrowLeft')
  await win.keyboard.type('na', { delay: 30 })
  await win.locator('.cm-tooltip-autocomplete').waitFor({ timeout: 10000 }).catch(() => {})
  labels = await win.locator('.cm-tooltip-autocomplete li .cm-completionLabel').allTextContents()
  check(`column before FROM: ${labels.slice(0, 5).join(', ')}`, labels[0] === 'name')

  labels = await complete('select coun')
  check(`count offered once: ${labels.filter((l) => l.toLowerCase() === 'count').join(', ')}`, labels.filter((l) => l.toLowerCase() === 'count').length === 1)
  labels = await complete('select * from shop.customers left')
  const firstIcon = await win.locator('.cm-tooltip-autocomplete li').first().locator('.cm-completionIcon').getAttribute('class')
  check(`"left" in lowercase SQL: the keyword comes first (${labels.slice(0, 3).join(', ')}; ${firstIcon})`, labels[0] === 'left' && /keyword/.test(firstIcon ?? ''))
  labels = await complete('SELECT * FROM shop.customers ORD')
  check(`upper-case typing keeps upper-case keywords: ${labels.slice(0, 3).join(', ')}`, labels.includes('ORDER') && !labels.includes('order'))
  await win.keyboard.press('Escape')

  // RAISE NOTICE shows in Messages, with a count on the tab even when a result grid is in front.
  await complete("DO $$BEGIN RAISE NOTICE 'hello from plpgsql'; END$$; SELECT 1 AS one")
  await win.keyboard.press('Escape')
  await win.keyboard.press(`Shift+${mod}+Enter`)
  await win.locator('[data-server-messages]').waitFor({ timeout: 10000 }).catch(() => {})
  check(`message count on the Messages tab: ${await win.locator('[data-server-messages]').textContent().catch(() => 'none')}`, (await win.locator('[data-server-messages]').textContent().catch(() => '')) === '1')
  await win.getByRole('button', { name: /^Messages/ }).click()
  const shown = await win.locator('[data-server-message]').allTextContents()
  check(`notice shown: ${JSON.stringify(shown)}`, shown[0] === 'NOTICE: hello from plpgsql')
  await win.screenshot({ path: `${out}/r110-notice.png` })

  await openConsole('Lite', 'Shop PG')
  labels = await complete('select * from items where i')
  check(`SQLite: "where i" → id: ${labels.slice(0, 5).join(', ')}`, labels[0] === 'id')
  await win.screenshot({ path: `${out}/r110-sqlite.png` })
  labels = await complete('select rand')
  check(`SQLite functions: ${labels.slice(0, 3).join(', ')}`, labels.includes('random'))

  check(`no page errors ${errors.join(' | ')}`, errors.length === 0)
} finally {
  await app.close()
}
if (failed) {
  console.log(`${failed} check(s) failed`)
  process.exit(1)
}
console.log('flow110 passed')

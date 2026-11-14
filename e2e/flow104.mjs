// The editor of Milestone 11 (A3–A5): an unknown table is underlined with a one-click fix, a wrong alias.column and
// an UPDATE without WHERE too, a valid query gets no mark; ⌘-click on a table opens its structure, whose "Used by"
// lists a saved query; the plan after adding an index is compared with the one before. Needs `npm run db:up`
// (postgres) and the shop fixtures; drops the index it adds.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'

const out = process.argv[2] ?? tmpdir()
const admin = new pg.Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' })
await admin.connect()
await admin.query('DROP INDEX IF EXISTS shop.flow104_total_idx')

const dir = mkdtempSync(join(tmpdir(), 'dbm-ui104-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const check = (label, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) process.exitCode = 1
}
const editor = () => win.locator('.cm-content:visible').first()
const type = async (sql) => {
  await editor().click()
  await win.keyboard.press('ControlOrMeta+a')
  await win.keyboard.insertText(sql)
  await win.waitForTimeout(900)
}
const marks = () => win.locator('.cm-lintRange-warning').count()
try {
  await win.waitForTimeout(800)
  const { id } = await api('saveConnection', { id: '', name: 'Lint PG', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' })
  await api('saveQuery', { name: 'VIP report', sql: 'SELECT c.name FROM shop.customers c WHERE c.vip', connectionId: id })
  await win.reload()
  await win.getByText('Lint PG', { exact: true }).first().dblclick()
  await editor().waitFor({ timeout: 15000 })
  await win.waitForTimeout(1500)

  await type('SELECT * FROM shop.custmers')
  check('an unknown table is underlined', (await marks()) === 1)
  await win.locator('.cm-lintRange-warning').first().hover()
  await win.getByText('Unknown table “shop.custmers”. Did you mean “customers”?').waitFor({ timeout: 5000 })
  await win.screenshot({ path: `${out}/r104-lint.png` })
  await win.getByRole('button', { name: 'Use customers' }).click()
  await win.waitForTimeout(900)
  check('the fix puts in the right name and the mark goes', (await editor().innerText()).includes('shop.customers') && (await marks()) === 0)

  await type('SELECT o.totl FROM shop.orders o')
  check('alias.column the table lacks is underlined', (await marks()) === 1)
  await type('UPDATE shop.orders SET status = status')
  check('UPDATE without WHERE is underlined', (await marks()) === 1)
  await type("WITH paid AS (SELECT * FROM shop.orders WHERE status = 'paid') SELECT c.name, sum(p.total) FROM paid p JOIN shop.customers c ON c.id = p.customer_id GROUP BY c.name")
  check('a valid query gets no mark', (await marks()) === 0)

  // ⌘-click on the table name opens its structure; "Used by" lists the saved query.
  await type('SELECT * FROM shop.customers')
  // Where the word "customers" is drawn (the line element spans the whole editor width).
  const box = await win.evaluate(() => {
    const content = [...document.querySelectorAll('.cm-content')].find((el) => el.offsetParent !== null)
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent.indexOf('customers')
      if (at === -1) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + 'customers'.length)
      const r = range.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    }
    return null
  })
  await win.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control')
  await win.mouse.move(box.x + 10, box.y + box.height / 2)
  await win.waitForTimeout(200)
  check('holding ⌘ underlines the table name as a link', (await win.locator('.cm-object-link').count()) === 1)
  await win.mouse.click(box.x + 10, box.y + box.height / 2)
  await win.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control')
  await win.getByTestId('used-by').waitFor({ timeout: 10000 })
  check('⌘-click opens the structure of the table', (await win.getByRole('tab').filter({ hasText: 'customers · structure' }).count()) === 1)
  check('Used by lists the saved query and the view', /VIP report/.test(await win.getByTestId('used-by').innerText()) && /vip_customers/.test(await win.getByTestId('used-by').innerText()))
  await win.screenshot({ path: `${out}/r104-used-by.png` })

  // Plans before and after an index.
  await win.getByRole('tab').filter({ hasText: 'Query 1' }).click()
  await type('SELECT * FROM shop.orders WHERE total = 105')
  const explain = async () => {
    await win.getByRole('button', { name: 'Explain' }).click()
    await win.getByText('Explain (estimate)', { exact: true }).click()
    await win.getByText('Execution plan').waitFor({ timeout: 10000 })
    await win.waitForTimeout(500)
  }
  await explain()
  check('the first plan has nothing to compare with', (await win.getByTestId('plan-compare').count()) === 0)
  await admin.query('CREATE INDEX flow104_total_idx ON shop.orders (total)')
  await admin.query('ANALYZE shop.orders')
  await admin.query('SET enable_seqscan = off')
  await explain()
  await win.getByTestId('plan-compare').click()
  const changeText = await win.getByTestId('plan-change').innerText()
  check('the comparison shows the cost before and the change', /before/.test(changeText) && /%/.test(changeText))
  await win.screenshot({ path: `${out}/r104-plan-compare.png` })
  check('no page errors', errors.length === 0)
  if (errors.length) console.log(errors)
} catch (err) {
  console.log('FAIL', err)
  await win.screenshot({ path: `${out}/r104-failure.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await admin.query('DROP INDEX IF EXISTS shop.flow104_total_idx').catch(() => {})
  await admin.end()
  await app.close()
}

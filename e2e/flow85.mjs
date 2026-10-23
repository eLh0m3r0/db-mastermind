// Searching saved AI chats: `node e2e/flow85.mjs <screenshot dir>`. Typing in the chat history filters by message
// text and SQL (no diacritics needed) and shows where it matched; Enter opens the first hit, Escape clears.
import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'dbm-shots85-'))
const home = mkdtempSync(join(tmpdir(), 'dbm-ui85-'))
const data = join(home, 'data')
mkdirSync(data, { recursive: true })
const file = join(home, 'shop.db')
const db = new DatabaseSync(file)
db.exec('CREATE TABLE invoices (id integer primary key, total real)')
db.close()
const now = new Date().toISOString()
writeFileSync(join(data, 'connections.json'), JSON.stringify([{ id: 'shop', name: 'Shop', driver: 'sqlite', filePath: file, createdAt: now, updatedAt: now }]))
writeFileSync(join(data, 'settings.json'), JSON.stringify({ language: 'cs', ai: { activeProvider: 'ollama', providers: [{ id: 'ollama', enabled: true, model: 'llama3' }] } }))
const text = (t) => ({ type: 'text', text: t })
const chat = (id, title, day, messages) => ({ id, connectionId: 'shop', title, updatedAt: `2026-10-${day}T10:00:00Z`, messages })
writeFileSync(
  join(data, 'ai-chats.json'),
  JSON.stringify({
    chats: [
      chat('a', 'Tržby', 20, [
        { id: 'm1', role: 'user', parts: [text('Jaký byl příjem za září?')] },
        { id: 'm2', role: 'assistant', parts: [{ type: 'tool', id: 't1', name: 'run_query', input: { sql: 'SELECT sum(total) FROM invoices' }, output: '120000' }, text('Příjem za září byl 120 000 Kč.')] },
      ]),
      chat('b', 'Zákazníci', 21, [{ id: 'm3', role: 'user', parts: [text('Kteří zákazníci objednali dvakrát?')] }]),
      chat('c', 'Indexy', 22, [{ id: 'm4', role: 'user', parts: [text('Které indexy chybí?')] }]),
    ],
  }),
)

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
  await win.getByText('Shop', { exact: true }).first().click()
  await win.waitForTimeout(1200)
  await win.evaluate(() => window.mastermind.api.listAiChats('shop')) // warm up
  await win.getByRole('button', { name: /^AI$/ }).last().click()
  await win.waitForTimeout(600)
  await win.getByRole('button', { name: 'Historie chatů' }).click()
  await win.waitForTimeout(500)
  const search = win.getByPlaceholder('Hledat v chatech…')
  check('search box is focused', await search.evaluate((el) => el === document.activeElement))
  const titles = () => win.locator('button:has(svg.lucide-message-square) .truncate').allInnerTexts()
  check('all chats listed, newest first', JSON.stringify(await titles()) === JSON.stringify(['Indexy', 'Zákazníci', 'Tržby']), JSON.stringify(await titles()))
  await search.fill('prijem zari')
  await win.waitForTimeout(500)
  check('words without diacritics find the chat', JSON.stringify(await titles()) === JSON.stringify(['Tržby']), JSON.stringify(await titles()))
  const body = await win.locator('body').innerText()
  check('the match is shown', body.includes('Jaký byl příjem za září?'))
  await win.screenshot({ path: join(out, '85-chat-search.png') })
  await search.fill('invoices')
  await win.waitForTimeout(500)
  check('SQL the assistant ran is searched too', JSON.stringify(await titles()) === JSON.stringify(['Tržby']))
  await search.fill('kafe')
  await win.waitForTimeout(500)
  check('no match says so', (await win.locator('body').innerText()).includes('Žádný chat neobsahuje „kafe“'))
  await win.screenshot({ path: join(out, '85-chat-search-none.png') })
  await search.press('Escape')
  await win.waitForTimeout(400)
  check('Escape clears the search', (await search.inputValue()) === '' && (await titles()).length === 3)
  await search.fill('zakaznici')
  await win.waitForTimeout(500)
  await search.press('Enter')
  await win.waitForTimeout(600)
  check('Enter opens the first hit', (await win.locator('body').innerText()).includes('Kteří zákazníci objednali dvakrát?'))
  await win.screenshot({ path: join(out, '85-chat-opened.png') })
} finally {
  console.log('page errors:', errors.length ? errors : 'none')
  await app.close()
}
if (results.includes(false)) process.exit(1)

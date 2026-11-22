// AI on a model with no database anywhere (the owner's 1.5.0 report: the panel said "Connect to a database to chat
// about it."). A fresh profile with a local AI provider and no connection: New model, Design with AI → Review the
// model answers, its ```dbml block applies to the model, ⌘J and a follow-up keep the model's chat (with the model as
// it is now), the chat is in the history. The provider gets no tools and nothing but the model.
// `node e2e/flow118.mjs <screenshot dir>`
import { _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? tmpdir()
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui118-'))
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` (${detail})`}`)
  if (!ok) process.exitCode = 1
}

// An OpenAI-compatible server that answers with a changed model.
const bodies = []
const REPLY = 'The email should be unique.\n\n```dbml\nTable customers {\n  id int [pk]\n  email varchar [unique]\n  created_at timestamp\n}\n```'
const fake = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }))
    const json = JSON.parse(body || '{}')
    bodies.push(json)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    res.write(chunk({ role: 'assistant', content: bodies.length === 1 ? REPLY : 'Noted.' }, null))
    res.write(chunk({}, 'stop'))
    res.end('data: [DONE]\n\n')
  })
})
await new Promise((r) => fake.listen(0, '127.0.0.1', r))
const fakeUrl = `http://127.0.0.1:${fake.address().port}/v1`

const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const menu = (command) => app.evaluate(({ BrowserWindow }, command) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', command), command)
const panel = () => win.locator('textarea[placeholder]').last()
const modelText = () => win.evaluate(() => [...document.querySelectorAll('.cm-content')].filter((c) => c.offsetParent).map((c) => c.innerText).join('\n'))
const systemOf = (body) => (body.messages ?? []).filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')

try {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await win.waitForTimeout(800)
  check('a fresh profile: no connection at all', (await api('listConnections')).length === 0)
  const settings = await api('getSettings')
  await api('updateSettings', { ai: { ...settings.ai, providers: [{ id: 'openai-compatible', enabled: true, baseUrl: fakeUrl, model: 'fake-model' }], activeProvider: 'openai-compatible' } })
  await win.reload()
  await win.waitForTimeout(1200)

  // A new model with one table, typed in its text.
  await menu('new-model')
  await win.waitForTimeout(800)
  const editor = win.locator('.cm-content:visible').first()
  await editor.click()
  await win.keyboard.press('ControlOrMeta+a')
  await win.keyboard.insertText('Table customers {\n  id int [pk]\n  email varchar\n}\n')
  await win.waitForTimeout(600)

  // Design with AI → Review the model: it is sent at once and answered.
  await win.getByRole('button', { name: 'Design with AI' }).click()
  await win.getByRole('menuitem', { name: 'Review the model' }).click()
  await win.getByRole('button', { name: 'Apply to model' }).waitFor({ timeout: 20000 }).catch(() => {})
  const body = await win.locator('body').innerText()
  await win.screenshot({ path: join(out, 'r118-model-chat.png') })
  check('the panel does not ask for a database', !body.includes('Connect to a database to chat about it.'))
  check('Review the model is answered', body.includes('The email should be unique.'), body.slice(-600))
  check('the provider got the model and no tools', bodies.length === 1 && !bodies[0].tools && JSON.stringify(bodies[0].messages).includes('email varchar'), JSON.stringify(bodies[0] ?? {}).slice(0, 300))
  check('…and was told no database is connected', /no database is connected and you have no tools/.test(systemOf(bodies[0] ?? {})))

  // Apply to model puts the answer's model into the tab.
  await win.getByRole('button', { name: 'Apply to model' }).click()
  await win.waitForTimeout(800)
  const applied = await modelText()
  check('Apply to model changes the model', applied.includes('created_at timestamp') && applied.includes('[unique]'), applied.slice(0, 300))

  // ⌘J closes and opens the panel on the same model chat; a follow-up carries the model as it is now.
  await menu('toggle-ai')
  await menu('toggle-ai')
  await win.waitForTimeout(400)
  check('the model chat is still there after ⌘J', (await win.getByText('The email should be unique.').count()) > 0)
  check('the box asks about the model', (await panel().getAttribute('placeholder')) === 'What should change in the model?')
  await panel().fill('Thanks, anything else?')
  await panel().press('Enter')
  await win.getByText('Noted.').waitFor({ timeout: 20000 }).catch(() => {})
  check('a follow-up is answered in the model chat', (await win.getByText('Noted.').count()) > 0)
  check('…with the model as it is now (the applied change)', bodies.length === 2 && systemOf(bodies[1]).includes('created_at timestamp') && !bodies[1].tools)

  // A new chat names the model; the chat about it is in the history and found by its text.
  await win.getByRole('button', { name: 'New chat' }).click()
  await win.waitForTimeout(400)
  const intro = await win.locator('body').innerText()
  check('a new model chat says what it is about', intro.includes('The assistant sees only the text of the model, no database.'), intro.slice(-400))
  await win.waitForTimeout(1500)
  await win.getByRole('button', { name: 'Chat history' }).click()
  await win.waitForTimeout(600)
  const history = await win.locator('body').innerText()
  await win.screenshot({ path: join(out, 'r118-model-history.png') })
  check('the model chat is in the history', /Review this database model/.test(history), history.slice(-500))

  // Design or extend the model… leaves the box asking about the model, ready to type.
  await win.getByRole('button', { name: 'Chat history' }).click()
  await win.getByRole('button', { name: 'Design with AI' }).click()
  await win.getByRole('menuitem', { name: 'Design or extend the model…' }).click()
  await win.waitForTimeout(500)
  check('Design or extend the model… asks what should change', (await panel().getAttribute('placeholder')) === 'What should change in the model?' && !(await win.getByText('Connect to a database to chat about it.').count()))
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: join(out, 'r118-error.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  console.log('page errors:', errors.length ? errors.slice(0, 3).join(' | ') : 'none')
  // The model is unsaved: quitting asks, and the flow discards it.
  const closing = app.close()
  await win.getByRole('button', { name: 'Discard changes' }).click({ timeout: 3000 }).catch(() => {})
  await closing
  fake.close()
  rmSync(dir, { recursive: true, force: true })
}

// First run and connecting (launch UX review): the demo opens on its data; a connection that fails says what
// happened (nothing listening, unknown host, wrong password: the last needs `npm run db:up` postgres and is skipped
// without it); toasts never cover a dialog's buttons and the same notice twice is one toast; a table with unsaved
// edits is marked in the tab strip and closing it asks Save / Discard / Cancel; AI set up with a key-less local
// provider is in use without "Use this provider" and answers (a fake OpenAI-compatible server started here: no key,
// no network); a wrong address is explained with an Open AI settings action.
import { _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? tmpdir()
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui117-'))

// A minimal OpenAI-compatible server: a reply as one chunk (streamed) or one message.
const requests = []
const fake = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    requests.push(req.url)
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }))
    const json = JSON.parse(body || '{}')
    const text = 'The demo has 7 tables.'
    if (json.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      res.write(chunk({ role: 'assistant', content: text }, null))
      res.write(chunk({}, 'stop'))
      res.end('data: [DONE]\n\n')
    } else {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', created: 1, model: 'fake-model', choices: [{ index: 0, message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    }
  })
})
await new Promise((r) => fake.listen(0, '127.0.0.1', r))
const fakeUrl = `http://127.0.0.1:${fake.address().port}/v1`

const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` (${detail})`}`)
  if (!ok) process.exitCode = 1
}
const menu = (command) => app.evaluate(({ BrowserWindow }, command) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', command), command)
const reachable = (port) => new Promise((resolve) => {
  const s = connect(port, '127.0.0.1')
  s.once('connect', () => (s.destroy(), resolve(true)))
  s.once('error', () => resolve(false))
})
const dialog = () => win.getByRole('dialog').last()
const connectionError = () => win.getByTestId('connection-error').innerText().catch(() => '')
const testWith = async (url) => {
  const field = dialog().locator('input').first()
  await field.fill(url)
  await field.press('Enter')
  await dialog().getByRole('button', { name: 'Test connection' }).click()
  await win.getByTestId('connection-error').waitFor({ timeout: 20000 }).catch(() => {})
  await win.waitForTimeout(300)
  return connectionError()
}

try {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800))
  await win.waitForTimeout(1000)

  // The demo opens on rows.
  await win.getByRole('button', { name: 'Try the demo database' }).click()
  await win.locator('[role="gridcell"]').first().waitFor({ timeout: 15000 })
  const tab = await win.locator('[role="tab"][aria-selected="true"]').innerText()
  check('the demo opens on the orders table, with rows', tab.trim() === 'orders' && (await win.locator('[role="gridcell"]').count()) > 20, tab)
  await win.screenshot({ path: join(out, 'r117-demo.png') })

  // A connection that fails says what happened and what to do, with the driver's words under it.
  await menu('new-connection')
  await dialog().waitFor()
  let text = await testWith('postgres://postgres:x@127.0.0.1:1/db')
  check('nothing listening: explained', text.includes('Nothing is listening on 127.0.0.1:1') && text.includes('ECONNREFUSED'), text)
  text = await testWith('postgres://postgres:x@db.invalid-host-xyz.example:5432/db')
  check('unknown host: explained', text.includes('The host name db.invalid-host-xyz.example can’t be found') && text.includes('ENOTFOUND'), text)
  if (await reachable(54329)) {
    text = await testWith('postgres://postgres:wrong@127.0.0.1:54329/mastermind')
    check('wrong password: explained', text.includes('The server rejected the user name or password.') && text.includes('password authentication failed'), text)
  } else console.log('skip wrong password: no PostgreSQL on 54329 (npm run db:up)')
  const errorInSight = await win.evaluate(() => {
    const e = document.querySelector('[data-testid="connection-error"]')?.getBoundingClientRect()
    const footer = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.innerText === 'Test connection')?.getBoundingClientRect()
    return !!e && !!footer && e.height > 0 && e.top >= 0 && e.bottom <= footer.top
  })
  check('the explanation is in sight above the buttons (the fields scroll, it doesn’t)', errorInSight)
  await win.screenshot({ path: join(out, 'r117-connection-error.png') })

  // Toasts while a dialog is open: at the top, never over its buttons; the same notice twice is one toast.
  const field = dialog().locator('input').first()
  for (let i = 0; i < 2; i++) {
    await field.fill('postgres://u@h.example:5432/db')
    await field.press('Enter')
    await win.waitForTimeout(250)
  }
  const placed = await win.evaluate(() => {
    const toasts = [...document.querySelectorAll('[data-testid="toasts"] [role="status"]')].map((t) => t.getBoundingClientRect())
    const buttons = [...document.querySelectorAll('[role="dialog"] button')].filter((b) => /Test connection|Save|Save & connect/.test(b.innerText)).map((b) => b.getBoundingClientRect())
    const overlaps = toasts.some((t) => buttons.some((b) => t.left < b.right && t.right > b.left && t.top < b.bottom && t.bottom > b.top))
    return { count: toasts.length, overlaps, placement: document.querySelector('[data-testid="toasts"]')?.dataset.placement, text: document.querySelector('[data-testid="toasts"]')?.innerText }
  })
  check('toasts over a dialog are at the top and cover none of its buttons', placed.placement === 'top' && !placed.overlaps, JSON.stringify(placed))
  // (The tests above pasted URLs too: the count includes those still showing.)
  check('the same notice again is one toast with a count', placed.count === 1 && /×[2-9]/.test(placed.text), JSON.stringify(placed))
  await win.screenshot({ path: join(out, 'r117-toast-over-dialog.png') })
  await win.keyboard.press('Escape')
  await win.waitForTimeout(300)

  // Unsaved edits: the tab is marked; closing asks Save / Discard / Cancel.
  const cell = win.locator('[role="gridcell"]').nth(6) // orders row 1: status
  await cell.dblclick()
  await win.keyboard.press('Meta+a')
  await win.keyboard.type('shipped-e2e')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(400)
  check('a table with unsaved edits is marked in the tab strip', await win.locator('[role="tab"][aria-selected="true"] [data-testid="tab-unsaved"]').count() === 1)
  await win.keyboard.press('Meta+w')
  await dialog().waitFor()
  const buttons = await dialog().locator('button').allInnerTexts()
  check('closing asks Save / Discard / Cancel', ['Save', 'Discard', 'Cancel'].every((b) => buttons.some((x) => x.trim() === b)), JSON.stringify(buttons))
  check('…with a body that says what is unsaved', (await dialog().innerText()).includes('1 change isn’t in the database yet.'))
  await win.screenshot({ path: join(out, 'r117-save-discard-cancel.png') })
  await dialog().getByRole('button', { name: 'Cancel' }).click()
  await win.waitForTimeout(300)
  check('Cancel keeps the tab and its edit', (await win.locator('[role="tab"]').allInnerTexts()).some((x) => x.trim() === 'orders'))
  await win.keyboard.press('Meta+w')
  await dialog().getByRole('button', { name: 'Save', exact: true }).click()
  await win.waitForTimeout(1200)
  check('Save saves and closes the tab', !(await win.locator('[role="tab"]').allInnerTexts()).some((x) => x.trim() === 'orders'))
  await win.locator('[data-node="table"]:visible', { hasText: /^orders$/ }).first().click()
  await win.locator('[role="gridcell"]').first().waitFor()
  await win.waitForTimeout(500)
  check('…and the value is in the database', (await win.locator('[role="gridcell"]').nth(6).innerText()).includes('shipped-e2e'))

  // AI: a local provider set up and closed, without "Use this provider", is in use and answers.
  await menu('toggle-ai')
  await win.getByRole('button', { name: 'Set up AI' }).click()
  await dialog().locator('button', { hasText: 'OpenAI-compatible' }).click()
  await dialog().locator('input[placeholder*="http"]').fill(fakeUrl)
  await dialog().locator('input[list^="models-"]').fill('fake-model')
  await win.waitForTimeout(400)
  await win.keyboard.press('Escape')
  await win.waitForTimeout(500)
  check('AI is ready without "Use this provider"', (await win.locator('textarea[placeholder^="Ask about"]').count()) === 1 && !(await win.getByText('Connect an AI model').count()))
  await win.locator('textarea[placeholder^="Ask about"]').fill('How many tables are there?')
  await win.locator('textarea[placeholder^="Ask about"]').press('Enter')
  await win.getByText('The demo has 7 tables.').waitFor({ timeout: 20000 }).catch(() => {})
  check('the assistant answers through the local provider', await win.getByText('The demo has 7 tables.').count() > 0, requests.join(' '))
  await win.screenshot({ path: join(out, 'r117-ai-ready.png') })

  // A wrong address: explained, with Open AI settings.
  fake.close()
  await win.locator('textarea[placeholder^="Ask about"]').fill('And how many views?')
  await win.locator('textarea[placeholder^="Ask about"]').press('Enter')
  await win.getByTestId('ai-chat-error').waitFor({ timeout: 30000 }).catch(() => {})
  const chatError = await win.getByTestId('ai-chat-error').innerText().catch(() => '')
  check('a server that stopped: "Can’t reach …" with Open AI settings', chatError.includes(`Can’t reach 127.0.0.1:${new URL(fakeUrl).port}`) && chatError.includes('Open AI settings'), chatError)
  await win.screenshot({ path: join(out, 'r117-ai-unreachable.png') })
  console.log(errors.length ? `page errors: ${errors.join(' | ')}` : 'page errors: none')
} finally {
  fake.close()
  await app.close()
}

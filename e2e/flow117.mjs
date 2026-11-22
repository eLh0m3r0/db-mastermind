// First run and connecting (launch UX review): the demo opens on its data; a connection that fails says what
// happened (nothing listening, unknown host, wrong password: the last needs `npm run db:up` postgres and is skipped
// without it); toasts never cover a dialog's buttons and the same notice twice is one toast; a table with unsaved
// edits is marked in the tab strip and closing it asks Save / Discard / Cancel; AI set up with a key-less local
// provider is in use without "Use this provider" and answers (a fake OpenAI-compatible server started here: no key,
// no network); a wrong address is explained with an Open AI settings action.
import { _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
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
/** Whether a field's placeholder fits in it (measured with its own font). */
const placeholderFits = (selector) =>
  win.evaluate((selector) => {
    const i = [...document.querySelectorAll(selector)].find((x) => x.offsetWidth > 0)
    if (!i) return { found: false }
    const cs = getComputedStyle(i)
    const c = document.createElement('canvas').getContext('2d')
    c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    const need = Math.ceil(c.measureText(i.placeholder).width + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight))
    return { found: true, fits: need <= i.clientWidth, need, width: i.clientWidth, placeholder: i.placeholder }
  }, selector)
const size = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h])
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

  // The start page on a fresh profile: the demo is a real button next to New connection, the drop of a project file
  // is mentioned, the model formats are listed; nothing is cut, and at laptop size the page needs no scrolling.
  const startPage = () =>
    win.evaluate(() => {
      const cards = [...document.querySelectorAll('section')].filter((s) => s.offsetWidth > 0)
      const buttons = cards.flatMap((c) => [...c.querySelectorAll('button')].filter((b) => !b.closest('ul') && b.offsetWidth > 0 && b.textContent.trim() && !b.className.includes('border-line px-2.5')))
      const box = (e) => e.getBoundingClientRect()
      const first = buttons[0]
      const demo = document.querySelector('[data-testid="home-demo"]')
      const scroller = cards[0]?.closest('.overflow-auto')
      return {
        columns: getComputedStyle(cards[0].parentElement).gridTemplateColumns.split(' ').length,
        demoBeside: !!demo && Math.abs(box(demo).top - box(first).top) < 2 && box(demo).height === box(first).height,
        demoOutlined: !!demo && getComputedStyle(demo).borderTopColor !== getComputedStyle(demo).backgroundColor && getComputedStyle(demo).borderTopWidth !== '0px' && !demo.className.includes('border-transparent'),
        cut: buttons.filter((b) => b.scrollWidth > b.clientWidth + 1 || box(b).height > box(first).height + 1).map((b) => b.textContent.trim()),
        scrolls: scroller ? scroller.scrollHeight > scroller.clientHeight + 1 : true,
        text: cards.map((c) => c.innerText).join('\n'),
      }
    })
  for (const lang of ['en', 'cs']) {
    await win.evaluate((language) => window.mastermind.api.updateSettings({ language }), lang)
    await win.reload()
    await win.waitForTimeout(1200)
    for (const [w, h] of [[1280, 800], [900, 560]]) {
      await size(w, h)
      await win.waitForTimeout(500)
      const p = await startPage()
      await win.screenshot({ path: join(out, `home-first-run-${lang}-${w}x${h}.png`) })
      check(`start page ${lang} ${w}×${h}: the demo is an outlined button beside New connection`, p.demoBeside && p.demoOutlined, JSON.stringify(p))
      check(`start page ${lang} ${w}×${h}: no button label cut or wrapped`, p.cut.length === 0, p.cut.join(' | '))
      if (w === 1280) check(`start page ${lang} ${w}×${h}: fits without scrolling`, !p.scrolls)
      const words = lang === 'en' ? ['docker-compose file on the window', 'Opens DBML, Prisma, Mermaid, drawDB, MySQL Workbench and DeZign files'] : ['docker-compose svého projektu', 'Otevře soubory DBML, Prisma, Mermaid, drawDB, MySQL Workbench a DeZign']
      check(`start page ${lang}: the drop of a project file and the model formats are named`, words.every((x) => p.text.includes(x)), p.text)
    }
  }
  await win.evaluate(() => window.mastermind.api.updateSettings({ language: 'en' }))
  await win.reload()
  await win.waitForTimeout(1200)
  await size(1280, 800)
  await win.waitForTimeout(500)
  // A project's .env dropped on the start page brings its connection (the drop handler is on the window); with a
  // connection the demo goes back among the quieter actions.
  {
    const env = join(dir, '.env')
    writeFileSync(env, 'DATABASE_URL=postgres://postgres:mastermind@127.0.0.1:54329/mastermind\n')
    await win.evaluate(() => {
      const input = Object.assign(document.createElement('input'), { type: 'file', id: 'flow117-drop' })
      input.style.display = 'none'
      document.body.append(input)
    })
    await win.setInputFiles('#flow117-drop', env)
    await win.evaluate(() => {
      const data = new DataTransfer()
      data.items.add(document.querySelector('#flow117-drop').files[0])
      document.querySelector('main, #root').dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
      document.querySelector('#flow117-drop').remove()
    })
    await win.getByText(/Imported 1 connection/).waitFor({ timeout: 10000 }).catch(() => {})
    check('a .env dropped on the start page imports its connection', (await win.getByText(/Imported 1 connection/).count()) > 0, await win.locator('body').innerText().then((x) => x.slice(0, 300)))
    const p = await startPage()
    check('with a connection the demo is a quiet button again', !p.demoBeside && !p.demoOutlined, JSON.stringify({ ...p, text: '' }))
    // (Its notice is dismissed: the toast checks below count their own.)
    await win.getByRole('button', { name: 'Dismiss' }).first().click().catch(() => {})
  }

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

  // The URL field's placeholder is never cut, at 1280 and 900 px; the hosted services are named in a line under it.
  for (const [w, h] of [[1280, 800], [900, 560]]) {
    await size(w, h)
    await win.waitForTimeout(300)
    const url = await placeholderFits('[role="dialog"] input[placeholder^="Paste a connection URL"]')
    check(`${w} px: the URL placeholder fits`, url.fits, JSON.stringify(url))
  }
  check('the hosted services are named under the field', (await win.getByTestId('url-services-hint').innerText()).includes('Supabase'))
  await size(1280, 800)
  await win.waitForTimeout(300)

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

  // Every way of throwing edits away asks the same question: Refresh, a new sort, a new page.
  const editCell = async (text) => {
    await win.locator('[role="gridcell"]').nth(6).dblclick()
    await win.keyboard.press('Meta+a')
    await win.keyboard.type(text)
    await win.keyboard.press('Enter')
    await win.waitForTimeout(300)
  }
  const asked = async () => {
    await dialog().waitFor({ timeout: 3000 }).catch(() => {})
    const texts = await dialog().locator('button').allInnerTexts().catch(() => [])
    return (await dialog().innerText().catch(() => '')).includes('Save the changes to orders?') && ['Save', 'Discard', 'Cancel'].every((b) => texts.some((x) => x.trim() === b))
  }
  await editCell('refresh-e2e')
  await win.getByRole('button', { name: 'Refresh (⌘R)' }).click()
  check('Refresh with unsaved edits asks Save / Discard / Cancel', await asked())
  await dialog().getByRole('button', { name: 'Cancel' }).click()
  await win.waitForTimeout(300)
  check('…Cancel keeps the edit', (await win.locator('[role="gridcell"]').nth(6).innerText()).includes('refresh-e2e'))
  await win.locator('[role="columnheader"]').nth(3).click({ button: 'right' })
  await win.getByRole('menuitem', { name: 'Sort descending' }).click()
  check('a new sort asks the same', await asked())
  await dialog().getByRole('button', { name: 'Cancel' }).click()
  await win.getByRole('button', { name: 'Next page' }).click()
  check('a new page asks the same', await asked())
  await dialog().getByRole('button', { name: 'Discard', exact: true }).click()
  await win.waitForTimeout(800)
  check('…Discard drops the edit and turns the page', (await win.locator('[role="gridcell"]').first().innerText()).trim() === '201' && !(await win.locator('[data-testid="tab-unsaved"]').count()))
  // Closing the window (quitting goes the same way) asks too, and Cancel keeps the window.
  await editCell('quit-e2e')
  void app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  check('closing the window with unsaved edits asks the same', await asked())
  await dialog().getByRole('button', { name: 'Cancel' }).click()
  await win.waitForTimeout(400)
  check('…Cancel keeps the window and the edit', (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 1 && (await win.locator('[data-testid="tab-unsaved"]').count()) === 1)
  await win.getByRole('button', { name: 'Discard changes' }).click()
  await win.waitForTimeout(300)

  // The reviewer's sequence: quit → Discard the edits → Cancel the open-transaction question → edit more → quit again
  // asks about the edits again (a remembered "settled" used to let them go without a question).
  await menu('new-query')
  await win.waitForTimeout(600)
  await win.locator('.cm-content:visible').first().click()
  await win.keyboard.insertText("begin;\nupdate customers set city = city where id = 1;")
  await win.keyboard.press('Meta+Shift+Enter')
  await win.waitForTimeout(1200)
  await win.locator('[data-node="table"]:visible', { hasText: /^orders$/ }).first().click()
  await win.locator('[role="gridcell"]').first().waitFor()
  await app.evaluate(({ dialog }) => {
    globalThis.__txAsked = 0
    globalThis.__txAnswer = 2 // Cancel
    dialog.showMessageBox = async () => (globalThis.__txAsked++, { response: globalThis.__txAnswer, checkboxChecked: false })
  })
  await editCell('quit-1')
  void app.evaluate(({ app }) => app.quit())
  check('quit with edits and an open transaction: the edits question first', await asked())
  await dialog().getByRole('button', { name: 'Discard', exact: true }).click()
  await win.waitForTimeout(1200)
  check('…then the open-transaction question; Cancel keeps the app', (await app.evaluate(() => globalThis.__txAsked)) === 1 && (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 1)
  await editCell('quit-2')
  void app.evaluate(({ app }) => app.quit())
  check('quitting again after more edits asks about the edits again', await asked())
  await dialog().getByRole('button', { name: 'Cancel' }).click()
  await win.waitForTimeout(500)
  check('…and Cancel keeps the app and the edits', (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 1 && (await win.locator('[data-testid="tab-unsaved"]').count()) === 1)
  await win.getByRole('button', { name: 'Discard changes' }).click()
  // The test's transaction is rolled back when the flow quits at the end.
  await app.evaluate(() => (globalThis.__txAnswer = 1))
  await menu('toggle-ai')
  await menu('toggle-ai')

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
  check('the assistant’s box names the database: "Ask about the … database…"', (await win.locator('textarea[placeholder^="Ask about"]').getAttribute('placeholder')) === 'Ask about the Demo coffee shop database…')
  // The table's plain-words filter: its placeholder fits, the example is its tooltip.
  const filterField = await placeholderFits('input[placeholder^="Describe a filter"]')
  check('the plain-words filter placeholder fits (AI panel open, 1280 px)', filterField.found && filterField.fits, JSON.stringify(filterField))

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

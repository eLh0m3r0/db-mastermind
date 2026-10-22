// Assistant chats survive a restart and have a history per connection (open, rename, delete). One real Codex call
// checks that a chat is saved on its own; the history steps use chats saved through the API. HOME stays real
// (Codex's login), the app's data is isolated and shared by the two launches.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui82-'))
async function launch() {
  const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
  const win = await app.firstWindow()
  win.setDefaultTimeout(60000)
  await app.evaluate(({ BrowserWindow, screen }) => { const w = BrowserWindow.getAllWindows()[0]; const a = screen.getPrimaryDisplay().workArea; w.setBounds({ x: a.x + a.width - 24, y: a.y + 40, width: 1440, height: 900 }); w.blur() })
  const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
  return { app, win, api }
}
const panelText = async (win) => {
  const text = await win.locator('body').innerText()
  return text.slice(text.lastIndexOf('AI assistant'))
}
let { app, win, api } = await launch()
try {
  await win.waitForTimeout(800)
  const s = await api('getSettings')
  await api('updateSettings', { ai: { ...s.ai, providers: [{ id: 'codex' }], activeProvider: 'codex', autoRunReadQueries: true } })
  await api('createSampleDatabase')
  await win.reload()
  await win.waitForTimeout(1200)
  await win.getByText('Demo coffee shop', { exact: true }).first().dblclick()
  await win.waitForTimeout(1500)
  await win.keyboard.press('Meta+j')
  const input = win.getByPlaceholder(/^Ask about /)
  await input.click()
  await input.fill('Reply with exactly the word PINEAPPLE and nothing else.')
  await win.keyboard.press('Enter')
  await win.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 10000 }).catch(() => {})
  await win.getByRole('button', { name: 'Stop' }).waitFor({ state: 'hidden', timeout: 180000 })
  await win.waitForTimeout(800)
  const demo = (await api('listConnections')).find((c) => c.driver === 'sqlite')
  // Two older chats for the history steps.
  const msg = (role, text) => ({ id: `m${Math.random()}`, role, parts: [{ type: 'text', text }] })
  await api('saveAiChat', { id: 'chat-a', connectionId: demo.id, title: 'Revenue by month', messages: [msg('user', 'Revenue by month'), msg('assistant', 'Here it is')] })
  await api('saveAiChat', { id: 'chat-b', connectionId: demo.id, title: 'Customers without orders', messages: [msg('user', 'Customers without orders'), msg('assistant', 'Seven of them')] })
  const live = (await api('listAiChats', demo.id)).find((c) => !c.id.startsWith('chat-'))
  console.log('real chat saved:', !!live, live?.title, live?.messageCount)
  await app.close()

  ;({ app, win, api } = await launch())
  await win.waitForTimeout(1200)
  await win.getByText('Demo coffee shop', { exact: true }).first().dblclick()
  await win.waitForTimeout(1500)
  if (!(await win.getByPlaceholder(/^Ask about /).isVisible().catch(() => false))) await win.keyboard.press('Meta+j')
  await win.waitForTimeout(800)
  // The newest saved chat (chat-b, saved last) is restored.
  console.log('restored after restart:', /Seven of them/.test(await panelText(win)))

  await win.getByRole('button', { name: 'Chat history' }).click()
  await win.getByText('Revenue by month', { exact: true }).waitFor({ timeout: 10000 })
  for (const title of ['Customers without orders', 'Revenue by month']) console.log('listed:', title, await win.getByText(title, { exact: true }).count())
  await win.getByText('Revenue by month', { exact: true }).click()
  console.log('opened older chat:', /Here it is/.test(await panelText(win)))

  await win.getByRole('button', { name: 'Chat history' }).click()
  const row = win.getByText('Revenue by month', { exact: true }).locator('xpath=ancestor::div[contains(@class,"group")][1]')
  await row.hover()
  await row.getByRole('button', { name: 'Rename chat' }).click()
  // Typed straight away: the field must already have the cursor, with the old title selected.
  await win.keyboard.type('Monthly revenue')
  await win.keyboard.press('Enter')
  await win.getByText('Monthly revenue', { exact: true }).waitFor({ timeout: 5000 })
  console.log('renamed:', (await api('listAiChats', demo.id)).some((c) => c.title === 'Monthly revenue'))

  const row2 = win.getByText('Monthly revenue', { exact: true }).locator('xpath=ancestor::div[contains(@class,"group")][1]')
  await row2.hover()
  await row2.getByRole('button', { name: 'Delete chat' }).click()
  await win.getByRole('button', { name: 'Delete', exact: true }).click()
  await win.waitForTimeout(500)
  console.log('deleted current chat:', !(await api('listAiChats', demo.id)).some((c) => c.id === 'chat-a'), '| panel empty:', !/Here it is/.test(await panelText(win)))

  await api('deleteConnection', demo.id)
  console.log('chats removed with the connection:', (await api('listAiChats', demo.id)).length === 0)
  await win.screenshot({ path: join(dir, 'flow82-end.png') })
  console.log('ok')
} catch (err) {
  await win.screenshot({ path: join(dir, 'flow82-fail.png') }).catch(() => {})
  console.log('screenshot', join(dir, 'flow82-fail.png'))
  throw err
} finally {
  await app.close()
}

// Sticky notes on a diagram survive saving and reopening.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: mkdtempSync(join(tmpdir(), 'dbm-ui49-')), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  const id = await api('createSampleDatabase')
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Demo coffee shop/ }).first().click()
  await win.waitForTimeout(1500)
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('Open ER diagram')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(2000)
  await win.getByRole('button', { name: 'Add a note' }).click()
  await win.waitForTimeout(300)
  const note = win.getByPlaceholder('Note…')
  await note.fill('Orders are archived yearly.\nAsk Petra before changing statuses.')
  await win.locator('.react-flow__pane').click({ position: { x: 10, y: 10 } })
  await win.waitForTimeout(300)
  await win.screenshot({ path: `${out}/r17-note.png` })
  await win.getByRole('button', { name: 'Diagrams' }).click()
  await win.getByText('Save as new diagram…').click()
  await win.getByPlaceholder('e.g. Sales, Billing, Warehouse').fill('Overview')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(1200)
  const saved = await api('listDiagrams', id)
  console.log('saved notes:', JSON.stringify(saved.map((d) => d.notes?.map((n) => n.text))))
  // Reopen from the saved list in a fresh tab.
  await win.keyboard.press('Meta+w')
  await win.waitForTimeout(300)
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('Open ER diagram')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(1500)
  await win.getByRole('button', { name: 'Diagrams' }).click()
  await win.getByText('Overview', { exact: true }).last().click()
  await win.waitForTimeout(1500)
  console.log('note after reopen:', await win.getByPlaceholder('Note…').inputValue())
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/r17-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

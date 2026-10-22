// Designer undo/redo: new tables come and go with the buttons and ⌘Z / ⇧⌘Z.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: mkdtempSync(join(tmpdir(), 'dbm-ui38-')), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const review = async () => `${await win.locator('.react-flow__node').count()} nodes`
try {
  await win.waitForTimeout(800)
  await api('createSampleDatabase')
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Demo coffee shop/ }).first().click()
  await win.waitForTimeout(1500)
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('Open ER diagram')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(2000)
  await win.getByRole('button', { name: 'Design', exact: true }).click()
  await win.getByRole('button', { name: 'New table', exact: true }).first().click()
  await win.waitForTimeout(300)
  await win.getByRole('button', { name: 'New table', exact: true }).first().click()
  await win.waitForTimeout(300)
  console.log('after 2 new tables:', await review())
  await win.screenshot({ path: `${out}/r7-new.png` })
  await win.getByRole('button', { name: /^Undo/ }).click()
  console.log('after undo button:', await review())
  await win.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } })
  await win.keyboard.press('Meta+z')
  console.log('after ⌘Z:', await review())
  await win.keyboard.press('Meta+Shift+z')
  console.log('after ⇧⌘Z:', await review())
  await win.getByRole('button', { name: /^Redo/ }).click()
  console.log('after redo button:', await review())
  // Typing a name is one undo step.
  await win.locator('.react-flow__node').filter({ hasText: 'new_table_2' }).dispatchEvent('click')
  await win.waitForTimeout(300)
  await win.evaluate(() => [...document.querySelectorAll('input')].find((i) => i.value === 'new_table_2')?.setAttribute('data-test', 'name'))
  await win.locator('[data-test="name"]').fill('')
  await win.locator('[data-test="name"]').pressSequentially('customers_archive', { delay: 30 })
  await win.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } })
  console.log('named:', await win.getByText('customers_archive').count())
  await win.keyboard.press('Meta+z')
  console.log('after ⌘Z of typing:', await win.getByText('customers_archive').count(), await review())
  await win.screenshot({ path: `${out}/r7-undo.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/r7-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

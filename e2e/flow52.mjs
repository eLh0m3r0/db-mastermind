// Saved change sets: save the designer's changes, discard them, load them back.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: mkdtempSync(join(tmpdir(), 'dbm-ui52-')), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const nodes = () => win.locator('.react-flow__node').count()
try {
  await win.waitForTimeout(800)
  const id = await api('createSampleDatabase')
  await win.reload()
  await win.waitForTimeout(1000)
  await win.evaluate(() => { window.prompt = () => 'Release 42'; window.confirm = () => true })
  await win.getByRole('button', { name: /Demo coffee shop/ }).first().click()
  await win.waitForTimeout(1500)
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('Open ER diagram')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(2000)
  await win.getByRole('button', { name: 'Design', exact: true }).click()
  await win.getByRole('button', { name: 'New table', exact: true }).first().click()
  await win.waitForTimeout(400)
  console.log('with change:', await nodes())
  await win.getByRole('button', { name: 'Change sets' }).click()
  await win.getByText('Save these changes as…').click()
  await win.waitForTimeout(500)
  console.log('saved:', JSON.stringify((await api('listChangeSets', id)).map((c) => [c.name, Object.keys(c.design).length])))
  await win.getByRole('button', { name: 'Discard' }).click()
  await win.waitForTimeout(400)
  console.log('after discard:', await nodes())
  await win.getByRole('button', { name: 'Change sets' }).click()
  await win.getByText(/^Release 42/).hover()
  await win.getByText('Load (replaces the current changes)').click()
  await win.waitForTimeout(600)
  console.log('after load:', await nodes(), await win.getByRole('button', { name: /Review migration/ }).innerText())
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

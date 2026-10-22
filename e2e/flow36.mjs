// Model tab exports: PlantUML to the clipboard and an HTML data dictionary.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui36-'))
const target = join(dir, 'dict.html')
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: dir, DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
await app.evaluate(({ session }, target) => session.defaultSession.on('will-download', (_e, item) => item.setSavePath(target)), target)
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
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
  await win.getByRole('button', { name: 'Export' }).last().click()
  await win.getByText('Edit as model (DBML)…').click()
  await win.waitForTimeout(2500)
  await win.getByRole('button', { name: 'Export' }).last().click()
  await win.getByText('Copy as PlantUML').click()
  await win.waitForTimeout(300)
  const puml = await app.evaluate(({ clipboard }) => clipboard.readText())
  console.log('plantuml:', puml.split('\n').slice(0, 6).join(' | '), '… rels:', puml.split('\n').filter((l) => l.includes('--o{')).length)
  await win.getByRole('button', { name: 'Export' }).last().click()
  await win.getByText('Data dictionary (HTML)…').click()
  await win.waitForTimeout(2000)
  const html = existsSync(target) ? readFileSync(target, 'utf8') : ''
  console.log('dictionary bytes:', html.length, 'has orders:', html.includes('orders'))
  await win.screenshot({ path: `${out}/r5-model-export.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/r5-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

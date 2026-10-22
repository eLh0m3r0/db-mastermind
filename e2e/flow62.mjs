// Trino in the app (trinodb/trino on :18080, built-in tpch catalog): add the connection in the form, browse
// tiny.nation, filter a bigint column with a typed value, run SQL across catalogs.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui62-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: dir, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
try {
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: 'New connection' }).first().click()
  await win.waitForTimeout(500)
  await win.getByRole('button', { name: 'Trino', exact: true }).click()
  await win.locator('input[placeholder="localhost"]').fill('127.0.0.1')
  await win.locator('input[inputmode="numeric"]').first().fill('18080')
  await win.locator('input[autocomplete="off"]').first().fill('dbm')
  await win.locator('input[placeholder="hive"]').fill('tpch')
  await win.screenshot({ path: `${out}/r62-trino-form.png` })
  await win.getByRole('button', { name: /Save & connect|Connect/ }).last().click()
  await win.waitForTimeout(4000)
  console.log('explorer:', await win.getByPlaceholder(/Filter .+ tables/).getAttribute('placeholder'))
  await win.getByPlaceholder(/Filter .+ tables/).fill('tiny.nation')
  await win.getByPlaceholder(/Filter .+ tables/).press('Enter')
  await win.waitForTimeout(3000)
  console.log('rows label:', await win.getByText(/\d+ rows/).first().innerText())
  await win.getByRole('button', { name: /^Filter/ }).click()
  await win.locator('select').nth(0).selectOption('regionkey')
  await win.locator('select').nth(1).selectOption('eq')
  await win.getByPlaceholder('value').last().fill('3')
  await win.getByRole('button', { name: 'Apply' }).click()
  await win.waitForTimeout(3000)
  console.log('filtered rows label:', await win.getByText(/\d+ rows/).first().innerText())
  const cells = await win.locator('.font-mono:visible').allInnerTexts()
  console.log('europe:', ['FRANCE', 'GERMANY', 'ROMANIA', 'RUSSIA', 'UNITED KINGDOM'].filter((n) => cells.includes(n)).join(','))
  await win.screenshot({ path: `${out}/r62-trino-filter.png` })
  await win.keyboard.press(`${mod}+t`)
  await win.waitForTimeout(500)
  await win.locator('.cm-content:visible').first().click()
  await win.keyboard.insertText('SELECT r.name AS region, count(*) AS nations FROM tiny.nation n JOIN tiny.region r ON r.regionkey = n.regionkey GROUP BY r.name ORDER BY r.name')
  await win.keyboard.press(`${mod}+Enter`)
  await win.waitForTimeout(4000)
  const texts = await win.locator('.font-mono:visible').allInnerTexts()
  console.log('query result:', texts.filter((x) => /^(AFRICA|AMERICA|ASIA|EUROPE|MIDDLE EAST|5)$/.test(x)).join(' '))
  await win.screenshot({ path: `${out}/r62-trino-query.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/r62-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

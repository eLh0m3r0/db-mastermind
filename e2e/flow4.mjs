import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2]
const userData = mkdtempSync(join(tmpdir(), 'dbm-ui4-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: userData, DBM_NO_UPDATE_CHECK: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
try {
  await win.waitForTimeout(800)
  await api('updateSettings', { language: 'cs' })
  await api('saveConnection', { id: '', name: 'Shop PG', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' })
  await win.reload()
  await win.waitForTimeout(1200)
  await shot('30-home-cs')
  await win.getByRole('button', { name: /Shop PG/ }).first().click()
  await win.waitForTimeout(2500)
  await win.locator('.cm-content').last().click()
  await win.keyboard.type("select c.name, sum(o.total) from shop.orders o join shop.customers c on c.id = o.customer_id where o.status = :status and o.total > :min group by c.name", { delay: 1 })
  await win.keyboard.press('Escape')
  await win.keyboard.press('Meta+Enter')
  await win.waitForTimeout(500)
  await shot('31-params')
  await win.locator('input.font-mono').first().fill('paid')
  await win.locator('input.font-mono').nth(1).fill('100')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(1200)
  await shot('32-params-result')
  await win.locator('.cm-content').last().click()
  await win.keyboard.press('Meta+a')
  await win.keyboard.type("select c.name, count(*) from shop.orders o join shop.customers c on c.id = o.customer_id where o.total > 100 group by c.name order by 2 desc", { delay: 1 })
  await win.keyboard.press('Escape')
  await win.getByRole('button', { name: 'Plán' }).click()
  await win.getByText('Plán se změřením (spustí dotaz)').click()
  await win.waitForTimeout(1500)
  await shot('33-plan')
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await shot('99-error')
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 10)))
  await app.close()
}

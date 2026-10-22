// Model designer: add a table on the canvas and write it to DBML; enums and groups survive.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui43-'))
const file = join(dir, 'shop.dbml')
writeFileSync(file, `Enum order_status {
  new
  done
}

Table customers {
  id int [pk]
  name varchar(100) [not null]
}

Table orders {
  id int [pk]
  customer_id int [not null]
  status order_status
}

Ref: orders.customer_id > customers.id

TableGroup Sales {
  customers
  orders
}
`)
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, file)
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
  await win.keyboard.type('Open model')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(2000)
  await win.getByRole('button', { name: 'Design', exact: true }).click()
  await win.getByRole('button', { name: 'New table', exact: true }).first().click()
  await win.waitForTimeout(500)
  await win.getByRole('button', { name: /Write to DBML/ }).click()
  await win.waitForTimeout(800)
  const text = await win.locator('.cm-content:visible').first().innerText()
  console.log('has new table:', text.includes('Table new_table_1'), 'enum kept:', text.includes('Enum order_status'), 'group kept:', /TableGroup Sales \{[\s\S]*customers[\s\S]*orders/.test(text), 'ref kept:', text.includes('Ref: orders.customer_id > customers.id'))
  console.log('write button now:', await win.getByRole('button', { name: /Write to DBML/ }).innerText(), await win.getByRole('button', { name: /Write to DBML/ }).isDisabled())
  await win.screenshot({ path: `${out}/r12-model-design.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  await win.screenshot({ path: `${out}/r12-error.png` })
} finally {
  console.log('errors:', JSON.stringify(errors.slice(0, 5)))
  await app.close()
}

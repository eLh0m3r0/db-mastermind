// Code from a model (Milestone 12, A1): the demo database's ER diagram → Export → Code ▸ Prisma schema, Drizzle
// schema, SQLAlchemy models and TypeScript types, each saved through the (stubbed) save dialog under the tool's
// usual name; then a model of its own (PostgreSQL, with an enum and a relationship drawn twice) as a Prisma schema.
// The files' validity is the tools test's job (packages/core/test/orm-export.tools.test.ts): here, what the app
// offers and writes.
import { _electron as electron } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? tmpdir()
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui112-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` (${detail})`}`)
  if (!ok) process.exitCode = 1
}
/** The save dialog answers with `file` and remembers the name it was offered. */
const answerSave = (file) =>
  app.evaluate(({ dialog }, file) => {
    globalThis.__offered = undefined
    dialog.showSaveDialog = async (...args) => {
      globalThis.__offered = (args.at(-1) ?? {}).defaultPath
      return { canceled: false, filePath: file }
    }
  }, file)
const offered = () => app.evaluate(() => globalThis.__offered)
/** Export → Code ▸ `label`, saved to `file`: done once the file is there. */
const exportCode = async (label, file) => {
  await answerSave(file)
  await win.getByRole('button', { name: 'Export', exact: true }).click()
  await win.getByRole('menuitem', { name: 'Code', exact: true }).hover()
  await win.getByRole('menuitem', { name: `${label}…`, exact: true }).click()
  for (let i = 0; i < 75 && !existsSync(file); i++) await win.waitForTimeout(200)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}
try {
  await win.waitForTimeout(800)
  await win.evaluate(() => window.mastermind.api.createSampleDatabase())
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /Demo coffee shop/ }).first().click()
  await win.waitForTimeout(1500)
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('Open ER diagram')
  await win.keyboard.press('Enter')
  await win.locator('.react-flow__node').nth(6).waitFor({ timeout: 20000 })

  // The four formats for SQLite (Prisma and Drizzle both have it).
  await win.getByRole('button', { name: 'Export', exact: true }).click()
  await win.getByRole('menuitem', { name: 'Code', exact: true }).hover()
  await win.getByRole('menuitem', { name: 'TypeScript types…' }).waitFor({ timeout: 5000 })
  const items = await win.getByRole('menu').last().getByRole('menuitem').allInnerTexts()
  check('Export → Code offers the four formats for SQLite', JSON.stringify(items) === JSON.stringify(['Prisma schema…', 'Drizzle schema (TypeScript)…', 'SQLAlchemy models (Python)…', 'TypeScript types…']), JSON.stringify(items))
  await win.screenshot({ path: `${out}/r112-code-menu.png` })
  await win.keyboard.press('Escape')

  const files = { prisma: join(dir, 'schema.prisma'), drizzle: join(dir, 'schema.ts'), sqlalchemy: join(dir, 'models.py'), typescript: join(dir, 'types.ts') }
  const prisma = await exportCode('Prisma schema', files.prisma)
  check('the save dialog offers schema.prisma', (await offered()) === 'schema.prisma', await offered())
  check('a notice says where the code was saved', await win.getByText('Code saved').first().isVisible())
  check('Prisma: the SQLite provider', prisma.includes('provider = "sqlite"'))
  check('Prisma: both sides of a relation', /customers\s+customers\s+@relation\(fields: \[customer_id\], references: \[id\]/.test(prisma) && /orders\s+orders\[\]/.test(prisma))
  check('Prisma: the self-relation of employees, named', /employees\s+employees\?\s+@relation\("employeesToemployees"/.test(prisma) && /other_employees\s+employees\[\]/.test(prisma))
  check('Prisma: the composite key of order_items', /@@id\(\[order_id, product_id\]\)/.test(prisma))

  const drizzle = await exportCode('Drizzle schema (TypeScript)', files.drizzle)
  check('the save dialog offers schema.ts', (await offered()) === 'schema.ts', await offered())
  check('Drizzle: sqlite-core tables with references', drizzle.includes("from 'drizzle-orm/sqlite-core'") && drizzle.includes("export const orderItems = sqliteTable('order_items'") && /customerId: integer\('customer_id'\)\.notNull\(\)\.references\(\(\): AnySQLiteColumn => customers\.id\)/.test(drizzle))

  const py = await exportCode('SQLAlchemy models (Python)', files.sqlalchemy)
  check('the save dialog offers models.py', (await offered()) === 'models.py', await offered())
  check('SQLAlchemy: declarative classes with foreign keys', py.includes('class Base(DeclarativeBase):') && py.includes('class OrderItems(Base):') && py.includes('ForeignKey("customers.id"'))

  const ts = await exportCode('TypeScript types', files.typescript)
  check('the save dialog offers types.ts', (await offered()) === 'types.ts', await offered())
  check('TypeScript: an interface per table, nullable columns with null', /export interface Orders \{[^}]*employee_id: number \| null;/s.test(ts))

  // A new model is linked to the connection in use, so it is for SQLite here (without one: PostgreSQL); its enum is
  // an enum, two relationships to one table are named.
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('New model')
  await win.keyboard.press('Enter')
  await win.locator('.cm-content:visible').first().waitFor({ timeout: 15000 })
  await win.locator('.cm-content:visible').first().click()
  await win.keyboard.insertText("Enum order_status {\n  new\n  paid\n}\n\nTable customer {\n  id bigint [pk, increment]\n  email varchar(200) [not null, unique]\n}\n\nTable invoice {\n  id bigint [pk, increment]\n  buyer_id bigint [not null, ref: > customer.id]\n  payer_id bigint [ref: > customer.id]\n  status order_status [not null, default: 'new']\n}\n")
  await win.locator('.react-flow__node').nth(1).waitFor({ timeout: 15000 })
  await win.waitForTimeout(800)
  const m = await exportCode('Prisma schema', join(dir, 'model.prisma'))
  check('a new model: the provider of its database and the enum', m.includes('provider = "sqlite"') && /status\s+order_status\s+@default\(new\)/.test(m) && /enum order_status \{/.test(m))
  check('two relationships to one table are named on both sides', /customer_invoice_buyer_idTocustomer\s+customer\s+@relation\("invoice_buyer_idTocustomer"/.test(m) && /invoice_invoice_payer_idTocustomer\s+invoice\[\]\s+@relation\("invoice_payer_idTocustomer"\)/.test(m))
  await win.screenshot({ path: `${out}/r112-model.png` })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  process.exitCode = 1
  await win.screenshot({ path: `${out}/r112-error.png` }).catch(() => {})
} finally {
  check('no page errors', errors.length === 0, JSON.stringify(errors.slice(0, 3)))
  await app.close()
}

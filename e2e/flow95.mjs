// A team's day with a DeZign model and a real PostgreSQL, through the window: the model names its own schema,
// has names in capitals, a domain and its own template for key names; the database is empty except for somebody
// else's table. The scripts are the ones DeZign itself would write: bare names (PostgreSQL stores them in lower
// case), the domain as a type, keys named by the template. Compare writes the script (schema, tables, keys,
// check), the script runs, and the model and the database are then identical; the model moves on (a column,
// a table, a check, a column gone) and the ALTER script brings the database along.
// Needs the `postgres` service of docker-compose.test.yml.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'dbm-ui95-'))
const el = (tag, body) => `<${tag}>\n${body}\n</${tag}>`
const attr = (id, name, type, size = '', extra = '') => el('ATTR', `<NAME>${name}</NAME>\n<ID>${id}</ID>\n<DESC></DESC>\n<DOMAINID></DOMAINID>\n<DT>\n<DTLISTNAME>${type}</DTLISTNAME>\n${size}<SD>1</SD>\n<INC>1</INC>\n</DT>\n${extra}`)
const notNull = '<NNCON>\n<VALUE>1</VALUE>\n</NNCON>\n'
const ent = (id, name, pk, attrs, more = '') => el('ENT', `<NAME>${name}</NAME>\n<ID>${id}</ID>\n<SCHEMA>sales</SCHEMA>\n<DESC></DESC>\n<PKCON>\n<NAME>${name}_PK</NAME>\n<ATTRIBUTEIDS>\n<ATTRIBUTEID>${pk}</ATTRIBUTEID>\n</ATTRIBUTEIDS>\n</PKCON>\n<ATTRIBUTES>\n${attrs.join('\n')}\n</ATTRIBUTES>\n${more}`)
const rel = el('REL', '<NAME>customer_invoice</NAME>\n<ID>40</ID>\n<PARENTOBJECTID>10</PARENTOBJECTID>\n<CHILDOBJECTID>20</CHILDOBJECTID>\n<UPDATERULE>0</UPDATERULE>\n<DELETERULE>2</DELETERULE>\n<PAIRS>\n<PAIR>\n<KEYID>A1</KEYID>\n<FOREIGNKEYID>B2</FOREIGNKEYID>\n</PAIR>\n</PAIRS>')
const entities = [
  // The invoice comes first and references the customer below it; names in capitals need their quotes.
  ent('20', 'Invoice', 'B1', [attr('B1', 'id', 'INTEGER', '', notNull), attr('B2', 'customer_id', 'INTEGER', '', notNull), attr('B3', 'Total', 'NUMERIC', '<LE>10</LE>\n<PR>2</PR>\n', `${notNull}<DEFCON>\n<VALUE>0</VALUE>\n</DEFCON>\n`).replace('<DOMAINID></DOMAINID>', '<DOMAINID>D1</DOMAINID>'), attr('B4', 'state', 'CHARACTER VARYING', '<LE>12</LE>\n', '<DEFCON>\n<VALUE>new</VALUE>\n</DEFCON>\n')],
    el('CONSTRAINTS', el('CONSTRAINT', '<NAME>invoice_total_ok</NAME>\n<ID>C1</ID>\n<VALUE>Total &gt;= 0</VALUE>\n<CONLEVEL>2</CONLEVEL>\n<CONTYPE>1</CONTYPE>\n<ATTRIBUTEIDS>\n<ATTRIBUTEID>B3</ATTRIBUTEID>\n</ATTRIBUTEIDS>'))),
  ent('10', 'customer', 'A1', [attr('A1', 'id', 'INTEGER', '', notNull), attr('A2', 'name', 'CHARACTER VARYING', '<LE>120</LE>\n', notNull), attr('A3', 'since', 'TIMESTAMP', '', '<DEFCON>\n<VALUE>CURRENT_TIMESTAMP</VALUE>\n</DEFCON>\n')]),
]
const entc = (id, l) => el('ENTC', `<ID>${id}</ID>\n<DIAGRAMID>1</DIAGRAMID>\n<W>240</W>\n<H>100</H>\n<L>${l}</L>\n<T>0</T>\n<BRUSH>0,16119285</BRUSH>`)
const settings = el('PROJECTSETTINGS', el('COMMONSETTINGS', '<PROJECTNAME /></PROJECTNAME />\n<FILEFORMATVERSION>140</FILEFORMATVERSION>'))
const dez = join(dir, 'team.dez')
writeFileSync(
  dez,
  `<?xml version="1.0" encoding="iso-8859-1"?><dezign>\n<VERSION>\n${settings}\n<DATADICT>\n<DBID>postgresql16</DBID>\n<DDSETTINGS>\n<CONVERTDOMAINS>0</CONVERTDOMAINS>\n<PKCONNAMETEMPLATE>%table%_PK</PKCONNAMETEMPLATE>\n</DDSETTINGS>\n<DOMAINS>\n${el('DOMAIN', '<NAME>AMOUNT_T</NAME>\n<ID>D1</ID>\n<DT>\n<DTLISTNAME>NUMERIC</DTLISTNAME>\n<LE>10</LE>\n<PR>2</PR>\n</DT>')}\n</DOMAINS>\n<ENTITIES>\n${entities.join('\n')}\n</ENTITIES>\n<RELATIONSHIPS>\n${rel}\n</RELATIONSHIPS>\n</DATADICT>\n<DIAGRAMS>\n${el('DIAGRAM', '<ID>1</ID>\n<NAME>Main</NAME>\n<ISMAINDIAGRAM>1</ISMAINDIAGRAM>')}\n<ENTITYCONTROLS>\n${entc('20', 0)}\n${entc('10', 600)}\n</ENTITYCONTROLS>\n</DIAGRAMS>\n</VERSION>\n</dezign>\n`,
  'latin1',
)

const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
win.setDefaultTimeout(30000)
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const DB = 'dbm_e2e95'
let failed = 0
const check = (label, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${label}: ${ok ? 'ok' : 'FAILED'}${detail ? ` ${detail}` : ''}`)
}
let n = 0
const sql = async (connectionId, text) => {
  const r = await api('runQuery', { runId: `e2e95-${++n}`, connectionId, sql: text })
  const bad = (Array.isArray(r) ? r : (r?.results ?? [r])).find((x) => x?.error)
  if (bad) throw new Error(`${bad.error.message ?? bad.error}\n${String(bad.sql ?? '').slice(0, 200)}`)
  return r
}
/** Opens the compare of the model with its database and returns the script it writes ('' when identical). */
const compare = async () => {
  await win.getByText('team.dez', { exact: true }).first().click()
  await win.getByRole('button', { name: /Compare with Team DB/ }).click()
  await win.getByRole('button', { name: 'Compare', exact: true }).last().click()
  // Earlier compare tabs stay in the page, hidden: only what is on screen counts.
  const shown = (text) => win.evaluate((text) => [...document.querySelectorAll('span, div, h3, p')].some((e) => e.offsetParent !== null && e.childElementCount === 0 && e.textContent.includes(text)), text)
  for (const until = Date.now() + 30000; Date.now() < until && !(await shown('The schemas are identical')) && !(await shown('Migration for Team DB')); ) await win.waitForTimeout(200)
  await win.waitForTimeout(300)
  if (await shown('The schemas are identical')) return ''
  return win.evaluate(() => [...document.querySelectorAll('pre')].filter((e) => e.offsetParent !== null).pop()?.innerText ?? '')
}
try {
  await win.waitForTimeout(800)
  const admin = await api('saveConnection', { id: '', name: 'Server', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' })
  await api('connect', admin.id)
  await sql(admin.id, `DROP DATABASE IF EXISTS ${DB}`)
  await sql(admin.id, `CREATE DATABASE ${DB}`)
  const team = await api('saveConnection', { id: '', name: 'Team DB', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: DB })
  await api('connect', team.id)
  // Somebody else's table, in the schema every PostgreSQL database starts with.
  await sql(team.id, 'CREATE TABLE public.legacy (id int primary key)')
  await win.reload()
  await win.waitForTimeout(1000)

  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, dez)
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('Open model')
  await win.keyboard.press('Enter')
  await win.locator('.react-flow__node:visible').first().waitFor({ timeout: 30000 })
  // (A DeZign project opens on its objects: this flow works with the model's text.)
  await win.getByRole('button', { name: 'Text (DBML)' }).last().click()
  await win.locator('[data-testid="model-compare-menu"]:visible').click()
  await win.getByRole('menuitemcheckbox', { name: 'Team DB' }).click()

  // 1. The first script: the model's schema, both tables (in the model's order), the key between them, the check.
  const create = await compare()
  check('script makes the schema of the model', /CREATE SCHEMA IF NOT EXISTS "sales"/.test(create))
  check('tables go to that schema, not to public, under the names DeZign would create', /CREATE TABLE "sales"\."invoice"/.test(create) && /CREATE TABLE "sales"\."customer"/.test(create) && !/"public"\."(invoice|customer)"/.test(create) && !/"Invoice"|"Total"/.test(create))
  check('the domain is a type of the database and types its column', /CREATE DOMAIN amount_t AS numeric\(10,2\)/.test(create) && /"total" amount_t NOT NULL DEFAULT 0/.test(create))
  check('keys are named by the project\'s template', /CONSTRAINT "invoice_pk" PRIMARY KEY \("id"\)/.test(create) && /CONSTRAINT "customer_pk" PRIMARY KEY/.test(create) && /ADD CONSTRAINT "customer_invoice" FOREIGN KEY/.test(create))
  check('the foreign key comes after both tables', create.indexOf('FOREIGN KEY') > create.indexOf('CREATE TABLE "sales"."customer"'))
  check('the check is the model\'s', /CONSTRAINT "invoice_total_ok" CHECK \(Total >= 0\)/.test(create))
  check('a word typed as a text default is a string', /DEFAULT 'new'/.test(create))
  check('nothing of the other table is touched', !/legacy/.test(create))
  await sql(team.id, create)
  check('after running it the model and the database are identical', (await compare()) === '')

  // 2. The model moves on, typed as a person would type it in the editor.
  await win.getByText('team.dez', { exact: true }).first().click()
  const text = (await api('openModelFile', dez)).text
  const next = text
    .replace(/(\n\s*)name ("character varying\(120\)"|character varying\(120\)|varchar\(120\))/, '$1name varchar(200)')
    .replace(/\n\s*state [^\n]*/, '')
    .replace(/(Table sales\.customer \{)/, '$1\n  email varchar(255)')
    .concat("\nTable sales.Payment {\n  id integer [pk]\n  invoice_id integer [not null, ref: > sales.Invoice.id]\n  amount numeric(10,2) [not null, domain: 'AMOUNT_T']\n\n  checks {\n    `amount > 0` [name: 'payment_positive']\n  }\n}\n")
  check('the edit applies to the model text', next !== text && /email varchar\(255\)/.test(next) && !/\n\s*state /.test(next), next === text ? '(the text did not change)' : '')
  await win.locator('.cm-content:visible').first().click()
  await win.keyboard.press('Meta+a')
  await win.keyboard.insertText(next)
  await win.waitForTimeout(900)
  check('the edited model parses', (await win.locator('.text-warning button:visible').count()) === 0)

  // A single change can stay out of the script (a table with one change has its table's box for that).
  await compare()
  const states = await win.evaluate(() => [...document.querySelectorAll('[data-testid="compare-change"]')].filter((e) => e.offsetParent !== null).map((e) => e.parentElement.innerText.trim()))
  const longer = states.findIndex((x) => /Change column name/.test(x))
  if (longer > -1) {
    await win.locator('[data-testid="compare-change"]:visible').nth(longer).uncheck()
    await win.waitForTimeout(500)
  }
  const partial = await win.evaluate(() => [...document.querySelectorAll('pre')].filter((e) => e.offsetParent !== null).pop()?.innerText ?? '')
  check('a change left out is not in the script, the others are', longer > -1 && !/ALTER COLUMN "name" TYPE/.test(partial) && /ADD COLUMN "email"/.test(partial) && /DROP COLUMN "state"/.test(partial), states.join(' | ').slice(0, 200))

  const alter = await compare()
  check('ALTER: the new column', /ALTER TABLE "sales"\."customer" ADD COLUMN "email" varchar\(255\)/.test(alter))
  check('ALTER: the longer name', /ALTER COLUMN "name" TYPE varchar\(200\)/.test(alter))
  check('ALTER: the column that left', /ALTER TABLE "sales"\."invoice" DROP COLUMN "state"/.test(alter))
  check('ALTER: the new table with its key (named by the template), check and domain column', /CREATE TABLE "sales"\."payment"/.test(alter) && /CONSTRAINT "payment_pk" PRIMARY KEY/.test(alter) && /CONSTRAINT "payment_positive" CHECK \(amount > 0\)/.test(alter) && /REFERENCES "sales"\."invoice"/.test(alter) && /"amount" amount_t NOT NULL/.test(alter))
  check('ALTER: nothing that did not change', !/"total"|invoice_total_ok|"since"|legacy/.test(alter), alter.split('\n').length + ' lines')
  await sql(team.id, alter)
  check('after the ALTER script they are identical again', (await compare()) === '')

  // 3. A check keeps its name and gets another condition: the database is asked, and the check is replaced.
  await win.getByText('team.dez', { exact: true }).first().click()
  const loosened = next.replace('`Total >= 0`', '`Total >= 0 AND Total < 1000000`')
  check('the condition is edited in the model text', loosened !== next)
  await win.locator('.cm-content:visible').first().click()
  await win.keyboard.press('Meta+a')
  await win.keyboard.insertText(loosened)
  await win.waitForTimeout(900)
  const recheck = await compare()
  check('a changed condition under the same name is seen', /DROP CONSTRAINT "invoice_total_ok"/.test(recheck) && /ADD CONSTRAINT "invoice_total_ok" CHECK \(Total >= 0 AND Total < 1000000\)/.test(recheck), recheck.split('\n').length + ' lines')
  check('and nothing else is touched for it', !/CREATE TABLE|ADD COLUMN|DROP COLUMN|payment_positive/.test(recheck))
  await sql(team.id, recheck)
  check('after replacing the check they are identical', (await compare()) === '')

  // 4. A column and a table get new names in the model: renamed in the database, not dropped and made again.
  await sql(team.id, "INSERT INTO sales.customer (id, name, email) VALUES (1, 'Ada', 'ada@example.com')")
  await win.getByText('team.dez', { exact: true }).first().click()
  const renamed = loosened.replace(/(\n\s*)email varchar\(255\)/, '$1e_mail varchar(255)').replaceAll('sales.Payment', 'sales.Receipt')
  check('the names are edited in the model text', renamed !== loosened && /e_mail varchar\(255\)/.test(renamed) && /Table sales\.Receipt/.test(renamed))
  await win.locator('.cm-content:visible').first().click()
  await win.keyboard.press('Meta+a')
  await win.keyboard.insertText(renamed)
  await win.waitForTimeout(900)
  const renames = await compare()
  const offered = await win.evaluate(() => [...document.querySelectorAll('[data-testid="compare-renames"]')].filter((e) => e.offsetParent !== null).pop()?.innerText ?? '')
  check('the renames are offered for confirmation', /customer\.email → e_mail/.test(offered) && /payment → receipt/.test(offered), offered.replace(/\s+/g, ' ').slice(0, 160))
  check('RENAME, not DROP and ADD', /ALTER TABLE "sales"\."customer" RENAME COLUMN "email" TO "e_mail"/.test(renames) && /ALTER TABLE "sales"\."payment" RENAME TO "receipt"/.test(renames) && !/DROP (COLUMN|TABLE)|CREATE TABLE|ADD COLUMN/.test(renames), renames.split('\n').slice(0, 12).join(' | '))
  await sql(team.id, renames)
  check('after the renames they are identical', (await compare()) === '')
  const kept = await sql(team.id, 'SELECT e_mail FROM sales.customer WHERE id = 1')
  check('the data of the renamed column is still there', JSON.stringify(kept).includes('ada@example.com'), JSON.stringify(kept).slice(0, 200))

  // 5. The model as it is now goes into the project; then somebody changes the database directly, the model is
  // updated from it and that change saved into the project too.
  await win.getByText('team.dez', { exact: true }).first().click()
  await win.getByRole('button', { name: 'Save', exact: true }).click()
  await win.getByText(/Write these changes into team\.dez\?/).waitFor({ timeout: 10000 })
  await win.getByRole('button', { name: 'Write to the DeZign file' }).click()
  await win.getByText(/Saved to team\.dez/).last().waitFor({ timeout: 10000 })
  await sql(team.id, 'ALTER TABLE sales.customer ADD COLUMN phone varchar(30); CREATE TABLE sales.note (id integer PRIMARY KEY, customer_id integer NOT NULL REFERENCES sales.customer (id), body text)')
  await win.getByText('team.dez', { exact: true }).first().click()
  const beforeUpdate = await win.locator('.cm-content:visible').first().innerText()
  await win.locator('[data-testid="model-more"]:visible').click()
  await win.getByRole('menuitem', { name: 'From database' }).click()
  if (await win.getByRole('menuitem', { name: 'Start the model from the database' }).count()) await win.getByRole('menuitem', { name: 'Start the model from the database' }).click()
  await win.getByText('Update the model (keeps its comments, domains and layout)').click()
  await win.getByText(/Model updated from Team DB/).waitFor({ timeout: 20000 })
  await win.waitForTimeout(800)
  const updated = await win.locator('.cm-content:visible').first().innerText()
  check('the model has what the database has new', /phone (varchar|"character varying)\(30\)/.test(updated) && /Table sales\.note/.test(updated), updated.replace(/\s+/g, ' ').slice(0, 600))
  await win.getByRole('button', { name: 'Save', exact: true }).click()
  await win.getByText(/Write these changes into team\.dez\?/).waitFor({ timeout: 10000 })
  const listedUpdate = await win.locator('[role="dialog"], .fixed').filter({ hasText: 'Write these changes' }).last().innerText()
  check('the update lists only what the database has new', /new column: customer \(phone\)/.test(listedUpdate) && /new table: note/.test(listedUpdate) && !/dropped|renamed/.test(listedUpdate), listedUpdate.replace(/\s+/g, ' ').slice(180, 900))
  await win.getByRole('button', { name: 'Write to the DeZign file' }).click()
  await win.getByText(/Saved to team\.dez/).last().waitFor({ timeout: 10000 })
  const savedUpdate = readFileSync(dez, 'latin1')
  check('the project has the new column and table', /<NAME>phone<\/NAME>/.test(savedUpdate) && /<NAME>note<\/NAME>/.test(savedUpdate), String(beforeUpdate.length))
  check('after the update the model and the database are identical', (await compare()) === '')

  // 6. What the database really has.
  const schema = await api('getSchema', team.id, true)
  const tables = (schema.tables ?? []).filter((t) => t.schema === 'sales')
  check('the database has the four tables in the schema', tables.map((t) => t.name).sort().join(',') === 'customer,invoice,note,receipt')
  check('with both checks', tables.flatMap((t) => (t.checks ?? []).map((c) => c.name)).sort().join(',') === 'invoice_total_ok,payment_positive')
  check('and the other table is still there', (schema.tables ?? []).some((t) => t.schema === 'public' && t.name === 'legacy'))

  await api('disconnect', team.id)
  await sql(admin.id, `DROP DATABASE IF EXISTS ${DB}`)
} catch (err) {
  failed++
  console.log('FAILED', String(err.message).split('\n').slice(0, 3).join(' | '))
  // What the window shows, to see why (a made-up model: nothing private in it).
  console.log(((await win.evaluate(() => document.body.innerText).catch(() => '')) || '').replace(/\s+/g, ' ').slice(-1200))
} finally {
  console.log('errors:', JSON.stringify(errors), '| failed checks:', failed)
  await app.close()
  rmSync(dir, { recursive: true, force: true })
  process.exit(failed || errors.length ? 1 : 0)
}

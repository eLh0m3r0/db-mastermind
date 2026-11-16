// PostgreSQL explorer: partitions under their table, sequences / types / extensions with their definitions, the
// structure tab's partitions, triggers and row-level security, an enum cell offering its values, and a table without
// a primary key that can be edited through its unique index. Needs postgres (npm run db:up).
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? tmpdir()
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui111-'))
const app = await electron.launch({
  args: ['apps/desktop'],
  env: { ...process.env, HOME: dir, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' },
})
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
let failed = 0
const check = (label, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) failed++
}

const seed = `
DROP SCHEMA IF EXISTS e2e_obj CASCADE;
CREATE SCHEMA e2e_obj;
CREATE TYPE e2e_obj.mood AS ENUM ('happy', 'calm', 'grumpy');
CREATE SEQUENCE e2e_obj.ticket_no START WITH 100;
CREATE TABLE e2e_obj.events (id int NOT NULL, happened date NOT NULL, mood e2e_obj.mood, PRIMARY KEY (id, happened)) PARTITION BY RANGE (happened);
CREATE TABLE e2e_obj.events_2026 PARTITION OF e2e_obj.events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
INSERT INTO e2e_obj.events VALUES (1, '2026-05-01', 'calm');
CREATE TABLE e2e_obj.notes (code text NOT NULL, body text);
CREATE UNIQUE INDEX notes_code ON e2e_obj.notes (code);
CREATE FUNCTION e2e_obj.touch() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
CREATE TRIGGER notes_touch BEFORE UPDATE ON e2e_obj.notes FOR EACH ROW EXECUTE FUNCTION e2e_obj.touch();
ALTER TABLE e2e_obj.notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY everyone ON e2e_obj.notes USING (true);
INSERT INTO e2e_obj.notes VALUES ('a', 'first');
`

try {
  await win.waitForTimeout(800)
  const conn = await api('saveConnection', { id: '', name: 'Objects PG', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' })
  await api('connect', conn.id ?? conn)
  const seeded = await api('runQuery', { connectionId: conn.id ?? conn, sql: seed, runId: 'seed' })
  const seedErrors = (seeded.outcomes ?? seeded).filter((o) => o.error).map((o) => o.error.message)
  if (seedErrors.length) throw new Error(`seed: ${seedErrors.join('; ')}`)
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByText('Objects PG', { exact: true }).first().dblclick()
  const filter = win.getByPlaceholder(/Filter .+ tables/)
  await filter.waitFor({ timeout: 30000 })

  // Groups of the schema (the filter narrows to it).
  await filter.fill('e2e_obj.')
  await win.waitForTimeout(400)
  await filter.fill('')
  const schemaRow = win.locator('[data-node="schema"]', { hasText: 'e2e_obj' })
  await schemaRow.waitFor({ timeout: 10000 })
  for (const label of ['Sequences', 'Types', 'Extensions']) {
    // Extensions live in public here; the others in e2e_obj.
    const present = await win.getByText(label, { exact: true }).count()
    if (label !== 'Extensions') check(`group "${label}" shown`, present > 0)
  }
  check('sequence listed', (await win.locator('[data-node="sequence"]', { hasText: 'ticket_no' }).count()) === 1)
  check('enum listed', (await win.locator('[data-node="type"]', { hasText: 'mood' }).count()) === 1)

  // Partitions under their table.
  const events = win.locator('[data-node="table"]', { hasText: /^events$/ }).first()
  await events.getByRole('button', { name: 'Expand' }).click()
  await win.locator('[data-node="partition"]', { hasText: 'events_2026' }).waitFor({ timeout: 5000 })
  check('partition under its table', true)
  check('partition table not listed on its own', (await win.locator('[data-node="table"]', { hasText: 'events_2026' }).count()) === 0)
  await win.screenshot({ path: `${out}/r111-explorer.png` })

  // A click on the sequence opens its definition.
  await win.locator('[data-node="sequence"]', { hasText: 'ticket_no' }).click()
  await win.waitForTimeout(800)
  const def = await win.locator('.cm-content:visible').first().innerText()
  check(`sequence definition: ${JSON.stringify(def.slice(0, 80))}`, /CREATE SEQUENCE "?e2e_obj"?\."?ticket_no"?/.test(def) && /START WITH 100/.test(def))

  // The partition's data: the enum cell offers its values.
  await win.locator('[data-node="partition"]', { hasText: 'events_2026' }).click()
  await win.getByText('calm', { exact: true }).first().waitFor({ timeout: 10000 })
  check('partition data is editable', (await win.getByText(/No primary key/).count()) === 0)
  await win.getByText('calm', { exact: true }).first().dblclick()
  const editor = win.locator('[data-cell-editor]')
  await editor.waitFor({ timeout: 5000 })
  const listId = await editor.getAttribute('list')
  const options = listId ? await win.locator(`datalist[id="${listId}"] option`).evaluateAll((os) => os.map((o) => o.value)) : []
  check(`enum cell offers ${JSON.stringify(options)}`, JSON.stringify(options) === JSON.stringify(['happy', 'calm', 'grumpy']))
  await win.keyboard.press('Escape')

  // A table without a primary key, through its unique index.
  await filter.fill('notes')
  await filter.press('Enter')
  await win.getByText('first', { exact: true }).first().waitFor({ timeout: 10000 })
  check('table without a primary key is editable', (await win.getByText(/No primary key/).count()) === 0)
  await win.getByText('first', { exact: true }).first().dblclick()
  await win.keyboard.press(`${mod}+a`)
  await win.keyboard.type('edited')
  await win.keyboard.press('Enter')
  await win.keyboard.press(`${mod}+s`)
  await win.waitForTimeout(500)
  const confirm = win.getByRole('button', { name: /^(Save|Apply)/ }).last()
  if (await confirm.isVisible().catch(() => false)) await confirm.click()
  await win.waitForTimeout(1000)
  const after = await api('runQuery', { connectionId: conn.id ?? conn, sql: "SELECT body FROM e2e_obj.notes WHERE code = 'a'", runId: 'chk' })
  const body = (after.outcomes ?? after)[0]?.results?.[0]?.rows?.[0]?.[0]
  check(`edit saved through the unique index: ${body}`, body === 'edited')

  // Structure: triggers and row-level security.
  await win.keyboard.press('Escape')
  const notesRow = win.locator('[data-node="table"]', { hasText: /^notes$/ }).first()
  await notesRow.click({ button: 'right' })
  await win.getByText('Open structure', { exact: true }).click()
  await win.getByTestId('triggers').waitFor({ timeout: 10000 })
  check('structure lists the trigger', (await win.getByTestId('triggers').innerText()).includes('notes_touch'))
  check('structure shows RLS and its policy', /Enabled[\s\S]*everyone/.test(await win.getByTestId('policies').innerText()))
  await win.screenshot({ path: `${out}/r111-structure.png` })

  check(`no page errors ${errors.join(' | ')}`, errors.length === 0)
  await api('runQuery', { connectionId: conn.id ?? conn, sql: 'DROP SCHEMA e2e_obj CASCADE', runId: 'clean' })
} finally {
  await app.close()
}
if (failed) {
  console.log(`${failed} check(s) failed`)
  process.exit(1)
}
console.log('flow111 passed')

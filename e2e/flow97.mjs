// Modelling without typing DBML, as in DeZign: a relationship clicked on the canvas opens its properties
// (cardinality), a table's comment of several lines and its notes, a table moved to another schema with the
// relationships that point at it, a table duplicated from its menu, several tables lined up, a table deleted with
// the Delete key. Everything ends up in the model text without writing any.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'dbm-ui97-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' } })
const win = await app.firstWindow()
const modelText = () => win.locator('.cm-content:visible').first().innerText()
const write = async () => {
  await win.getByRole('button', { name: /Write to DBML/ }).click()
  await win.waitForTimeout(900)
}
const designing = async () => {
  if (!(await win.getByRole('button', { name: /Write to DBML/ }).count())) await win.getByRole('button', { name: 'Design', exact: true }).click()
  await win.getByRole('button', { name: /Write to DBML/ }).waitFor({ timeout: 10000 })
}
const node = (key) => win.locator(`.react-flow__node[data-id="${key}"]`)
try {
  await win.getByRole('button', { name: 'New model', exact: true }).click()
  await win.locator('.cm-content:visible').first().waitFor({ timeout: 15000 })
  await win.locator('.cm-content:visible').first().click()
  await win.keyboard.insertText(
    'Table shop.customer {\n  id bigint [pk]\n  name text\n}\n\nTable shop.invoice {\n  id bigint [pk]\n  customer_id bigint [not null, ref: > shop.customer.id]\n  total numeric(12,2)\n}\n\nTable shop.line {\n  id bigint [pk]\n  invoice_id bigint [ref: > shop.invoice.id]\n}\n',
  )
  await node('shop.invoice').waitFor({ timeout: 15000 })
  await win.waitForTimeout(800)
  await designing()

  // The relationship invoice → customer, clicked on the canvas: the invoice's panel with that foreign key marked.
  const edge = win.locator('.react-flow__edge').filter({ has: win.locator('path') }).and(win.locator('[data-testid^="rf__edge-shop.invoice:"]'))
  await edge.first().dispatchEvent('click')
  await win.getByTestId('fk-cardinality').waitFor({ timeout: 10000 })
  console.log('relationship opens its properties:', await win.locator('input[value="invoice"]').count() > 0, await win.locator('[data-testid^="fk-"].ring-1').count() === 1)
  await win.getByTestId('fk-cardinality').selectOption('zero-or-one')
  await win.getByTestId('table-comment').fill('Issued invoices.\nOne per order.')
  await win.getByTestId('table-remarks').fill('Checked by accounting')
  await win.getByTestId('fk-add-pair').click()
  console.log('a key of two columns can be set up:', await win.getByTestId('fk-column-1').count() === 1)
  await win.locator('[data-testid^="fk-"] button[aria-label="Remove this pair of columns"]').last().click()
  await write()
  let text = await modelText()
  // (Zero or one is DBML's one-to-one operator.)
  console.log('written without typing:', /shop\.invoice\.customer_id - shop\.customer\.id/.test(text), /One per order/.test(text), /Remarks: 'Checked by accounting'/.test(text))

  // The customer moves to another schema: the invoice's relationship follows it.
  await designing()
  await node('shop.customer').click()
  await win.getByTestId('table-schema').fill('sales')
  await write()
  text = await modelText()
  console.log('moved to another schema:', /Table sales\.customer/.test(text), /customer_id - sales\.customer\.id/.test(text), !/shop\.customer/.test(text))

  // A copy of a table from its menu.
  await designing()
  await node('shop.line').click({ button: 'right' })
  await win.getByText('Duplicate table', { exact: true }).click()
  await write()
  text = await modelText()
  console.log('duplicated:', /Table shop\.line_copy/.test(text))

  // Two tables selected: lined up on their left edge.
  await designing()
  await node('shop.invoice').click()
  await node('shop.line').click({ modifiers: ['Meta'] })
  await win.getByTestId('arrange-bar').waitFor({ timeout: 5000 })
  await win.getByTestId('align-left').click()
  await win.waitForTimeout(500)
  const [a, b] = [await node('shop.invoice').boundingBox(), await node('shop.line').boundingBox()]
  console.log('aligned:', Math.abs(a.x - b.x) < 2)
  // ⌘Z takes the move back, ⌘⇧Z does it again.
  await win.keyboard.press('Meta+z')
  await win.waitForTimeout(500)
  const [c, d] = [await node('shop.invoice').boundingBox(), await node('shop.line').boundingBox()]
  await win.keyboard.press('Meta+Shift+z')
  await win.waitForTimeout(500)
  const [e, f] = [await node('shop.invoice').boundingBox(), await node('shop.line').boundingBox()]
  console.log('undo and redo of the move:', Math.abs(c.x - d.x) > 2, Math.abs(e.x - f.x) < 2)

  // DeZign's table dialog (double-click): the columns in a grid, the SQL it makes; nothing changes before OK.
  await win.keyboard.press('Escape')
  await node('shop.invoice').dblclick({ position: { x: 40, y: 12 } })
  await win.getByTestId('table-dialog-grid').waitFor({ timeout: 10000 })
  await win.getByTestId('grid-type-total').fill('numeric(14,2)')
  await win.getByTestId('table-dialog-add-column').click()
  if (process.argv[2]) await win.screenshot({ path: join(process.argv[2], 'flow97-table-dialog.png') })
  await win.getByRole('button', { name: 'SQL', exact: true }).click()
  const preview = await win.getByTestId('table-dialog-sql').innerText()
  await win.getByTestId('table-dialog-ok').click()
  await write()
  text = await modelText()
  console.log('table dialog:', /CREATE TABLE/.test(preview) && /numeric\(14,\s*2\)/i.test(preview), /total numeric\(14,2\)/.test(text), /column_4/.test(text))

  // DeZign's relationship dialog (double-click on the line line → invoice): cardinality, identifying, on delete.
  await designing()
  await win.locator('[data-testid^="rf__edge-shop.line:"]').first().dispatchEvent('dblclick')
  await win.getByTestId('relationship-cardinality').waitFor({ timeout: 10000 })
  await win.getByTestId('cardinality-one-or-more').click()
  await win.getByText('Identifying', { exact: true }).click()
  await win.getByTestId('relationship-on-delete').selectOption('CASCADE')
  if (process.argv[2]) await win.screenshot({ path: join(process.argv[2], 'flow97-relationship-dialog.png') })
  await win.getByTestId('relationship-dialog-ok').click()
  await write()
  text = await modelText()
  const lineTable = /Table shop\.line \{[\s\S]*?\n\}/.exec(text)?.[0] ?? ''
  console.log('relationship dialog:', /shop\.line\.invoice_id > shop\.invoice\.id \[[^\]]*delete: cascade[^\]]*cardinality: 'one or more'/i.test(text) || /cardinality: 'one or more'[^\]]*delete: cascade/i.test(text), /invoice_id bigint \[[^\]]*pk/.test(lineTable) || /\(id, invoice_id\) \[pk\]/.test(lineTable))

  // The Delete key takes a selected table out of the model.
  await win.keyboard.press('Escape')
  await node('shop.line_copy').click()
  await win.keyboard.press('Delete')
  await write()
  text = await modelText()
  // (Every edit was written while the canvas showed another schema too: no table of the model went missing.)
  console.log('deleted with the key:', !/line_copy/.test(text), /Table shop\.line /.test(text), 'nothing else lost:', /Table sales\.customer/.test(text) && /Table shop\.invoice/.test(text))

  // Copy and paste: two tables with the relationship between them, pasted back under free names.
  await designing()
  // (The whole diagram in view: tables may lie past the canvas's edge.)
  await win.locator('.react-flow__controls-fitview:visible').click()
  await win.waitForTimeout(400)
  await node('shop.line').click({ modifiers: ['Meta'] })
  await node('shop.invoice').click({ modifiers: ['Meta'], position: { x: 40, y: 12 } })
  const copied = await win.evaluate(() => {
    const data = new DataTransfer()
    document.body.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }))
    return data.getData('text/plain')
  })
  await win.evaluate((text) => {
    const data = new DataTransfer()
    data.setData('text/plain', text)
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, copied)
  await win.waitForTimeout(500)
  await write()
  text = await modelText()
  console.log('copy and paste:', /Table shop\.invoice /.test(copied) && /Table shop\.line /.test(copied), /Table shop\.invoice_copy/.test(text), /shop\.line_copy\.invoice_id > shop\.invoice_copy\.id/.test(text))

  // ⌘A selects every table; the zoom shows as a percentage and goes back to 100 % on a click.
  await win.locator('.react-flow__pane:visible').click({ position: { x: 20, y: 20 } })
  await win.keyboard.press('Meta+a')
  const all = await win.locator('.react-flow__node.selected:visible').count()
  const zoomBefore = await win.getByTestId('zoom-level').innerText()
  await win.getByTestId('zoom-level').click()
  await win.waitForTimeout(400)
  console.log('select all and zoom:', all === (await win.locator('.react-flow__node:visible').count()), /%/.test(zoomBefore), (await win.getByTestId('zoom-level').innerText()).trim() === '100 %')

  // A diagram of the selected tables (DeZign: subdiagram from the selection), where they stand.
  await win.locator('.react-flow__pane:visible').click({ position: { x: 20, y: 20 } })
  await win.locator('.react-flow__controls-fitview:visible').click()
  await win.waitForTimeout(300)
  await node('shop.line').click({ modifiers: ['Meta'] })
  await node('shop.invoice').click({ modifiers: ['Meta'], position: { x: 40, y: 12 } })
  await win.getByTestId('diagram-from-selection').click()
  await win.getByPlaceholder('Name of the diagram').fill('Billing part')
  await win.getByRole('button', { name: 'Create', exact: true }).click()
  await win.waitForTimeout(1200)
  console.log('diagram from the selection:', await win.locator('.react-flow__node:visible').count() === 2, await win.locator('option:checked', { hasText: 'Billing part' }).count() > 0)
  await win.locator('select:has(option:checked:text("Billing part"))').first().selectOption({ index: 0 })
  await win.waitForTimeout(800)

  // Enums and table groups from the object browser, without typing DBML.
  await win.getByRole('button', { name: 'Objects', exact: true }).last().click()
  await win.getByTestId('browser-enums-edit').click()
  await win.getByTestId('enum-add').click()
  await win.getByTestId('enum-name-0').fill('invoice_status')
  await win.getByTestId('enum-values-0').fill('new\npaid\ncancelled')
  await win.getByTestId('enums-ok').click()
  await win.getByTestId('browser-groups-edit').click()
  await win.getByTestId('group-add').click()
  await win.getByTestId('group-name-0').fill('Billing')
  await win.getByText('invoice', { exact: true }).last().click()
  await win.getByTestId('groups-ok').click()
  await win.getByRole('button', { name: 'Text (DBML)', exact: true }).last().click()
  text = await modelText()
  console.log('enums and groups:', /Enum invoice_status \{\s*new\s*paid\s*cancelled\s*\}/.test(text), /TableGroup Billing \{[^}]*invoice/.test(text))

  // A change made in a dialog goes into what the toolbar makes without "Write to DBML" first (as Save does).
  await designing()
  await node('sales.customer').dblclick({ position: { x: 40, y: 12 } })
  await win.getByTestId('table-dialog-grid').waitFor({ timeout: 10000 })
  await win.getByTestId('grid-type-name').fill('varchar(77)')
  await win.getByTestId('table-dialog-ok').click()
  await win.getByRole('button', { name: 'SQL DDL', exact: true }).click()
  await win.getByRole('menuitem', { name: 'PostgreSQL', exact: true }).click()
  await win.waitForTimeout(1200)
  const ddl = await win.locator('.cm-content:visible').first().innerText()
  console.log('toolbar takes the canvas along:', /varchar\(77\)/i.test(ddl), (await win.getByRole('button', { name: /Write to DBML \(\d+\)/ }).count()) === 0)
  if (process.argv[2]) await win.screenshot({ path: join(process.argv[2], 'flow97.png') })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
  if (process.argv[2]) await win.screenshot({ path: join(process.argv[2], 'flow97-error.png') })
} finally {
  await app.close()
}

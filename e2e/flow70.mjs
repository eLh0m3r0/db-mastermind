// ER diagram: opens on a visible schema when others are hidden, keeps the whole layout after a restart (not just the
// dragged table), a new sticky note takes the cursor and survives quitting with the cursor still in it, and PNG/SVG
// exports go through a save dialog without the minimap or zoom buttons.
import { _electron as electron } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const home = mkdtempSync(join(tmpdir(), 'dbm-ui70-'))
const env = { ...process.env, HOME: home, DBM_USER_DATA: join(home, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' }
const start = async () => {
  const app = await electron.launch({ args: ['apps/desktop'], env })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1400, height: 900 })
  return { app, win }
}
const boxes = (win) => win.evaluate(() => Object.fromEntries([...document.querySelectorAll('.react-flow__node-table')].map((n) => [n.getAttribute('data-id'), n.style.transform])))
let { app, win } = await start()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
try {
  await win.waitForTimeout(800)
  await win.evaluate(() => window.mastermind.api.saveConnection({ id: '', name: 'PG', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind', hiddenSchemas: ['public'] }))
  await win.reload()
  await win.waitForTimeout(900)
  await win.getByText('PG', { exact: true }).first().dblclick()
  await win.getByPlaceholder(/Filter .+ tables/).waitFor({ timeout: 20000 })
  await win.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+k`)
  await win.keyboard.type('Open ER diagram')
  await win.keyboard.press('Enter')
  await win.locator('.react-flow__node').first().waitFor({ timeout: 20000 })
  await win.waitForTimeout(1000)
  const schemas = await win.locator('select').evaluateAll((s) => s.map((x) => [...x.options].map((o) => o.value)).find((o) => o.includes('shop')) ?? [])
  console.log('schema picker lists hidden "public":', schemas.includes('public'), '| opens on:', await win.locator('select').evaluateAll((s) => s.map((x) => x.value).find((v) => v === 'shop')))

  const node = win.locator('.react-flow__node', { hasText: 'customers' }).first()
  const b = await node.boundingBox()
  await win.mouse.move(b.x + 40, b.y + 10)
  await win.mouse.down()
  await win.mouse.move(b.x + 200, b.y + 120, { steps: 8 })
  await win.mouse.up()
  await win.waitForTimeout(600)
  const before = await boxes(win)

  await win.getByRole('button', { name: /note/i }).first().click()
  await win.waitForFunction(() => document.activeElement?.closest('.react-flow__node-note'), null, { timeout: 3000 }).catch(() => console.log('the new note did not take the cursor'))
  await win.keyboard.type('Customers come from the CRM')
  await win.waitForTimeout(700)

  for (const ext of ['png', 'svg']) {
    const file = join(home, `diagram.${ext}`)
    await app.evaluate(({ dialog }, f) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: f })
    }, file)
    await win.getByRole('button', { name: /Export/ }).first().click()
    await win.getByRole('menuitem', { name: new RegExp(ext, 'i') }).first().click()
    await win.getByText('Diagram saved').first().waitFor({ timeout: 20000 })
    const body = existsSync(file) ? readFileSync(file) : undefined
    console.log(`${ext}:`, body ? `${Math.round(statSync(file).size / 1024)} KB, valid: ${ext === 'png' ? body.subarray(1, 4).toString() === 'PNG' : body.toString('utf8', 0, 4) === '<svg'}` : 'NOT WRITTEN', ext === 'svg' && body ? `| zoom buttons: ${body.includes('react-flow__controls')} | under 4 MB: ${body.length < 4e6}` : '')
    await win.getByText('Diagram saved').first().waitFor({ state: 'detached', timeout: 15000 }).catch(() => {})
  }
  await app.close()

  ;({ app, win } = await start())
  await win.locator('.react-flow__node-table').first().waitFor({ timeout: 20000 })
  await win.waitForTimeout(1200)
  const after = await boxes(win)
  const moved = Object.keys(before).filter((k) => before[k] !== after[k])
  console.log('layout kept after restart:', Object.keys(before).length > 1 && moved.length === 0, moved.length ? moved : '')
  console.log('note kept:', (await win.locator('.react-flow__node-note textarea').evaluateAll((a) => a.map((x) => x.value))).join('|') === 'Customers come from the CRM')
  console.log('errors:', errors.length ? errors : 'none')
} finally {
  await app.close()
}

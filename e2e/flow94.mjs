// A model from scratch without knowing DBML: New model on the start page, the first table by a button, more
// tables in the designer, then SQL for a database and a DeZign project for colleagues.
import { _electron as electron } from '@playwright/test'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'dbm-ui94-'))
const dez = join(dir, 'new-model.dez')
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' } })
await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, dez)
const win = await app.firstWindow()
try {
  await win.getByRole('button', { name: 'New model', exact: true }).click()
  await win.getByTestId('model-first-table').waitFor({ timeout: 15000 })
  console.log('empty model offers a first step:', await win.getByTestId('model-first-table').isVisible())
  await win.getByTestId('model-first-table').click()
  await win.locator('.react-flow__node').first().waitFor({ timeout: 15000 })
  await win.getByRole('button', { name: /Write to DBML/ }).waitFor({ timeout: 10000 })
  console.log('first table in the designer:', await win.locator('.react-flow__node').count(), 'table, design mode:', await win.getByRole('button', { name: /Write to DBML/ }).count() > 0)
  await win.getByRole('button', { name: 'New table', exact: true }).first().click()
  await win.waitForTimeout(500)
  await win.getByRole('button', { name: /Write to DBML/ }).click()
  await win.waitForTimeout(900)
  const text = await win.locator('.cm-content:visible').first().innerText()
  console.log('second table from the designer:', (text.match(/^Table /gm) ?? []).length, 'tables in the model')
  await win.locator('[data-testid="model-more"]:visible').click()
  await win.getByRole('menuitem', { name: 'Save as…' }).click()
  await win.getByText('Saved as a DeZign for Databases project').waitFor({ timeout: 15000 })
  const saved = existsSync(dez) ? readFileSync(dez, 'latin1') : ''
  console.log('saved as a DeZign project:', (saved.match(/<ENT>/g) ?? []).length, 'tables,', (saved.match(/<ENTC>/g) ?? []).length, 'on the diagram')
  // The same as a folder project (for Git): a folder of its name, with one file per object, as DeZign makes it.
  const proj = join(dir, 'team-model.dezproj')
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, proj)
  await win.locator('[data-testid="model-more"]:visible').click()
  await win.getByRole('menuitem', { name: 'Save as…' }).click()
  await win.getByText('Saved as a DeZign for Databases project').last().waitFor({ timeout: 15000 })
  const folder = join(dir, 'team-model')
  const entities = existsSync(join(folder, 'data dictionary', 'entities')) ? readdirSync(join(folder, 'data dictionary', 'entities')).length : 0
  console.log('saved as a folder project:', existsSync(join(folder, 'team-model.dezproj')), entities, 'table files,', existsSync(join(folder, 'team-model.dds')))
  if (process.argv[2]) await win.screenshot({ path: join(process.argv[2], 'flow94.png') })
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
} finally {
  await app.close()
}

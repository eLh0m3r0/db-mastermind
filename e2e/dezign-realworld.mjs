// Real DeZign models through the real app: each model in DBM_DEZ_SAMPLES (a folder of .dez files and folder
// projects) is copied, opened, checked, edited in the editor, saved back into the copy and read again.
// Prints one line of counts per model, never names from it. Usage:
//   DBM_DEZ_SAMPLES=/path/to/models node e2e/dezign-realworld.mjs
import { _electron as electron } from '@playwright/test'
import { cpSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const root = process.env.DBM_DEZ_SAMPLES
if (!root) throw new Error('Set DBM_DEZ_SAMPLES to a folder with DeZign models')
const find = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name.toLowerCase() !== 'archived versions') find(path, out)
    } else if (/\.dezproj$/i.test(name) || (/\.dez$/i.test(name) && !/<FILEFORMATVERSIONNUMBER>/.test(readFileSync(path, 'latin1').slice(0, 600)))) out.push(path)
  }
  return out
}
const work = mkdtempSync(join(tmpdir(), 'dbm-realworld-'))
// Every model gets a copy under its own name, so the originals stay as they are and tabs can be told apart.
const models = find(root).map((source, i) => {
  const name = `model${String(i + 1).padStart(2, '0')}`
  if (/\.dezproj$/i.test(source)) {
    cpSync(dirname(source), join(work, name), { recursive: true, filter: (p) => !/archived versions/i.test(p) })
    return join(work, name, basename(source))
  }
  cpSync(source, join(work, `${name}.dez`))
  return join(work, `${name}.dez`)
})

const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(work, 'home'), DBM_USER_DATA: join(work, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' } })
const win = await app.firstWindow()
const pageErrors = []
win.on('pageerror', () => pageErrors.push(1))
const api = (method, ...args) => win.evaluate(([m, a]) => window.mastermind.api[m](...a), [method, args])
const tablesIn = (text) => (text.match(/^Table /gm) ?? []).length
let failed = 0
await win.waitForTimeout(1500)
for (const [i, path] of models.entries()) {
  const label = `#${i + 1} ${/\.dezproj$/i.test(path) ? 'folder' : 'file'}`
  const started = Date.now()
  try {
    const before = await api('openModelFile', path)
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, path)
    await win.keyboard.press('Meta+k')
    await win.keyboard.type('Open model')
    await win.keyboard.press('Enter')
    await win.locator('.react-flow__node:visible').first().waitFor({ timeout: 60000 })
    const drawn = Date.now() - started
    await win.waitForTimeout(600)
    const parseErrors = await win.locator('.text-warning button:visible').count()
    const issues = (await win.locator('[data-testid="model-issues"]:visible').count()) ? (await win.locator('[data-testid="model-issues"]:visible').innerText()).trim() : 'none'

    // An edit as a person makes it: a new table typed at the end of the model, then Save and its confirmation.
    await win.locator('.cm-content:visible').first().click()
    await win.keyboard.press('Meta+ArrowDown')
    await win.keyboard.insertText('\nTable dbm_e2e_table {\n  id int [pk]\n  note varchar(40) [note: \'Přidáno testem\']\n}\n')
    await win.waitForTimeout(900)
    await win.locator('button:visible', { hasText: /^Save$/ }).first().click()
    await win.getByText(/Write these changes into/).waitFor({ timeout: 30000 })
    const listed = await win.locator('.fixed:visible').filter({ hasText: 'Write these changes' }).last().innerText()
    const lines = listed.split('\n').filter((l) => /^(new|dropped|renamed|changed|table|primary|added|taken|moved)/.test(l.trim())).length
    await win.getByRole('button', { name: 'Write to the DeZign file' }).click()
    await win.getByText(/Saved to/).last().waitFor({ timeout: 60000 })
    await win.waitForTimeout(500)

    // What the file holds now, read as on a fresh open: the model plus the one table, and nothing more to save.
    const after = await api('openModelFile', path)
    const again = await api('saveDezignModel', { path, text: after.text, hash: after.imported.hash, positions: after.imported.positions, notes: after.imported.notes, colors: after.imported.colors, diagrams: after.imported.diagrams, layout: true, dryRun: true })
    const ok = parseErrors === 0 && tablesIn(after.text) === tablesIn(before.text) + 1 && /Table (\w+\.)?dbm_e2e_table \{/.test(after.text) && /Přidáno testem/.test(after.text) && lines === 1 && again.changes.length === 0
    if (!ok) failed++
    console.log(`${label}: tables ${before.imported.tables} → ${tablesIn(after.text)} | drawn in ${drawn} ms | dbml errors ${parseErrors} | checks: ${issues} | changes listed ${lines} | second save changes ${again.changes.length} | ${ok ? 'ok' : 'FAILED'}`)
  } catch (err) {
    failed++
    console.log(`${label}: FAILED ${String(err.message).split('\n')[0].replace(/"[^"]*"/g, '"…"').slice(0, 160)}`)
    await win.keyboard.press('Escape').catch(() => {})
  }
  await win.keyboard.press('Meta+w').catch(() => {})
  await win.waitForTimeout(400)
  // An unsaved model asks before closing: this one is a throwaway copy.
  const discard = win.getByRole('button', { name: /Discard|Close without saving|Don.t save/ })
  if (await discard.count()) await discard.first().click().catch(() => {})
}
console.log(`models: ${models.length} | failed: ${failed} | page errors: ${pageErrors.length}`)
await app.close()
process.exit(failed ? 1 : 0)

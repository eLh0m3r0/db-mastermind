import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assembleDezignProject, parseDbml, readDezign, toDbml } from '../src/index.js'

/**
 * Real models stay out of the repository. Point DBM_DEZ_SAMPLES at a folder with `.dez` files and/or folder
 * projects to check the reader against them; only counts are printed, never names from the models.
 */
const root = process.env.DBM_DEZ_SAMPLES

function find(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name.toLowerCase() !== 'archived versions') find(path, out)
    } else if (/\.(dez|dezproj)$/i.test(name)) out.push(path)
  }
  return out
}

function projectFiles(dir: string, base = dir, out: { path: string; text: string }[] = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name.toLowerCase() !== 'archived versions') projectFiles(path, base, out)
    } else out.push({ path: relative(base, path), text: readFileSync(path, 'latin1') })
  }
  return out
}

describe.skipIf(!root)('DeZign models on this machine', () => {
  it('reads every model and turns it into valid DBML', () => {
    const files = find(root!)
    expect(files.length).toBeGreaterThan(0)
    files.forEach((file, n) => {
      const binary = /\.dezproj$/i.test(file) ? assembleDezignProject(projectFiles(join(file, '..'))) : readFileSync(file, 'latin1')
      const model = readDezign(binary, { node: { width: 240, header: 32, row: 22 } })
      const back = parseDbml(toDbml(model.tables))
      const count = (f: (t: (typeof model.tables)[number]) => number) => model.tables.reduce((sum, t) => sum + f(t), 0)
      console.log(
        `#${n + 1} ${/\.dezproj$/i.test(file) ? 'folder' : 'file'} format=${model.formatVersion} db=${model.targetDatabase} ${model.encoding} tables=${model.tables.length} columns=${count((t) => t.columns.length)} fks=${count((t) => t.foreignKeys.length)} indexes=${count((t) => t.indexes.length)} positions=${Object.keys(model.positions).length} leftOut=${JSON.stringify(model.leftOut)} dbmlErrors=${back.errors.length}`,
      )
      expect(model.tables.length).toBeGreaterThan(0)
      // Counts only: a failed comparison of the errors themselves would print text from the model.
      expect(back.errors.length).toBe(0)
      expect(back.tables.length).toBe(model.tables.length)
      expect(back.tables.reduce((s, t) => s + t.columns.length, 0)).toBe(count((t) => t.columns.length))
      expect(back.tables.reduce((s, t) => s + t.foreignKeys.length, 0)).toBe(count((t) => t.foreignKeys.filter((fk) => !fk.virtual).length))
    })
  })
})

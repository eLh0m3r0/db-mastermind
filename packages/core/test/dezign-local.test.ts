import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { diagramsAsLoaded, mutate, mutateDiagrams, random } from './dezign-fuzz.js'
import { applyDezignSave, assembleDezignProject, checkModel, dezignIntegrity, parseDbml, readDezign, saveToDezign, toDbml, type DezignFile, type TableInfo } from '../src/index.js'

/**
 * Real models stay out of the repository. Point DBM_DEZ_SAMPLES at a folder with `.dez` files and/or folder
 * projects to check the reader against them; only counts are printed, never names from the models.
 */
const root = process.env.DBM_DEZ_SAMPLES
// Passing tests print nothing: DBM_DEZ_REPORT=<file> collects the count lines.
const report = (line: string) => (process.env.DBM_DEZ_REPORT ? appendFileSync(process.env.DBM_DEZ_REPORT, `${line}\n`) : console.log(line))

function find(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name.toLowerCase() !== 'archived versions') find(path, out)
    } else if (/\.dezproj$/i.test(name) || (/\.dez$/i.test(name) && !/<FILEFORMATVERSIONNUMBER>/.test(readFileSync(path, 'latin1').slice(0, 600)))) out.push(path)
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
      report(
        `#${n + 1} ${/\.dezproj$/i.test(file) ? 'folder' : 'file'} format=${model.formatVersion} db=${model.targetDatabase} ${model.encoding} tables=${model.tables.length} columns=${count((t) => t.columns.length)} fks=${count((t) => t.foreignKeys.length)} indexes=${count((t) => t.indexes.length)} positions=${Object.keys(model.positions).length} leftOut=${JSON.stringify(model.leftOut)} dbmlErrors=${back.errors.length} issues=${JSON.stringify(checkModel(model.tables).reduce<Record<string, number>>((all, i) => ({ ...all, [`${i.severity ?? ''}:${i.kind}`]: (all[`${i.severity ?? ''}:${i.kind}`] ?? 0) + 1 }), {}))}`,
      )
      expect(model.tables.length).toBeGreaterThan(0)
      // Counts only: a failed comparison of the errors themselves would print text from the model.
      if (back.errors.length && process.env.DBM_DEZ_DEBUG) console.log(`DBML errors of #${n + 1}:`, back.errors.slice(0, 4))
      expect(back.errors.length).toBe(0)
      expect(back.tables.length).toBe(model.tables.length)
      expect(back.tables.reduce((s, t) => s + t.columns.length, 0)).toBe(count((t) => t.columns.length))
      expect(back.tables.reduce((s, t) => s + t.foreignKeys.length, 0)).toBe(count((t) => t.foreignKeys.filter((fk) => !fk.virtual).length))
    })
  })

  it('saves nothing when nothing changed, and saves edits that read back as edited', () => {
    const viaDbml = (tables: TableInfo[]) => parseDbml(toDbml(tables)).tables
    find(root!).forEach((file, n) => {
      const folder = /\.dezproj$/i.test(file)
      const project: DezignFile[] = folder ? projectFiles(join(file, '..')) : [{ path: 'model.dez', text: readFileSync(file, 'latin1') }]
      const read = (files: DezignFile[]) => readDezign(folder ? assembleDezignProject(files) : files[0]!.text)
      const base = viaDbml(read(project).tables)
      const same = saveToDezign(project, base, viaDbml(read(project).tables), { normalize: viaDbml })
      expect(same.files.length + same.deleted.length + same.changes.length).toBe(0)

      // A typical editing session: rename, add, drop, retype, comment, a new table with a relationship, a dropped table.
      const edited = viaDbml(read(project).tables)
      const first = edited.find((t) => t.columns.length > 2 && t.primaryKey.length === 1) ?? edited.find((t) => t.primaryKey.length === 1)
      if (!first) return report(`#${n + 1} no table with a single-column key: edits skipped`)
      const victim = edited.filter((t) => t !== first).at(-1)
      const loose = first.columns.filter((c) => !c.isPrimaryKey && !edited.some((t) => t.foreignKeys.some((f) => (t === first && f.columns.includes(c.name)) || (f.refTable === first.name && f.refColumns.includes(c.name)))) && !first.indexes.some((ix) => ix.columns.includes(c.name)))
      if (loose[0]) loose[0].name = 'dbm_renamed'
      if (loose[1]) first.columns.splice(first.columns.indexOf(loose[1]), 1)
      first.columns.push({ name: 'dbm_added', ordinal: first.columns.length + 1, dataType: 'varchar(40)', nullable: false, defaultValue: "'x'", isPrimaryKey: false, isIdentity: false, comment: 'Přidáno & <ověřeno>' })
      first.comment = 'Upravená tabulka'
      const pk = first.columns.find((c) => c.isPrimaryKey)!
      edited.push({ schema: first.schema, name: 'dbm_new_table', type: 'table', comment: null, columns: [{ name: 'id', ordinal: 1, dataType: 'bigint', nullable: false, isPrimaryKey: true, isIdentity: false }, { name: 'parent_id', ordinal: 2, dataType: pk.dataType, nullable: true, isPrimaryKey: false, isIdentity: false }], primaryKey: ['id'], foreignKeys: [{ name: 'fk', columns: ['parent_id'], refSchema: first.schema, refTable: first.name, refColumns: [pk.name], onDelete: 'CASCADE' }], indexes: [{ name: 'ix', columns: ['parent_id'], unique: false, primary: false }] })
      const kept = victim && edited.length > 3 ? edited.filter((t) => t !== victim).map((t) => ({ ...t, foreignKeys: t.foreignKeys.filter((f) => f.refTable !== victim.name) })) : edited
      const target = viaDbml(kept)
      const saved = saveToDezign(project, base, target, { normalize: viaDbml })
      const after = viaDbml(read(applyDezignSave(project, saved)).tables)
      const kinds = saved.changes.reduce<Record<string, number>>((all, c) => ({ ...all, [c.kind]: (all[c.kind] ?? 0) + 1 }), {})
      report(`#${n + 1} ${folder ? 'folder' : 'file'} written=${saved.files.length} deleted=${saved.deleted.length} changes=${JSON.stringify(kinds)}`)
      expect(after.length).toBe(target.length)
      expect(after.some((t) => t.name === 'dbm_new_table' && t.foreignKeys.length === 1 && t.indexes.filter((ix) => !ix.primary).length === 1)).toBe(true)
      expect(after.find((t) => t.name === first.name)!.columns.map((c) => c.name)).toEqual(target.find((t) => t.name === first.name)!.columns.map((c) => c.name))
      // Saving the saved project again changes nothing.
      const again = saveToDezign(applyDezignSave(project, saved), target, viaDbml(after), { normalize: viaDbml })
      expect(again.files.length + again.deleted.length + again.changes.length).toBe(0)
    })
  })

  it('survives chains of random edits without breaking a reference', { timeout: 600_000 }, () => {
    const viaDbml = (tables: TableInfo[]) => parseDbml(toDbml(tables)).tables
    find(root!).forEach((file, n) => {
      const folder = /\.dezproj$/i.test(file)
      const start: DezignFile[] = folder ? projectFiles(join(file, '..')) : [{ path: 'model.dez', text: readFileSync(file, 'latin1') }]
      const binary = (files: DezignFile[]) => (folder ? assembleDezignProject(files) : files[0]!.text)
      const read = (files: DezignFile[]) => viaDbml(readDezign(binary(files)).tables)
      // What the file had wrong before anybody touched it is not the writer's doing.
      const known = new Set(dezignIntegrity(binary(start)))
      const ops: Record<string, number> = {}
      let failed = ''
      for (let seed = 1; seed <= (Number(process.env.DBM_FUZZ_CHAINS) || 3) && !failed; seed++) {
        const rnd = random(seed * 7919 + n)
        let files = start
        for (let step = 0; step < 5; step++) {
          const base = read(files)
          const edited = read(files)
          const op = mutate(edited, rnd, seed * 100 + step)
          try {
            const saved = saveToDezign(files, base, viaDbml(edited), { normalize: viaDbml })
            files = applyDezignSave(files, saved)
            const broken = dezignIntegrity(binary(files)).filter((p) => !known.has(p))
            if (broken.length) throw new Error(`${broken.length} broken references`)
            const again = saveToDezign(files, read(files), read(files), { normalize: viaDbml })
            if (again.files.length + again.deleted.length + again.changes.length) throw new Error('a second save changed something')
            ops[op] = (ops[op] ?? 0) + 1
          } catch (err) {
            // Only the kind of edit and the kind of failure: no names from the model.
            failed = `seed ${seed} step ${step} ${op}: ${(err instanceof Error ? err.message : String(err)).replace(/"[^"]*"/g, '"…"').slice(0, 120)}`
            break
          }
        }
      }
      report(`#${n + 1} ${folder ? 'folder' : 'file'} random edits=${Object.values(ops).reduce((a, b) => a + b, 0)} known problems=${known.size} ${failed ? `FAILED ${failed}` : 'ok'}`)
      expect(failed).toBe('')
    })
  })

  it('survives chains that mix model and diagram edits', { timeout: 900_000 }, () => {
    const viaDbml = (tables: TableInfo[]) => parseDbml(toDbml(tables)).tables
    const chains = Number(process.env.DBM_FUZZ_CHAINS) || 3
    find(root!).forEach((file, n) => {
      const folder = /\.dezproj$/i.test(file)
      const start: DezignFile[] = folder ? projectFiles(join(file, '..')) : [{ path: 'model.dez', text: readFileSync(file, 'latin1') }]
      const binary = (files: DezignFile[]) => (folder ? assembleDezignProject(files) : files[0]!.text)
      const read = (files: DezignFile[]) => viaDbml(readDezign(binary(files)).tables)
      const known = new Set(dezignIntegrity(binary(start)))
      let edits = 0
      let failed = ''
      for (let seed = 1; seed <= chains && !failed; seed++) {
        const rnd = random(seed * 104729 + n)
        let files = start
        for (let step = 0; step < 5; step++) {
          const base = read(files)
          const edited = read(files)
          const ops = [rnd() < 0.7 ? mutate(edited, rnd, seed * 100 + step) : 'nothing']
          const target = viaDbml(edited)
          const wanted = diagramsAsLoaded(readDezign(binary(files)))
          const keys = target.map((t) => `${t.schema ?? ''}.${t.name}`)
          for (const w of Object.values(wanted)) if (w.tables) w.tables = w.tables.filter((k) => keys.includes(k))
          if (rnd() < 0.7) ops.push(mutateDiagrams(wanted, keys, rnd, seed * 100 + step))
          try {
            const saved = saveToDezign(files, base, target, { normalize: viaDbml, diagrams: wanted })
            files = applyDezignSave(files, saved)
            const broken = dezignIntegrity(binary(files)).filter((p) => !known.has(p))
            if (broken.length) throw new Error(`${broken.length} broken references`)
            const again = saveToDezign(files, read(files), read(files), { normalize: viaDbml, diagrams: diagramsAsLoaded(readDezign(binary(files))) })
            if (again.changes.length) throw new Error(`a second save changed something (${again.changes.map((c) => c.kind).join(',')})`)
            edits++
          } catch (err) {
            failed = `seed ${seed} step ${step} ${ops.join('+')}: ${(err instanceof Error ? err.message : String(err)).replace(/"[^"]*"/g, '"…"').slice(0, 140)}`
            break
          }
        }
      }
      report(`#${n + 1} ${folder ? 'folder' : 'file'} mixed edits=${edits} ${failed ? `FAILED ${failed}` : 'ok'}`)
      expect(failed).toBe('')
    })
  })
})

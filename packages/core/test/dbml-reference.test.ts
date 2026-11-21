import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDbml } from '../src/index.js'

/**
 * Our DBML reader against the reference implementation (dbdiagram.io's own parser, @dbml/core) on public .dbml files
 * from GitHub: per file, the counts of tables, columns, primary key columns, references, indexes, enums and notes
 * must be the same, or our reader must say what it did not take (an error line), never lose it silently.
 * Collect the files with `node scripts/model-samples.mjs <folder> dbml`; run with DBM_MODEL_SAMPLES=<folder> and
 * DBM_DBML_REFERENCE=1 (installs the pinned @dbml/core into a temp folder, or into DBM_DBML_REFERENCE_DIR).
 * Prints counts only.
 */
const folder = process.env.DBM_MODEL_SAMPLES
const run = !!folder && process.env.DBM_DBML_REFERENCE === '1'
const PINNED = '11.1.0'

interface Counts {
  tables: number
  columns: number
  primaryKey: number
  references: number
  indexes: number
  enums: number
  notes: number
}
const KEYS: (keyof Counts)[] = ['tables', 'columns', 'primaryKey', 'references', 'indexes', 'enums', 'notes']

interface RefField {
  name: string
  pk?: boolean
  note?: string | null
}
interface RefTable {
  name: string
  fields: RefField[]
  indexes: { pk?: boolean; columns: unknown[] }[]
  note?: string | null
}
interface RefDatabase {
  schemas: { tables: RefTable[]; refs: unknown[]; enums: unknown[] }[]
}

function referenceParser(): (text: string) => RefDatabase {
  const dir = process.env.DBM_DBML_REFERENCE_DIR ?? mkdtempSync(join(tmpdir(), 'dbm-dbml-ref-'))
  if (!existsSync(join(dir, 'node_modules', '@dbml', 'core', 'package.json'))) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dbm-dbml-reference', private: true }))
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', `@dbml/core@${PINNED}`], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' })
  }
  const { Parser } = createRequire(join(dir, 'package.json'))('@dbml/core') as { Parser: { parse(text: string, format: string): RefDatabase } }
  return (text) => Parser.parse(text, 'dbmlv2')
}

function referenceCounts(db: RefDatabase): Counts {
  const tables = db.schemas.flatMap((s) => s.tables)
  return {
    tables: tables.length,
    columns: tables.reduce((n, t) => n + t.fields.length, 0),
    primaryKey: tables.reduce((n, t) => n + (t.indexes.find((i) => i.pk)?.columns.length ?? t.fields.filter((f) => f.pk).length), 0),
    references: db.schemas.reduce((n, s) => n + s.refs.length, 0),
    indexes: tables.reduce((n, t) => n + t.indexes.filter((i) => !i.pk).length, 0),
    enums: db.schemas.reduce((n, s) => n + s.enums.length, 0),
    notes: tables.reduce((n, t) => n + (t.note ? 1 : 0) + t.fields.filter((f) => f.note).length, 0),
  }
}

function ourCounts(text: string): { counts: Counts; errors: number } {
  const model = parseDbml(text)
  const tables = model.tables
  // A column's `unique` setting is an index for us, a column setting for DBML: only `indexes` blocks count.
  const blockIndexes = (t: (typeof tables)[number]) => t.indexes.filter((i) => !i.primary && !(i.constraint && i.columns.length === 1 && i.name === `ux_${t.name}_${i.columns[0]}`))
  return {
    counts: {
      tables: tables.length,
      columns: tables.reduce((n, t) => n + t.columns.length, 0),
      primaryKey: tables.reduce((n, t) => n + t.primaryKey.length, 0),
      references: tables.reduce((n, t) => n + t.foreignKeys.length, 0),
      indexes: tables.reduce((n, t) => n + blockIndexes(t).length, 0),
      enums: Object.keys(model.enums).length,
      notes: tables.reduce((n, t) => n + (t.comment ? 1 : 0) + t.columns.filter((c) => c.comment).length, 0),
    },
    errors: model.errors.length,
  }
}

describe.skipIf(!run)('DBML: our reader against @dbml/core on public files', () => {
  it('reads what the reference reads, or says what it did not take', { timeout: 600_000 }, () => {
    const parse = referenceParser()
    const files = readdirSync(join(folder!, 'dbml')).map((f) => join(folder!, 'dbml', f))
    let compared = 0
    let referenceRefused = 0
    const totals = { reference: Object.fromEntries(KEYS.map((k) => [k, 0])) as Record<keyof Counts, number>, ours: Object.fromEntries(KEYS.map((k) => [k, 0])) as Record<keyof Counts, number> }
    const differing: string[] = []
    const silent: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      let reference: Counts
      try {
        reference = referenceCounts(parse(text))
      } catch {
        // Not valid DBML for dbdiagram.io either: nothing to compare with.
        referenceRefused++
        continue
      }
      compared++
      const ours = ourCounts(text)
      for (const k of KEYS) {
        totals.reference[k] += reference[k]
        totals.ours[k] += ours.counts[k]
      }
      const diff = KEYS.filter((k) => reference[k] !== ours.counts[k])
      if (!diff.length) continue
      const line = `${file.split('/').pop()}: ${diff.map((k) => `${k} ${ours.counts[k]}/${reference[k]}`).join(', ')}`
      differing.push(line)
      // Fewer than the reference with no error line: lost silently.
      if (diff.some((k) => ours.counts[k] < reference[k]) && !ours.errors) silent.push(line)
    }
    console.log(`DBML: ${compared} files compared (${referenceRefused} refused by @dbml/core too), ${differing.length} differ, ${silent.length} silently`)
    console.log(`totals ours/reference: ${KEYS.map((k) => `${k} ${totals.ours[k]}/${totals.reference[k]}`).join(', ')}`)
    for (const line of differing) console.log(`  ${line}`)
    expect(compared).toBeGreaterThanOrEqual(50)
    // A file may differ where our reader says why (an error line: many-to-many, which the model has no key for).
    expect(silent).toEqual([])
  })
})

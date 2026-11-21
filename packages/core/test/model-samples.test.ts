import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compareSchemas, parseDbml, readModelFile, tablesFromDdl, toDbml, type TableInfo } from '../src/index.js'

/**
 * The imports of other tools' models on real files (docs/specs/launch.md, A2): public drawDB exports and Mermaid ER
 * diagrams from GitHub must open without an error and without losing a table, and MySQL's Sakila read from its
 * Workbench model must compare as the same as Sakila read from its SQL script. Collect the files with
 * `node scripts/model-samples.mjs <folder>`, then run with DBM_MODEL_SAMPLES=<folder>. Prints counts only.
 */
const folder = process.env.DBM_MODEL_SAMPLES
const files = (kind: string) => {
  try {
    return readdirSync(join(folder!, kind)).map((f) => join(folder!, kind, f))
  } catch {
    return []
  }
}

/** The model goes into a tab as DBML: it must read back with every table. */
function throughDbml(tables: TableInfo[], enums: Record<string, string[]>) {
  const back = parseDbml(toDbml(tables, { enums }))
  return { errors: back.errors.length, tables: back.tables.length }
}

describe.skipIf(!folder)('models of other tools, real files', () => {
  it('opens every drawDB export with all its tables', () => {
    const list = files('drawdb')
    let tables = 0
    let relationships = 0
    const failed: string[] = []
    for (const file of list) {
      const text = readFileSync(file, 'utf8')
      const source = JSON.parse(text) as { tables: unknown[] }
      try {
        const model = readModelFile(file, new TextEncoder().encode(text))
        const dbml = throughDbml(model.tables, model.enums)
        if (model.tables.length !== source.tables.length || dbml.errors || dbml.tables !== source.tables.length) failed.push(`${file.split('/').pop()}: ${model.tables.length}/${source.tables.length} tables, ${dbml.errors} DBML errors`)
        tables += model.tables.length
        relationships += model.tables.reduce((n, t) => n + t.foreignKeys.length, 0)
      } catch (err) {
        failed.push(`${file.split('/').pop()}: ${(err as Error).message}`)
      }
    }
    console.log(`drawDB: ${list.length - failed.length}/${list.length} files, ${tables} tables, ${relationships} relationships`)
    expect(failed).toEqual([])
  })

  it('opens every Mermaid ER diagram with all its entities', () => {
    const list = files('mermaid')
    let tables = 0
    let relationships = 0
    const leftOut: Record<string, number> = {}
    const failed: string[] = []
    for (const file of list) {
      const text = readFileSync(file, 'utf8')
      // The entities a diagram names, counted apart from the reader: attribute blocks and both ends of relationships.
      const entity = String.raw`"[^"]+"|[A-Za-z_][\w-]*`
      const names = new Set<string>()
      const body = text.slice(text.search(/\berDiagram\b/))
      for (const m of body.matchAll(new RegExp(`^\\s*(${entity})(?:\\[[^\\]]*\\])?\\s*\\{`, 'gm'))) names.add(m[1]!.replace(/"/g, ''))
      for (const m of body.matchAll(new RegExp(`^\\s*(${entity})(?:\\[[^\\]]*\\])?\\s*[|}][|o](?:--|\\.\\.)[o|][|{]\\s*(${entity})`, 'gm'))) names.add(m[1]!.replace(/"/g, '')).add(m[2]!.replace(/"/g, ''))
      try {
        const model = readModelFile(file, new TextEncoder().encode(text))
        const missing = [...names].filter((n) => !model.tables.some((t) => t.name === n))
        const dbml = throughDbml(model.tables, model.enums)
        if (missing.length || dbml.errors || dbml.tables !== model.tables.length) failed.push(`${file.split('/').pop()}: ${missing.length} entities missing, ${dbml.errors} DBML errors`)
        tables += model.tables.length
        relationships += model.tables.reduce((n, t) => n + t.foreignKeys.length, 0)
        for (const [k, v] of Object.entries(model.leftOut)) leftOut[k] = (leftOut[k] ?? 0) + (v ?? 0)
      } catch (err) {
        failed.push(`${file.split('/').pop()}: ${(err as Error).message}`)
      }
    }
    console.log(`Mermaid: ${list.length - failed.length}/${list.length} files, ${tables} tables, ${relationships} relationships, left out ${JSON.stringify(leftOut)}`)
    expect(failed).toEqual([])
  })

  it('reads Sakila from its Workbench model as its SQL script declares it', async () => {
    const dir = join(folder!, 'sakila')
    const mwb = readModelFile('sakila.mwb', readFileSync(join(dir, 'sakila.mwb')))
    // The model holds Sakila and MySQL's two world samples; the script is Sakila alone, without a schema.
    const plain = (tables: TableInfo[]) => tables.map((t) => ({ ...t, schema: undefined, foreignKeys: t.foreignKeys.map((f) => ({ ...f, refSchema: undefined })) }))
    const fromModel = plain(mwb.tables.filter((t) => t.schema === 'sakila'))
    const script = await tablesFromDdl(readFileSync(join(dir, 'sakila-schema.sql'), 'utf8'))
    const fromScript = plain(script.tables.filter((t) => t.type === 'table'))
    console.log(`Sakila: ${mwb.tables.length} tables in the model (${fromModel.length} of sakila), ${fromScript.length} in the script, ${script.skipped.length} script statements skipped (views DuckDB can't run); left out of the model: ${JSON.stringify(mwb.leftOut)}; ${Object.keys(mwb.positions).length} positions, ${mwb.diagrams.length} more diagrams`)
    expect(fromModel.map((t) => t.name).sort()).toEqual(fromScript.map((t) => t.name).sort())
    const changes = compareSchemas(fromModel, fromScript, { model: true, driver: 'mysql' })
    // UNSIGNED, BOOLEAN DEFAULT TRUE ≡ tinyint(1) DEFAULT 1 and the index MySQL makes for a foreign key compare as
    // the same now. What remains is a difference of the two files themselves: Workbench's film_text.film_id has no
    // UNSIGNED flag, the script's has.
    console.log(`Sakila differences: ${changes.length}`)
    expect(changes).toEqual([expect.objectContaining({ kind: 'alter_column', table: { name: 'film_text' }, column: 'film_id', before: expect.objectContaining({ dataType: 'smallint unsigned' }), after: expect.objectContaining({ dataType: 'smallint' }) })])
  })
})

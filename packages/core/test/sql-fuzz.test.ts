import { describe, expect, it } from 'vitest'
import { compareSchemas, generateMigration, getDialect, migrationScript, parseDbml, readModelFile, splitStatements, stripLiterals, toDbml, type DriverId, type TableInfo } from '../src/index.js'
import { asDrawDb, asMermaid, asWorkbench, sqlFuzzModel } from './sql-fuzz.js'

const DIALECTS: DriverId[] = ['postgres', 'mysql', 'mariadb', 'mssql', 'sqlite', 'oracle', 'duckdb']
const SEEDS = 300
const WRAPPERS = /^(BEGIN( TRANSACTION)?|COMMIT( TRANSACTION)?|SET XACT_ABORT ON)$/i
const VERBS = /^(CREATE (UNIQUE )?INDEX|CREATE TABLE|CREATE SEQUENCE|ALTER TABLE|COMMENT ON (TABLE|COLUMN)|EXEC sys\.sp_addextendedproperty|DECLARE @|IF @)/i

/** The model through each path a stranger's file can take into the app. */
function paths(seed: number, d: DriverId): [string, TableInfo[]][] {
  const tables = sqlFuzzModel(seed, d)
  return [
    ['model', tables],
    ['DBML', parseDbml(toDbml(tables)).tables],
    ['drawDB', readModelFile('m.json', asDrawDb(tables, d === 'mssql' ? 'mssql' : d === 'sqlite' ? 'sqlite' : d === 'postgres' ? 'postgresql' : 'mysql')).tables],
    ['Workbench', readModelFile('m.mwb', asWorkbench(tables)).tables],
    ['Mermaid', readModelFile('m.mmd', asMermaid(tables)).tables],
  ]
}

describe('hostile SQL in models, through every reader, for every dialect (review N1)', () => {
  it('scripts are exactly the statements generated for the model: nothing more, nothing swallowed', { timeout: 300_000 }, () => {
    let scripts = 0
    const problems: string[] = []
    const start = performance.now()
    for (let seed = 0; seed < SEEDS; seed++) {
      for (const d of DIALECTS) {
        for (const [path, tables] of paths(seed, d)) {
          const migration = generateMigration(compareSchemas(tables, [], { keepExtra: true, model: true }), getDialect(d))
          const script = migrationScript(migration, getDialect(d))
          scripts++
          const split = splitStatements(script, d)
            .map((s) => s.text.replace(/^(\s*--[^\n]*\n)+/, '').trim())
            .filter((s) => s && !WRAPPERS.test(s))
          const where = `seed ${seed} ${d} ${path}`
          // The DECLARE … IF pairs of SQL Server are one statement of the migration, two to the splitter.
          const expected = migration.statements.flatMap((s) => (d === 'mssql' && /^\s*DECLARE\s+@/i.test(s) ? splitStatements(s, d).map((x) => x.text) : [s.trim()]))
          if (split.length !== expected.length) problems.push(`${where}: ${split.length} statements, ${expected.length} made`)
          const tablesMade = split.filter((s) => /^CREATE TABLE/i.test(s)).length
          if (tablesMade !== tables.length) problems.push(`${where}: ${tablesMade} CREATE TABLE for ${tables.length} tables`)
          for (const s of split) {
            if (!VERBS.test(s)) problems.push(`${where}: a statement starts ${JSON.stringify(s.slice(0, 40))}`)
            // From another tool's file only plain SQL comes in: the attack's words never reach code there. (A model's
            // own SQL is SQL by design: there the statements above are the guarantee.)
            const code = stripLiterals(s, d)
            if (path !== 'model' && path !== 'DBML' && /\bcanary\b|\bTABLE\s+z\b/i.test(code)) problems.push(`${where}: ${JSON.stringify(s.slice(0, 160))}`)
          }
          if (problems.length > 20) break
        }
      }
    }
    console.log(`SQL fuzz: ${scripts} scripts (${SEEDS} seeds × ${DIALECTS.length} dialects × 5 paths) in ${Math.round(performance.now() - start)} ms`)
    expect(problems.slice(0, 20)).toEqual([])
  })
})

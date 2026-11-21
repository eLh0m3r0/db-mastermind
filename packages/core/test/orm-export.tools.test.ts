import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { codeFormatsFor, exportCode, type CodeFormat } from '../src/index.js'
import { ormCases, type OrmCase } from './orm-models.js'

/**
 * The generated code checked by the tools themselves (rule 4 of docs/specs/launch.md): `prisma validate`, `tsc
 * --strict` against the real drizzle-orm (and the module loaded by Node), SQLAlchemy importing the models and
 * creating them on SQLite, with the DDL compiled for PostgreSQL and the model's own database.
 *
 * DBM_ORM_TOOLS=1 runs it. The tools are installed (pinned) into a temp folder, or into DBM_ORM_TOOLS_DIR, which is
 * kept between runs. Needs npm and python3 (3.9 or later) with venv.
 */
const run = process.env.DBM_ORM_TOOLS === '1'
const PINNED = { prisma: '7.10.1', 'drizzle-orm': '0.45.4', typescript: '7.0.2', sqlalchemy: '2.0.55' }
const dir = process.env.DBM_ORM_TOOLS_DIR ?? mkdtempSync(join(tmpdir(), 'dbm-orm-tools-'))
const work = mkdtempSync(join(tmpdir(), 'dbm-orm-out-'))
const bin = (name: string) => join(dir, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name)
const python = join(dir, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python')

function sh(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): { ok: boolean; output: string } {
  const r = spawnSync(command, args, { cwd: options.cwd ?? dir, env: { ...process.env, ...options.env }, encoding: 'utf8', shell: process.platform === 'win32' })
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const fileOf = (c: OrmCase, format: CodeFormat) => `${c.database}-${c.name}.${format === 'prisma' ? 'prisma' : format === 'sqlalchemy' ? 'py' : 'ts'}`

// SQLite has no schemas: each one the models name is attached as its own in-memory database.
const PY_CHECK = `
import importlib.util, sys
from sqlalchemy import create_engine, event
from sqlalchemy.schema import CreateTable, CreateIndex
from sqlalchemy.dialects import postgresql, mysql, mssql, sqlite, oracle

path, own = sys.argv[1], sys.argv[2]
spec = importlib.util.spec_from_file_location("models", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
metadata = module.Base.metadata
engine = create_engine("sqlite://")
schemas = {t.schema for t in metadata.tables.values() if t.schema}

@event.listens_for(engine, "connect")
def attach(dbapi, record):
    for s in schemas:
        dbapi.execute(f"ATTACH DATABASE ':memory:' AS \\"{s}\\"")

metadata.create_all(engine)
dialects = {"postgresql": postgresql.dialect(), "mysql": mysql.dialect(), "mssql": mssql.dialect(), "sqlite": sqlite.dialect(), "oracle": oracle.dialect()}
for name in {"postgresql", own}:
    if name not in dialects:
        continue
    for table in metadata.sorted_tables:
        str(CreateTable(table).compile(dialect=dialects[name]))
        for index in table.indexes:
            str(CreateIndex(index).compile(dialect=dialects[name]))
print(len(metadata.tables), "tables")
`
const SA_DIALECT: Record<string, string> = { postgres: 'postgresql', cockroachdb: 'postgresql', mysql: 'mysql', mariadb: 'mysql', mssql: 'mssql', sqlite: 'sqlite', oracle: 'oracle' }

describe.skipIf(!run)('generated code against the real tools', () => {
  let cases: OrmCase[] = []
  beforeAll(async () => {
    cases = await ormCases()
    if (!existsSync(join(dir, 'node_modules', 'drizzle-orm', 'package.json')) || !existsSync(bin('prisma')) || !existsSync(bin('tsc'))) {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dbm-orm-tools', private: true, type: 'module' }))
      execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', `prisma@${PINNED.prisma}`, `drizzle-orm@${PINNED['drizzle-orm']}`, `typescript@${PINNED.typescript}`], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' })
    }
    if (!existsSync(python)) {
      execFileSync('python3', ['-m', 'venv', join(dir, 'venv')], { stdio: 'inherit' })
      execFileSync(python, ['-m', 'pip', 'install', '--quiet', `sqlalchemy==${PINNED.sqlalchemy}`], { stdio: 'inherit' })
    }
    writeFileSync(join(dir, 'check_models.py'), PY_CHECK)
    // The generated TypeScript is compiled where drizzle-orm can be found, as an ES module.
    mkdirSync(join(dir, 'gen'), { recursive: true })
    writeFileSync(join(dir, 'gen', 'package.json'), JSON.stringify({ type: 'module' }))
  }, 600_000)

  it('Prisma validates every schema', () => {
    const failures: string[] = []
    let n = 0
    for (const c of cases.filter((x) => codeFormatsFor(x.database).includes('prisma'))) {
      const file = join(work, fileOf(c, 'prisma'))
      writeFileSync(file, exportCode('prisma', c.tables, { database: c.database, enums: c.enums }))
      const r = sh(bin('prisma'), ['validate', '--schema', file])
      n++
      if (!r.ok) failures.push(`${file}\n${r.output.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 4000)}`)
    }
    console.log(`prisma validate: ${n - failures.length}/${n} schemas valid`)
    expect(failures).toEqual([])
  }, 600_000)

  it('tsc --strict compiles every Drizzle schema and the TypeScript types, and Node loads the Drizzle tables', () => {
    const files: string[] = []
    for (const c of cases) {
      for (const format of ['drizzle', 'typescript'] as const) {
        if (!codeFormatsFor(c.database).includes(format)) continue
        const file = join(dir, 'gen', `${format}-${fileOf(c, format)}`)
        writeFileSync(file, exportCode(format, c.tables, { database: c.database, enums: c.enums }))
        files.push(file)
      }
    }
    const r = sh(bin('tsc'), ['--strict', '--noEmitOnError', '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--skipLibCheck', '--outDir', join(dir, 'gen', 'out'), ...files])
    console.log(`tsc --strict: ${files.length} files, ${r.ok ? 'no errors' : 'errors'}`)
    expect(r.ok, r.output.slice(0, 8000)).toBe(true)
    // Each table's extra config (keys, indexes, foreign keys) is built when the config is asked for.
    const load = files
      .filter((f) => /[\\/]drizzle-/.test(f))
      .map((f) => {
        const js = join(dir, 'gen', 'out', f.split(/[\\/]/).pop()!.replace(/\.ts$/, '.js'))
        const core = /-(mysql|mariadb)-/.test(f) ? 'mysql-core' : /-sqlite-/.test(f) ? 'sqlite-core' : 'pg-core'
        return `{ const m = await import(${JSON.stringify(`file://${js.replace(/\\/g, '/')}`)}); const c = await import('drizzle-orm/${core}'); for (const v of Object.values(m)) { if (is(v, Table)) { const cfg = c.getTableConfig(v); for (const fk of cfg.foreignKeys) fk.reference(); n++ } } }`
      })
    const script = join(dir, 'gen', 'load.mjs')
    writeFileSync(script, `import { is, Table } from 'drizzle-orm'\nlet n = 0\n${load.join('\n')}\nconsole.log(n + ' tables')\n`)
    const loaded = sh('node', [script], { cwd: join(dir, 'gen') })
    console.log(`node: ${loaded.output.trim()}`)
    expect(loaded.ok, loaded.output.slice(0, 4000)).toBe(true)
  }, 600_000)

  it('SQLAlchemy imports every module, creates it on SQLite and compiles the DDL', () => {
    const failures: string[] = []
    let n = 0
    for (const c of cases) {
      const file = join(work, fileOf(c, 'sqlalchemy').replace(/-/g, '_'))
      writeFileSync(file, exportCode('sqlalchemy', c.tables, { database: c.database, enums: c.enums }))
      const r = sh(python, ['-I', join(dir, 'check_models.py'), file, SA_DIALECT[c.database] ?? 'postgresql'])
      n++
      if (!r.ok) failures.push(`${file}\n${r.output.slice(-3000)}`)
    }
    console.log(`SQLAlchemy: ${n - failures.length}/${n} modules created`)
    expect(failures).toEqual([])
  }, 600_000)
})

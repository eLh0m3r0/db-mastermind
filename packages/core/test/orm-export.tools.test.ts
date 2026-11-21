import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { codeFormatsFor, exportCode, type CodeFormat } from '../src/index.js'
import { ormCases, type OrmCase } from './orm-models.js'
import { FUZZ_DATABASES, fuzzModel } from './orm-fuzz.js'
import { prismaShape } from './orm-structure.js'

/**
 * The generated code checked by the tools themselves (rule 4 of docs/specs/launch.md): `prisma validate`, `tsc
 * --strict` against the real drizzle-orm (and the module loaded by Node), SQLAlchemy importing the models and
 * creating them on SQLite, with the DDL compiled for PostgreSQL and the model's own database.
 *
 * DBM_ORM_TOOLS=1 runs it. The tools are installed (pinned) into a temp folder, or into DBM_ORM_TOOLS_DIR, which is
 * kept between runs. Needs npm and python3 (3.9 or later) with venv.
 */
const run = process.env.DBM_ORM_TOOLS === '1'
// The TypeScript 5 compiler API, loaded from the tools folder (the repository's TypeScript 7 has none): typed loosely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TsApi = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TsNode = any
const PINNED = { prisma: '7.10.1', 'drizzle-orm': '0.45.4', typescript: '7.0.2', ts5: '5.9.3', sqlalchemy: '2.0.55' }
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
    if (!existsSync(join(dir, 'node_modules', 'drizzle-orm', 'package.json')) || !existsSync(bin('prisma')) || !existsSync(bin('tsc')) || !existsSync(join(dir, 'node_modules', 'ts5', 'package.json'))) {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dbm-orm-tools', private: true, type: 'module' }))
      // TypeScript 7 is the compiler; 5.9 brings the compiler API the fuzz parses with.
      execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', `prisma@${PINNED.prisma}`, `drizzle-orm@${PINNED['drizzle-orm']}`, `typescript@${PINNED.typescript}`, `ts5@npm:typescript@${PINNED.ts5}`], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' })
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

  // Hostile models (orm-fuzz.ts): names, comments, defaults, enum values and types from line terminators, quotes,
  // comment openers, NUL, bidi overrides and confusables. The real parsers must find exactly our declarations.
  const SEEDS = 300
  it('hostile models: TypeScript and Drizzle declare only our imports and exports and call only our builders', () => {
    const ts = createRequire(join(dir, 'package.json'))('ts5') as TsApi
    const allowed = new Set(['pgTable', 'mysqlTable', 'sqliteTable', 'pgEnum', 'pgSchema', 'mysqlSchema', 'mysqlEnum', 'customType', 'table', 'enum', 'primaryKey', 'foreignKey', 'index', 'uniqueIndex', 'unique', 'on', 'onDelete', 'onUpdate', 'references', 'notNull', 'default', 'defaultNow', 'array', 'generatedByDefaultAsIdentity', 'autoincrement', 'smallint', 'integer', 'bigint', 'serial', 'smallserial', 'bigserial', 'numeric', 'real', 'doublePrecision', 'boolean', 'char', 'varchar', 'text', 'uuid', 'date', 'time', 'timestamp', 'interval', 'json', 'jsonb', 'inet', 'cidr', 'macaddr', 'macaddr8', 'int', 'tinyint', 'mediumint', 'decimal', 'float', 'double', 'datetime', 'year', 'binary', 'varbinary', 'tinytext', 'mediumtext', 'longtext', 'blob'])
    const problems: string[] = []
    let files = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      for (const format of ['drizzle', 'typescript'] as const) {
        for (const database of FUZZ_DATABASES[format]) {
          const model = fuzzModel(seed * 7 + database.length, database)
          const code = exportCode(format, model.tables, { database, enums: model.enums })
          files++
          const source = ts.createSourceFile('x.ts', code, ts.ScriptTarget.ES2022, true)
          const say = (what: string) => problems.push(`seed ${seed} ${format} ${database}: ${what}`)
          if ((source as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length) say('does not parse')
          for (const st of source.statements) {
            const ok = ts.isImportDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st) || (ts.isVariableStatement(st) && st.declarationList.declarations.length === 1)
            if (!ok) say(`top-level ${ts.SyntaxKind[st.kind]}`)
          }
          // Interfaces: one per table; Drizzle: one exported table constant per table.
          const declared = source.statements.filter((st: TsNode) => (format === 'typescript' ? ts.isInterfaceDeclaration(st) : ts.isVariableStatement(st) && /Table\(|\.table\(/.test(st.getText()))).length
          if (declared !== model.tables.length) say(`${declared} tables declared of ${model.tables.length}`)
          // (Constants the file declares itself are called too: an enum, a custom type.)
          const own = new Set(source.statements.flatMap((st: TsNode) => (ts.isVariableStatement(st) ? st.declarationList.declarations.map((d: TsNode) => d.name.getText()) : [])))
          const visit = (node: TsNode) => {
            if (ts.isCallExpression(node)) {
              const callee = node.expression
              const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.SyntaxKind[callee.kind]
              if (!allowed.has(name) && !own.has(name)) say(`calls ${name}`)
            }
            if (ts.isExpressionStatement(node)) say('an expression statement')
            ts.forEachChild(node, visit)
          }
          visit(source)
        }
      }
    }
    console.log(`fuzz TypeScript/Drizzle: ${files} files parsed with the TypeScript ${PINNED.ts5} compiler API`)
    expect(problems.slice(0, 10)).toEqual([])
  }, 600_000)

  it('hostile models: Python finds only our imports, classes and tables, calling only SQLAlchemy', () => {
    const fuzzDir = join(work, 'fuzz-py')
    mkdirSync(fuzzDir, { recursive: true })
    let files = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      for (const database of FUZZ_DATABASES.sqlalchemy) {
        const model = fuzzModel(seed * 7 + database.length, database)
        writeFileSync(join(fuzzDir, `m_${seed}_${database}_${model.tables.length}.py`), exportCode('sqlalchemy', model.tables, { database, enums: model.enums }))
        files++
      }
    }
    writeFileSync(join(dir, 'check_ast.py'), `
import ast, os, sys
ALLOWED = {"Integer","SmallInteger","BigInteger","Numeric","Float","Double","REAL","Boolean","CHAR","String","Unicode","UnicodeText","Text","Uuid","Date","Time","DateTime","Interval","JSON","LargeBinary","Enum","SqlType","with_variant","mapped_column","ForeignKey","ForeignKeyConstraint","UniqueConstraint","PrimaryKeyConstraint","Index","Identity","text","Table","Column","Mapped","Optional",
  "TINYINT","MEDIUMINT","INTEGER","SMALLINT","BIGINT","YEAR","MONEY","NCHAR","TINYTEXT","MEDIUMTEXT","LONGTEXT","TIMESTAMP","DATETIME","DATETIME2","DATETIMEOFFSET","JSONB","BYTEA","TINYBLOB","MEDIUMBLOB","LONGBLOB","INET","CIDR","MACADDR","SET","FLOAT"}
problems = []
for name in sorted(os.listdir(sys.argv[1])):
    tables = int(name.rsplit("_", 1)[1][:-3])
    tree = ast.parse(open(os.path.join(sys.argv[1], name), encoding="utf-8").read())
    declared = 0
    for st in tree.body:
        if isinstance(st, (ast.Import, ast.ImportFrom)):
            continue
        if isinstance(st, ast.ClassDef):
            if st.name != "Base" and st.name != "SqlType":
                declared += 1
            for item in st.body:
                ok = isinstance(item, (ast.AnnAssign, ast.Assign, ast.Pass, ast.FunctionDef)) or (isinstance(item, ast.Expr) and isinstance(item.value, ast.Constant) and isinstance(item.value.value, str) and item is st.body[0])
                if not ok:
                    problems.append(f"{name}: in class {st.name}: {type(item).__name__}")
            continue
        if isinstance(st, ast.Assign) and isinstance(st.value, ast.Call) and getattr(st.value.func, "id", "") == "Table":
            declared += 1
            continue
        problems.append(f"{name}: top level {type(st).__name__}")
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            f = node.func
            fname = f.id if isinstance(f, ast.Name) else f.attr if isinstance(f, ast.Attribute) else type(f).__name__
            if fname not in ALLOWED:
                problems.append(f"{name}: calls {fname}")
    if declared != tables:
        problems.append(f"{name}: {declared} tables declared of {tables}")
print(len(problems))
for p in problems[:10]:
    print(p)
`)
    const r = sh(python, ['-I', join(dir, 'check_ast.py'), fuzzDir])
    console.log(`fuzz SQLAlchemy: ${files} modules parsed with Python's ast, ${r.output.split('\n')[0]} problems`)
    expect(r.ok, r.output).toBe(true)
    expect(r.output.split('\n')[0]).toBe('0')
  }, 600_000)

  it('hostile models: Prisma validates them and finds only our generator, datasource, models and enums', () => {
    const problems: string[] = []
    let files = 0
    let validated = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      for (const database of FUZZ_DATABASES.prisma) {
        const model = fuzzModel(seed * 7 + database.length, database)
        const code = exportCode('prisma', model.tables, { database, enums: model.enums })
        files++
        for (const p of prismaShape(code, model.tables.length)) problems.push(`seed ${seed} ${database}: ${p}`)
        // prisma validate takes about a second a file: every tenth seed, each database.
        if (seed % 10 === 0) {
          const file = join(work, `fuzz-${seed}-${database}.prisma`)
          writeFileSync(file, code)
          const r = sh(bin('prisma'), ['validate', '--schema', file])
          validated++
          if (!r.ok) problems.push(`seed ${seed} ${database}: prisma validate: ${r.output.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l) => /error/i.test(l)).slice(0, 2).join(' | ')}`)
        }
      }
    }
    console.log(`fuzz Prisma: ${files} schemas checked by shape, ${validated} by prisma validate`)
    expect(problems.slice(0, 10)).toEqual([])
  }, 1_200_000)
})

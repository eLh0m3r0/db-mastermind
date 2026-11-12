import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assembleDezignProject, compareSchemas, createScript, DatabaseService, dezignDriver, dezignMigrationOptions, getDialect, parseDbml, readDezign, tablesFromDdl, toDbml, translateTables, unquotedNames, type ConnectionConfig, type DriverId, type TableInfo } from '../src/index.js'

/**
 * Comparing a model with a SQL script (DeZign: "compare model to SQL script"): the script that matters most is a
 * dump of the real database. The model is created in a real database, dumped by the database's own tool
 * (pg_dump, mysqldump, run in its container) and read back: what the comparison finds must be nothing.
 * `DBM_DEZ_SAMPLES=<folder>` adds local DeZign models (counts only).
 */
const skipped = (process.env.DBM_SKIP ?? '').split(',')
const report = (line: string) => (process.env.DBM_DEZ_REPORT ? appendFileSync(process.env.DBM_DEZ_REPORT, `${line}\n`) : undefined)

const SERVERS: Partial<Record<DriverId, ConnectionConfig & { dump: (container: string, database: string) => string[] }>> = {
  postgres: { id: 'dump-pg', name: 'dump', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind', dump: (c, db) => ['exec', c, 'pg_dump', '-U', 'postgres', '--schema-only', '--no-owner', '--no-privileges', db] },
  mysql: { id: 'dump-my', name: 'dump', driver: 'mysql', host: '127.0.0.1', port: 33069, user: 'root', password: 'mastermind', database: 'mastermind', dump: (c, db) => ['exec', '-e', 'MYSQL_PWD=mastermind', c, 'mysqldump', '-uroot', '--no-data', '--skip-comments', db] },
}

/** The container that publishes the server's port (compose locally, a service container in CI). */
function containerFor(port: number): string | undefined {
  try {
    return execFileSync('docker', ['ps', '--filter', `publish=${port}`, '--format', '{{.Names}}'], { encoding: 'utf8' }).trim().split('\n')[0] || undefined
  } catch {
    return undefined
  }
}

const viaDbml = (tables: TableInfo[]) => parseDbml(toDbml(tables)).tables

const SHOP = viaDbml(
  parseDbml(
    "Table shop.customer {\n  id integer [pk, increment]\n  email varchar(120) [not null, unique, note: 'Login (it''s unique); DATETIME and [x] are words here']\n  credit numeric(12,2) [default: 0]\n  status varchar(10) [not null, default: 'new']\n  born date\n  created timestamp [not null, default: `now()`]\n  Note: 'Zákazník'\n}\nTable shop.invoice {\n  id bigint [pk, increment]\n  customer_id integer [not null, ref: > shop.customer.id]\n  parent_id bigint [ref: > shop.invoice.id]\n  total numeric(12,2) [not null]\n  note text\n  issued timestamp\n\n  indexes {\n    customer_id [name: 'ix_invoice_customer']\n    (customer_id, issued) [unique, name: 'ux_invoice_customer_issued']\n  }\n}\nTable shop.payment {\n  invoice_id bigint [pk, ref: > shop.invoice.id]\n  line smallint [pk]\n  amount numeric(12,2) [not null]\n}\n",
  ).tables,
)

function localModels(): { label: string; tables: TableInfo[]; driver: DriverId; scripting?: ReturnType<typeof readDezign>['scripting'] }[] {
  const root = process.env.DBM_DEZ_SAMPLES
  if (!root) return []
  const found: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) {
        if (name.toLowerCase() !== 'archived versions') walk(path)
      } else if (/\.dezproj$/i.test(name) || /\.dez$/i.test(name)) found.push(path)
    }
  }
  walk(root)
  return found.map((file, n) => {
    const files = (dir: string, out: { path: string; text: string }[] = [], base = dir) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) {
          if (name.toLowerCase() !== 'archived versions') files(path, out, base)
        } else out.push({ path: relative(base, path), text: readFileSync(path, 'latin1') })
      }
      return out
    }
    const model = readDezign(/\.dezproj$/i.test(file) ? assembleDezignProject(files(join(file, '..'))) : readFileSync(file, 'latin1'))
    return { label: `#${n + 1}`, tables: viaDbml(model.tables).map((t) => ({ ...t, foreignKeys: t.foreignKeys.filter((f) => !f.virtual) })), driver: dezignDriver(model.targetDatabase) ?? 'postgres', scripting: model.scripting }
  })
}

for (const driver of ['postgres', 'mysql'] as const) {
  const server = SERVERS[driver]!
  const container = skipped.includes(driver) ? undefined : containerFor(server.port!)
  describe.skipIf(!container)(`a ${driver} dump of the model's database reads back as the model`, () => {
    it('finds no difference between the model and the dump', { timeout: 600_000 }, async () => {
      const svc = new DatabaseService()
      const models = [{ label: 'shop', tables: SHOP, driver: 'postgres' as DriverId, scripting: undefined }, ...localModels()]
      const failures: string[] = []
      try {
        await svc.connect(server)
        for (const [n, model] of models.entries()) {
          const space = `dump_${n + 1}`
          const config: ConnectionConfig = { ...server, id: `${server.id}-${n}`, database: space }
          await svc.runScript(server.id, `DROP DATABASE IF EXISTS ${space}`)
          await svc.runScript(server.id, `CREATE DATABASE ${space}`)
          await svc.connect(config)
          // MySQL's schema is its database: the dump says no schema.
          const placed = model.tables.map((t) => ({ ...t, schema: driver === 'mysql' ? undefined : t.schema, foreignKeys: t.foreignKeys.map((f) => ({ ...f, refSchema: driver === 'mysql' ? undefined : f.refSchema })) }))
          const tables = model.scripting ? unquotedNames(placed, driver) : placed
          const outcomes = await svc.runScript(config.id, createScript(tables, getDialect(driver), { translateTypes: true, from: model.driver, ...dezignMigrationOptions(model.scripting, driver) }), { continueOnError: true })
          const failed = outcomes.filter((o) => o.error).length
          const dump = execFileSync('docker', server.dump(container!, space), { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
          const read = await tablesFromDdl(dump)
          const expected = model.driver === driver ? tables : translateTables(tables, driver, model.driver)
          const changes = compareSchemas(expected, read.tables)
          const kinds: Record<string, number> = {}
          for (const c of changes) kinds[c.kind] = (kinds[c.kind] ?? 0) + 1
          // Kinds of what was skipped, in words of SQL and of the error only (local models are private).
          for (const x of read.skipped) report(`${model.label} skipped: ${x.sql.trim().split(/\s+/).slice(0, 2).join(' ').toUpperCase().replace(/[^A-Z ]/g, '')} | ${x.error.replace(/"[^"]*"|'[^']*'/g, 'Q').split(/\s+/).slice(0, 12).map((w) => (/^[A-Z][a-z]+:?$|^[a-z]{1,9}[:!.,]?$|^[A-Z_]{2,}$|^Q$/.test(w) && !/_/.test(w) ? w : 'x')).join(' ')}`)
          if (process.env.DBM_DUMP_SHAPES) {
            const shape: Record<string, number> = {}
            const kind = (v: unknown) => (v == null ? 'none' : /^-?[\d.]+$/.test(String(v)) ? 'number' : /^'/.test(String(v)) ? 'string' : /\(/.test(String(v)) ? `fn:${String(v).replace(/\(.*$/s, '').toLowerCase().slice(0, 24)}` : 'word')
            for (const c of changes as any[]) {
              const k = c.kind === 'alter_column' ? `col ${Object.entries(c.changes).filter(([, v]) => v).map(([k]) => k).join('+')} type ${c.after.dataType}→${c.before.dataType} default ${kind(c.after.defaultValue)}→${kind(c.before.defaultValue)} comment ${(c.after.comment ?? '').length}→${(c.before.comment ?? '').length}` : c.kind === 'set_table_comment' ? `table comment ${String(c.comment ?? c.after ?? '').length}` : c.kind
              shape[k] = (shape[k] ?? 0) + 1
            }
            for (const [k, v] of Object.entries(shape)) report(`${model.label} SHAPE ${v}× ${k}`)
          }
          report(`${model.label} ${driver}: tables=${tables.length} created-failed=${failed} read=${read.tables.length} skipped=${read.skipped.length} differences=${JSON.stringify(kinds)}`)
          if (model.label === 'shop') expect(changes.map((c) => `${c.kind} ${'column' in c ? c.column : ''}`)).toEqual([])
          else if (failed === 0 && (read.skipped.length || changes.length)) failures.push(`${model.label}: skipped ${read.skipped.length}, differences ${JSON.stringify(kinds)}`)
          await svc.disconnect(config.id)
          await svc.runScript(server.id, `DROP DATABASE IF EXISTS ${space}`)
        }
      } finally {
        await svc.disconnectAll()
      }
      expect(failures).toEqual([])
    })
  })
}

// SQL Server: the models are created there, translated, without a failure. With Microsoft's sqlpackage the
// database is also scripted by it (`/Action:Extract /p:ExtractTarget=File`) and that script must read back as the
// translated model. DBM_SQLPACKAGE: the tool on this machine (CI: `dotnet tool install -g microsoft.sqlpackage`);
// DBM_SQLPACKAGE_IN_CONTAINER: its path inside the SQL Server container (Linux x64 only, so on an ARM Mac).
const msContainer = skipped.includes('mssql') ? undefined : containerFor(14339)
const sqlpackage = process.env.DBM_SQLPACKAGE
const sqlpackageInContainer = process.env.DBM_SQLPACKAGE_IN_CONTAINER

/** The database as sqlpackage scripts it. */
function scriptedBySqlpackage(database: string, password: string): string {
  const options = (server: string, file: string) => ['/Action:Extract', `/SourceServerName:${server}`, `/SourceDatabaseName:${database}`, '/SourceUser:sa', `/SourcePassword:${password}`, '/SourceTrustServerCertificate:True', `/TargetFile:${file}`, '/p:ExtractTarget=File', '/Quiet:True']
  if (sqlpackage) {
    const dir = mkdtempSync(join(tmpdir(), 'dbm-sqlpackage-'))
    try {
      execFileSync(sqlpackage, options('localhost,14339', join(dir, 'db.sql')), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      return readFileSync(join(dir, 'db.sql'), 'utf8')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const file = `/tmp/${database}.sql`
  execFileSync('docker', ['exec', msContainer!, sqlpackageInContainer!, ...options('localhost', file)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  try {
    return execFileSync('docker', ['exec', msContainer!, 'cat', file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  } finally {
    execFileSync('docker', ['exec', msContainer!, 'rm', '-f', file])
  }
}
describe.skipIf(!msContainer)('a model translated for SQL Server is created there', () => {
  it('runs every statement of the CREATE script', { timeout: 1_200_000 }, async () => {
    const svc = new DatabaseService()
    const server: ConnectionConfig = { id: 'dump-ms', name: 'dump', driver: 'mssql', host: '127.0.0.1', port: 14339, user: 'sa', password: 'Mastermind!2026', database: 'master', options: { trustServerCertificate: true } }
    const failures: string[] = []
    try {
      await svc.connect(server)
      for (const [n, model] of [{ label: 'shop', tables: SHOP, driver: 'postgres' as DriverId, scripting: undefined }, ...localModels()].entries()) {
        const space = `dump_ms_${n + 1}`
        await svc.runScript(server.id, `DROP DATABASE IF EXISTS ${space}`)
        await svc.runScript(server.id, `CREATE DATABASE ${space}`)
        const config: ConnectionConfig = { ...server, id: `${server.id}-${n}`, database: space }
        await svc.connect(config)
        const tables = model.scripting ? unquotedNames(model.tables, 'mssql') : model.tables
        // (The script's schemas are made first: a model's schema is not dbo.)
        for (const schema of new Set(tables.map((t) => t.schema).filter((s): s is string => !!s && s.toLowerCase() !== 'dbo'))) await svc.runScript(config.id, `CREATE SCHEMA ${getDialect('mssql').quoteIdent(schema)}`)
        const outcomes = await svc.runScript(config.id, createScript(tables, getDialect('mssql'), { translateTypes: true, from: model.driver, ...dezignMigrationOptions(model.scripting, 'mssql') }), { continueOnError: true })
        const failed = outcomes.filter((o) => o.error).length
        const live = (await svc.schema(config.id, true)).tables.filter((t) => t.type === 'table').length
        report(`${model.label} mssql: tables=${tables.length} created=${live} failed=${failed}`)
        if (failed || live !== tables.length) failures.push(`${model.label}: ${failed} failed, ${live}/${tables.length} tables`)
        if ((sqlpackage || sqlpackageInContainer) && !failed) {
          const dump = scriptedBySqlpackage(space, server.password!)
          const read = await tablesFromDdl(dump)
          const expected = translateTables(tables, 'mssql', model.driver)
          const changes = compareSchemas(expected, read.tables)
          const kinds: Record<string, number> = {}
          for (const c of changes) kinds[c.kind] = (kinds[c.kind] ?? 0) + 1
          for (const x of read.skipped) report(`${model.label} sqlpackage skipped: ${x.sql.trim().split(/\s+/).slice(0, 2).join(' ').toUpperCase().replace(/[^A-Z ]/g, '')} | ${x.error.replace(/"[^"]*"|'[^']*'/g, 'Q').split(/\s+/).slice(0, 12).map((w) => (/^[A-Z][a-z]+:?$|^[a-z]{1,9}[:!.,]?$|^[A-Z_]{2,}$|^Q$/.test(w) && !/_/.test(w) ? w : 'x')).join(' ')}`)
          if (process.env.DBM_DUMP_SHAPES) for (const c of changes as any[]) report(`${model.label} SHAPE ${c.kind} ${c.kind === 'alter_column' ? `${Object.entries(c.changes).filter(([, v]) => v).map(([k]) => k).join('+')} ${c.after.dataType}→${c.before.dataType} default ${c.after.defaultValue == null ? 'none' : String(c.after.defaultValue).replace(/[A-Za-z_]\w*/g, (w: string) => (/^(cast|getdate|sysdatetime|date|as|null)$/i.test(w) ? w : 'x'))}→${c.before.defaultValue == null ? 'none' : String(c.before.defaultValue).replace(/[A-Za-z_]\w*/g, (w: string) => (/^(cast|getdate|sysdatetime|date|as|null|convert)$/i.test(w) ? w : 'x'))} comment ${(c.after.comment ?? '').length}→${(c.before.comment ?? '').length}` : ''}`)
          report(`${model.label} sqlpackage: read=${read.tables.length} skipped=${read.skipped.length} differences=${JSON.stringify(kinds)}`)
          if (read.skipped.length || changes.length) failures.push(`${model.label}: sqlpackage script skipped ${read.skipped.length}, differences ${JSON.stringify(kinds)}`)
        }
        await svc.disconnect(config.id)
        await svc.runScript(server.id, `DROP DATABASE IF EXISTS ${space}`)
      }
    } finally {
      await svc.disconnectAll()
    }
    expect(failures).toEqual([])
  })
})

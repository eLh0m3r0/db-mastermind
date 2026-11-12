import { execFileSync } from 'node:child_process'
import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs'
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
      const models = [{ label: 'shop', tables: SHOP, driver: 'postgres' as DriverId, scripting: undefined }, ...localModels().filter((m) => m.driver === driver)]
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

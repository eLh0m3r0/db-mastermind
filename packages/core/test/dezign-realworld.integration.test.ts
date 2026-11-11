import { readdirSync, readFileSync, statSync, appendFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mutate, random } from './dezign-fuzz.js'
import { assembleDezignProject, compareSchemas, createScript, DatabaseService, dezignDriver, generateMigration, getDialect, migrationScript, parseDbml, readDezign, translateTables, type ConnectionConfig, type DriverId, type TableInfo } from '../src/index.js'

/**
 * Real DeZign models against real databases: the DDL generated from each model in DBM_DEZ_SAMPLES is run on the
 * database the model was drawn for (PostgreSQL, MySQL or SQL Server; any other model is translated to
 * PostgreSQL), and the model is then compared with what the database says it got. A model must come out with no
 * difference on its own database. On PostgreSQL the model is then edited at random (as in the designer) and the
 * ALTER script that brings the database up to the edited model is run and checked the same way. Needs the services from docker-compose.test.yml; `DBM_SKIP=mssql,mysql`
 * leaves engines out. Prints counts, never names from a model, unless DBM_DEZ_DEBUG is set (public samples only).
 */
const root = process.env.DBM_DEZ_SAMPLES
const skipped = (process.env.DBM_SKIP ?? '').split(',')
const report = (line: string) => (process.env.DBM_DEZ_REPORT ? appendFileSync(process.env.DBM_DEZ_REPORT, `${line}\n`) : process.env.DBM_DEZ_SAMPLES || process.env.DBM_DEZ_DEBUG ? console.log(line) : undefined)

const SERVERS: Partial<Record<DriverId, ConnectionConfig>> = {
  postgres: { id: 'dz-pg', name: 'dz', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' },
  mysql: { id: 'dz-my', name: 'dz', driver: 'mysql', host: '127.0.0.1', port: 33069, user: 'root', password: 'mastermind', database: 'mastermind' },
  mssql: { id: 'dz-ms', name: 'dz', driver: 'mssql', host: '127.0.0.1', port: 14339, user: 'sa', password: 'Mastermind!2026', database: 'master', options: { trustServerCertificate: true } },
}
/** The engine a model was drawn for, when it is one that runs here. */
const nativeEngine = (target: string): DriverId | null => (/^postgres/i.test(target) ? 'postgres' : /^(mysql|mariadb)/i.test(target) ? 'mysql' : /^mssql/i.test(target) ? 'mssql' : null)

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

/**
 * The random edits were written for the file writer, which takes any text: a database does not. Defaults that
 * don't fit their type are taken out, and so are type changes no database converts (a date into a boolean)
 * and checks on columns that have since been renamed. `checked` collects the columns a check has ever named.
 */
function sensible(edited: TableInfo[], live: TableInfo[], checked: Set<string>): void {
  const kind = (type: string) => (/char|text/i.test(type) ? 'text' : /int|numeric|decimal|serial/i.test(type) ? 'number' : type.toLowerCase())
  for (const t of edited) {
    const before = live.find((x) => x.name === t.name)
    for (const c of t.checks ?? []) for (const word of c.expression.match(/[A-Za-z_][\w$]*/g) ?? []) checked.add(word)
    // The random checks name a column, which a later random rename leaves behind.
    if (t.checks) t.checks = t.checks.filter((c) => t.columns.some((x) => x.name === /^[\w$]+/.exec(c.expression)?.[0]))
    for (const c of t.columns) {
      const was = before?.columns.find((x) => x.name === c.name)
      if (was && kind(was.dataType) !== kind(c.dataType) && kind(was.dataType) !== 'text' && kind(c.dataType) !== 'text') c.dataType = was.dataType
      // A check in the database compares the column as the type it has (`quantity > 0`).
      if (was && checked.has(c.name)) c.dataType = was.dataType
      if (c.defaultValue === "'x'" && kind(c.dataType) !== 'text') c.defaultValue = null
      if (c.defaultValue === '0' && kind(c.dataType) !== 'number') c.defaultValue = null
    }
  }
}

/**
 * One model through a database: created from its DDL, compared, and on PostgreSQL edited at random and migrated
 * for a number of rounds. Adds what went wrong to `failures`.
 */
async function exercise(svc: DatabaseService, n: number, model: { tables: TableInfo[]; targetDatabase: string }, failures: string[]): Promise<void> {
  const native = nativeEngine(model.targetDatabase)
  const driver = native && !skipped.includes(native) ? native : 'postgres'
  if (skipped.includes(driver)) return
  const server = SERVERS[driver]!
  const space = `dz_${n + 1}`
  // PostgreSQL gets a schema per model, MySQL and SQL Server a database per model.
  const config: ConnectionConfig = driver === 'postgres' ? server : { ...server, id: `${server.id}-${n}`, database: space }
  const schema = driver === 'mssql' ? 'dbo' : space
  await svc.connect(server)
  if (driver === 'postgres') await svc.runScript(server.id, `DROP SCHEMA IF EXISTS ${space} CASCADE; CREATE SCHEMA ${space}`)
  else {
    await svc.runScript(server.id, `DROP DATABASE IF EXISTS ${space}`)
    await svc.runScript(server.id, `CREATE DATABASE ${space}`)
    await svc.connect(config)
  }
  // Everything goes into that one place, whatever schemas the model names.
  const tables: TableInfo[] = model.tables.map((t) => ({ ...t, schema, foreignKeys: t.foreignKeys.filter((f) => !f.virtual).map((f) => ({ ...f, refSchema: schema })) }))
  // As the app does it: types are translated unless the model was drawn for this database.
  const from = dezignDriver(model.targetDatabase)
  const outcomes = await svc.runScript(config.id, createScript(tables, getDialect(driver), { translateTypes: true, from }), { continueOnError: true })
  const errors = outcomes.filter((o) => o.error)
  const live = (await svc.schema(config.id, true)).tables.filter((t) => t.type === 'table' && t.schema === schema)
  const changes = errors.length ? [] : compareSchemas(translateTables(tables, driver, from), live, { keepExtra: false })
  const kinds = changes.reduce<Record<string, number>>((all, c) => ({ ...all, [c.kind]: (all[c.kind] ?? 0) + 1 }), {})
  // The kind of error, without the names in it.
  const firstError = errors[0]?.error?.message.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '"…"').replace(/\b[\w$]*_[\w$]*\b/g, 'x').slice(0, 110) ?? ''
  const ok = !errors.length && !changes.length && live.length === tables.length
  report(`#${n + 1} ${model.targetDatabase} on ${driver}${driver === native ? '' : ' (translated)'} tables=${tables.length} created=${live.length} failed statements=${errors.length}/${outcomes.length} differences=${JSON.stringify(kinds)} ${ok ? 'ok' : `PROBLEM ${firstError}`}`)
  // Details name things from the model: for public samples only.
  if (!ok && process.env.DBM_DEZ_DEBUG) {
    for (const o of errors.slice(0, 3)) console.log(`#${n + 1} ERROR ${o.error?.message}\n   ${o.sql.replace(/\s+/g, ' ').slice(0, 400)}`)
    for (const c of changes.slice(0, 6)) console.log(`#${n + 1} CHANGE ${JSON.stringify(c).slice(0, 700)}`)
  }
  // A model drawn for this database must come out exactly; a translated one carries its own database's types.
  if (!ok && driver === native) failures.push(`#${n + 1}`)
  if (ok && driver === 'postgres') {
    // The model moves on, several times over: each round edits it and runs the migration from what the
    // database has to the edited model, on the real database.
    const edited = structuredClone(translateTables(tables, driver, from))
    const rnd = random(n + 1)
    let current = live
    let serial = 0
    const rounds = Number(process.env.DBM_DEZ_ROUNDS) || 6
    const totals = { statements: 0, failed: 0, left: 0 }
    const checked = new Set(tables.flatMap((t) => (t.checks ?? []).flatMap((c) => [...(c.column ? [c.column] : []), ...(c.expression.match(/[A-Za-z_][\w$]*/g) ?? [])])))
    for (let round = 0; round < rounds && !totals.failed && !totals.left; round++) {
      const edits = Array.from({ length: Number(process.env.DBM_DEZ_EDITS) || 12 }, () => mutate(edited, rnd, serial++))
      for (const t of edited) for (const f of t.foreignKeys) f.refSchema = schema
      sensible(edited, current, checked)
      const migration = generateMigration(compareSchemas(edited, current, { keepExtra: false }), getDialect(driver), current)
      const ran = migration.statements.length ? await svc.runScript(config.id, migrationScript(migration, getDialect(driver)), { continueOnError: true }) : []
      const failed = ran.filter((o) => o.error)
      const after = (await svc.schema(config.id, true)).tables.filter((t) => t.type === 'table' && t.schema === schema)
      const left = failed.length ? [] : compareSchemas(edited, after, { keepExtra: false })
      totals.statements += migration.statements.length
      totals.failed += failed.length
      totals.left += left.length
      if ((failed.length || left.length) && process.env.DBM_DEZ_DEBUG) {
        console.log(`#${n + 1} ROUND ${round + 1} EDITS ${edits.join(', ')}`)
        for (const o of failed.slice(0, 2)) console.log(`#${n + 1} ALTER ERROR ${o.error?.message}\n   ${o.sql.replace(/\s+/g, ' ').slice(0, 500)}`)
        for (const c of left.slice(0, 5)) console.log(`#${n + 1} LEFT ${JSON.stringify(c).slice(0, 700)}`)
      }
      current = after
    }
    const fine = !totals.failed && !totals.left
    report(`#${n + 1} altered: rounds=${rounds} statements=${totals.statements} failed=${totals.failed} left=${totals.left} ${fine ? 'ok' : 'PROBLEM'}`)
    if (!fine && driver === native) failures.push(`#${n + 1} altered`)
  }
  if (driver !== 'postgres') await svc.disconnect(config.id)
  if (ok || !process.env.DBM_DEZ_KEEP) await svc.runScript(server.id, driver === 'postgres' ? `DROP SCHEMA IF EXISTS ${space} CASCADE` : `DROP DATABASE IF EXISTS ${space}`)
}

describe.skipIf(!root)('DeZign models become real schemas', () => {
  it('creates every model on its database and finds no difference between the model and the database', { timeout: 1_800_000 }, async () => {
    const svc = new DatabaseService()
    const failures: string[] = []
    try {
      for (const [n, file] of find(root!).entries()) {
        await exercise(svc, n, readDezign(/\.dezproj$/i.test(file) ? assembleDezignProject(projectFiles(join(file, '..'))) : readFileSync(file, 'latin1')), failures)
      }
    } finally {
      await svc.disconnectAll()
    }
    expect(failures).toEqual([])
  })
})

// The same on a model written here, so that it runs wherever the integration tests do: the things real models
// turned up (tables that reference tables further down or each other, a relationship drawn twice, a unique
// constraint written twice, names in capitals, a domain's check, serial, defaults under a changing type).
describe.skipIf(skipped.includes('postgres'))('a model becomes a real PostgreSQL schema and follows its edits', () => {
  it('creates the model, finds no difference, and migrates the database through rounds of random edits', { timeout: 300_000 }, async () => {
    const { tables, errors } = parseDbml(`
Table "OrderLine" {
  order_id int [not null]
  line_no int [not null]
  "ProductCode" varchar(20) [not null, ref: > product.code]
  quantity numeric(8) [not null, default: 1]
  "Grade" char(1) [check: \`value IS NULL OR value IN ('A','B')\`]
  indexes {
    (order_id, line_no) [pk]
    "ProductCode" [name: 'ix_line_product']
  }
  checks {
    \`quantity > 0\` [name: 'positive_quantity']
  }
}
Table orders {
  id serial [pk]
  customer_id int [not null]
  state varchar(12) [not null, default: 'new']
  placed timestamp [default: \`now()\`]
  paid boolean [not null, default: false]
  last_line int
  indexes {
    (customer_id, state) [unique, name: 'ux_orders_1']
    (customer_id, state) [unique, name: 'ux_orders_2']
  }
}
Table customer {
  id int [pk, increment]
  name "character varying(120)" [not null]
  favourite_order int [ref: > orders.id]
  note text [note: 'It''s free text']
}
Table product {
  code varchar(20) [pk]
  price decimal(10,2) [not null, default: 0]
}
Ref: "OrderLine".order_id > orders.id [delete: cascade]
Ref: orders.customer_id > customer.id
Ref: orders.customer_id > customer.id
`)
    expect(errors).toEqual([])
    const svc = new DatabaseService()
    const failures: string[] = []
    try {
      await exercise(svc, 9000, { tables, targetDatabase: 'postgresql16' }, failures)
    } finally {
      await svc.disconnectAll()
    }
    expect(failures).toEqual([])
  })
})

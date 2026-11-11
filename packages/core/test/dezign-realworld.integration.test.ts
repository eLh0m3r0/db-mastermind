import { readdirSync, readFileSync, statSync, appendFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mutate, random } from './dezign-fuzz.js'
import { assembleDezignProject, compareSchemas, createScript, DatabaseService, dezignDriver, dezignMigrationOptions, findChangedChecks, generateMigration, getDialect, migrationScript, parseDbml, readDezign, toDbml, translateTables, unquotedName, unquotedNames, type ConnectionConfig, type DezignScripting, type DezignSqlObject, type DriverId, type TableInfo } from '../src/index.js'

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
const ORDER = ['sequence', 'view', 'procedure', 'trigger']
/** Words of SQL itself: safe to show when the database stops at one. */
const SQL_WORDS = new Set('as default not null check constraint primary key references unique create table domain alter add column on in and or is user date time timestamp interval boolean integer numeric decimal varchar char character text value values precision with without zone order group by to from select where like between current_date current_timestamp true false bit real double float bigint smallint int serial'.split(' '))
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
    // A foreign key needs something unique to point at: one whose target lost its key or unique index goes too.
    t.foreignKeys = t.foreignKeys.filter((f) => {
      const target = edited.find((x) => x.name === f.refTable)
      const columns = [...f.refColumns].sort().join(',')
      return !target || [...target.primaryKey].sort().join(',') === columns || target.indexes.some((i) => i.unique && [...i.columns].sort().join(',') === columns)
    })
    for (const c of t.checks ?? []) for (const word of c.expression.match(/[A-Za-z_][\w$]*/g) ?? []) checked.add(word)
    // The random checks name a column, which a later random rename leaves behind.
    if (t.checks) t.checks = t.checks.filter((c) => t.columns.some((x) => x.name === /^[\w$]+/.exec(c.expression)?.[0]))
    for (const c of t.columns) {
      const was = before?.columns.find((x) => x.name === c.name)
      // (A column typed by a domain of the database keeps it: what converts to what is the domain's business.)
      const builtIn = /^(character|varchar|char|text|integer|int|bigint|smallint|numeric|decimal|serial|bigserial|boolean|date|timestamp|time|double|real|uuid|json|jsonb|bytea)\b/i
      if (was && !builtIn.test(was.dataType) && c.dataType !== was.dataType) Object.assign(c, { dataType: was.dataType, defaultValue: was.defaultValue ?? null })
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
async function exercise(svc: DatabaseService, n: number, model: { tables: TableInfo[]; targetDatabase: string; sqlObjects?: DezignSqlObject[]; scripting?: DezignScripting }, failures: string[]): Promise<void> {
  const native = nativeEngine(model.targetDatabase)
  const driver = native && !skipped.includes(native) ? native : 'postgres'
  if (skipped.includes(driver)) return
  const server = SERVERS[driver]!
  const space = `dz_${n + 1}`
  // A database of its own for every model: empty, as on the day somebody runs the script for the first time.
  // Schemas keep the names the model gives them (the script makes them); MySQL's schema is that database.
  const config: ConnectionConfig = { ...server, id: `${server.id}-${n}`, database: space }
  const schemaFor = (own: string | undefined) => (driver === 'mysql' ? space : own)
  const schemas = [...new Set(model.tables.map((t) => schemaFor(t.schema) ?? ''))]
  await svc.connect(server)
  await svc.runScript(server.id, `DROP DATABASE IF EXISTS ${space}`)
  await svc.runScript(server.id, `CREATE DATABASE ${space}`)
  await svc.connect(config)
  // As the app does it for a DeZign project: names as DeZign's own scripts create them (bare, so PostgreSQL
  // folds them), keys named the project's way.
  const placed: TableInfo[] = model.tables.map((t) => ({ ...t, schema: schemaFor(t.schema), foreignKeys: t.foreignKeys.filter((f) => !f.virtual).map((f) => ({ ...f, refSchema: schemaFor(f.refSchema) })) }))
  const tables = model.scripting ? unquotedNames(placed, driver) : placed
  const options = dezignMigrationOptions(model.scripting, driver)
  // As the app does it: types are translated unless the model was drawn for this database.
  const from = dezignDriver(model.targetDatabase)
  const outcomes = await svc.runScript(config.id, createScript(tables, getDialect(driver), { translateTypes: true, from, ...options }), { continueOnError: true })
  const errors = outcomes.filter((o) => o.error)
  const mine = (t: TableInfo) => t.type === 'table'
  const live = (await svc.schema(config.id, true)).tables.filter(mine)
  // The database is asked how it stores the model's check conditions (PostgreSQL): right after its own script it
  // must say "as the table has them" for every one, or every compare would want to replace the checks.
  const checkChanged = errors.length ? undefined : await findChangedChecks(translateTables(tables, driver, from), live, (items) => svc.canonicalChecks(config.id, items))
  const changes = errors.length ? [] : compareSchemas(translateTables(tables, driver, from), live, { keepExtra: false, model: true, checkChanged })
  const kinds = changes.reduce<Record<string, number>>((all, c) => ({ ...all, [c.kind]: (all[c.kind] ?? 0) + 1 }), {})
  // The kind of error, without the names in it.
  const firstError = errors[0]?.error?.message.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '"…"').replace(/\b[\w$]*_[\w$]*\b/g, 'x').split(/\s+/).slice(0, 6).join(' ') ?? ''
  // Which kind of statement failed first, and whether the database stopped at a word or at punctuation: enough to
  // find the cause without a name from the model.
  const near = /near "([^"]*)"/.exec(errors[0]?.error?.message ?? '')?.[1]
  const firstKind = errors[0] ? ` [${errors[0].sql.replace(/^(\s*--[^\n]*\n)*/, '').trim().split(/\s+/).slice(0, 2).join(' ')}${near === undefined ? '' : /^[\w$]+$/.test(near) ? `, at a word of ${near.length} letters${/^[a-z_]+$/.test(near) && SQL_WORDS.has(near.toLowerCase()) ? ` (${near})` : ''}` : `, at ${near}`}]` : ''
  // The skeleton of the first statement that failed: SQL's own words and punctuation, every name and text blanked.
  if (errors[0] && process.env.DBM_DEZ_SHAPE) {
    const skeleton = errors[0].sql.replace(/'(?:[^']|'')*'/g, "'…'").replace(/"(?:[^"]|"")*"/g, '"…"').replace(/[\p{L}_][\p{L}\p{N}_$]*/gu, (w) => (SQL_WORDS.has(w.toLowerCase()) ? w : 'w'))
    report(`#${n + 1} skeleton of the failed statement:\n${skeleton.split('\n').slice(0, 60).join('\n')}`)
  }
  const ok = !errors.length && !changes.length && live.length === tables.length
  // What no script could create: the model itself is not valid for its database (DeZign's own script fails the same way).
  const invalidModel = errors.some((o) => /there can be only one auto column/i.test(o.error?.message ?? ''))
  report(`#${n + 1} ${model.targetDatabase} on ${driver}${driver === native ? '' : ' (translated)'} schemas=${schemas.length} tables=${tables.length} created=${live.length} failed statements=${errors.length}/${outcomes.length} differences=${JSON.stringify(kinds)} ${ok ? 'ok' : `${invalidModel ? 'MODEL NOT VALID' : 'PROBLEM'} ${firstError}${firstKind}`}`)
  // Details name things from the model: for public samples only.
  if (!ok && process.env.DBM_DEZ_DEBUG) {
    for (const o of errors.slice(0, 3)) report(`#${n + 1} ERROR ${o.error?.message}\n   ${o.sql.replace(/\s+/g, ' ').slice(0, 400)}`)
    for (const c of changes.slice(0, 6)) report(`#${n + 1} CHANGE ${JSON.stringify(c).slice(0, 700)}`)
  }
  // A model drawn for this database must come out exactly; a translated one carries its own database's types.
  if (!ok && driver === native && !invalidModel) failures.push(`#${n + 1}`)
  // The project's views and sequences, as the app adds them to the script. They may name things no model holds
  // (functions, other databases), so what fails is reported, not required.
  const objects = driver === native && ok && driver !== 'mysql' ? [...(model.sqlObjects ?? [])].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind)) : []
  if (objects.length) {
    let broken = 0
    for (const o of objects) {
      const [outcome] = await svc.runScript(config.id, o.sql, { continueOnError: true })
      if (outcome?.error) {
        broken += 1
        if (process.env.DBM_DEZ_DEBUG) report(`#${n + 1} OBJECT ${o.kind} ERROR ${outcome.error.message}\n   ${o.sql.replace(/\s+/g, ' ').slice(0, 300)}`)
      }
    }
    report(`#${n + 1} objects: ${objects.length} (${[...new Set(objects.map((o) => o.kind))].join(', ')}) failed=${broken}`)
    // The random edits below know nothing of views: a table they drop or rename may be one a view reads.
    for (const o of objects.filter((x) => x.kind === 'view').reverse()) await svc.runScript(config.id, `DROP VIEW IF EXISTS ${o.schema ? `${getDialect(driver).quoteIdent(o.schema)}.` : ''}${getDialect(driver).quoteIdent(o.name)}`, { continueOnError: true })
  }
  if (ok && driver === 'postgres') {
    // The model moves on, several times over: each round edits it and runs the migration from what the
    // database has to the edited model, on the real database.
    const edited = structuredClone(translateTables(tables, driver, from))
    const rnd = random(n + 1)
    let current = live
    let serial = 0
    const rounds = Number(process.env.DBM_DEZ_ROUNDS) || 6
    const totals = { statements: 0, checks: 0, failed: 0, left: 0, error: '' }
    const checked = new Set(tables.flatMap((t) => (t.checks ?? []).flatMap((c) => [...(c.column ? [c.column] : []), ...(c.expression.match(/[A-Za-z_][\w$]*/g) ?? [])])))
    for (let round = 0; round < rounds && !totals.failed && !totals.left; round++) {
      const edits = Array.from({ length: Number(process.env.DBM_DEZ_EDITS) || 12 }, () => mutate(edited, rnd, serial++))
      for (const t of edited) for (const f of t.foreignKeys) f.refSchema = edited.find((x) => x.name === f.refTable)?.schema
      sensible(edited, current, checked)
      const planned = compareSchemas(edited, current, { keepExtra: false, model: true })
      totals.checks += planned.filter((c) => c.kind === 'add_check' || c.kind === 'drop_check').length
      const migration = generateMigration(planned, getDialect(driver), current, options)
      const ran = migration.statements.length ? await svc.runScript(config.id, migrationScript(migration, getDialect(driver)), { continueOnError: true }) : []
      const failed = ran.filter((o) => o.error)
      const after = (await svc.schema(config.id, true)).tables.filter(mine)
      const left = failed.length ? [] : compareSchemas(edited, after, { keepExtra: false, model: true })
      totals.statements += migration.statements.length
      totals.failed += failed.length
      totals.left += left.length
      // The kind of error, without the names in it.
      totals.error ||= failed[0]?.error?.message.replace(/"[^"]*"|'[^']*'/g, '"…"').replace(/\b[\w$]*_[\w$]*\b/g, 'x').split(/\s+/).slice(0, 6).join(' ') ?? ''
      if ((failed.length || left.length) && process.env.DBM_DEZ_DEBUG) {
        report(`#${n + 1} ROUND ${round + 1} EDITS ${edits.join(', ')}`)
        for (const o of failed.slice(0, 2)) report(`#${n + 1} ALTER ERROR ${o.error?.message}\n   ${o.sql.replace(/\s+/g, ' ').slice(0, 500)}`)
        for (const c of left.slice(0, 5)) report(`#${n + 1} LEFT ${JSON.stringify(c).slice(0, 700)}`)
      }
      current = after
    }
    const fine = !totals.failed && !totals.left
    report(`#${n + 1} altered: rounds=${rounds} statements=${totals.statements} (checks added or dropped: ${totals.checks}) failed=${totals.failed} left=${totals.left} ${fine ? 'ok' : `PROBLEM ${totals.error}`}`)
    if (!fine && driver === native) failures.push(`#${n + 1} altered`)
  }
  await svc.disconnect(config.id)
  if (ok || !process.env.DBM_DEZ_KEEP) await svc.runScript(server.id, `DROP DATABASE IF EXISTS ${space}`)
}

describe.skipIf(!root)('DeZign models become real schemas', () => {
  it('creates every model on its database and finds no difference between the model and the database', { timeout: 1_800_000 }, async () => {
    const svc = new DatabaseService()
    const failures: string[] = []
    try {
      for (const [n, file] of find(root!).entries()) {
        const model = readDezign(/\.dezproj$/i.test(file) ? assembleDezignProject(projectFiles(join(file, '..'))) : readFileSync(file, 'latin1'))
        // The app works on the model as DBML text: what that form keeps is what its scripts are made of.
        const asText = parseDbml(toDbml(model.tables))
        expect(asText.errors).toEqual([])
        await exercise(svc, n, { ...model, tables: asText.tables }, failures)
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
  "ProductCode" varchar(20) [not null, ref: > catalog.product.code]
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
Table catalog.product {
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

// The closest thing to DeZign itself: scripts DeZign generated, kept next to their models in public repositories.
// DBM_DEZ_PAIRS is a folder of folders, each with `model.dez` and `dezign.sql` (DeZign's own creation script
// for PostgreSQL). DeZign's script and ours each make a database, and the two databases are compared: tables,
// columns, types, keys, indexes, and the names of every constraint.
const pairs = process.env.DBM_DEZ_PAIRS
describe.skipIf(!pairs || skipped.includes('postgres'))('our script makes the database DeZign\'s own script makes', () => {
  it('compares the two databases of every pair', { timeout: 600_000 }, async () => {
    const svc = new DatabaseService()
    const server = SERVERS.postgres!
    const failures: string[] = []
    try {
      await svc.connect(server)
      for (const [n, name] of readdirSync(pairs!).filter((d) => statSync(join(pairs!, d)).isDirectory()).entries()) {
        const model = readDezign(readFileSync(join(pairs!, name, 'model.dez'), 'latin1'))
        const asText = parseDbml(toDbml(model.tables))
        const ours = createScript(unquotedNames(asText.tables, 'postgres'), getDialect('postgres'), {
          translateTypes: true,
          from: dezignDriver(model.targetDatabase),
          ...dezignMigrationOptions(model.scripting, 'postgres'),
        })
        const made: TableInfo[][] = []
        for (const [side, script] of [['a', readFileSync(join(pairs!, name, 'dezign.sql'), 'utf8')], ['b', ours]] as const) {
          const database = `dzp_${n + 1}_${side}`
          const config: ConnectionConfig = { ...server, id: `dzp-${n}-${side}`, database }
          await svc.runScript(server.id, `DROP DATABASE IF EXISTS ${database}`)
          await svc.runScript(server.id, `CREATE DATABASE ${database}`)
          await svc.connect(config)
          const failed = (await svc.runScript(config.id, script, { continueOnError: true })).filter((o) => o.error)
          if (failed.length) {
            report(`pair ${name}: ${side === 'a' ? "DeZign's" : 'our'} script: ${failed.length} statements failed`)
            if (process.env.DBM_DEZ_DEBUG) for (const o of failed.slice(0, 3)) report(`   ${o.error?.message} | ${o.sql.replace(/\s+/g, ' ').slice(0, 200)}`)
            if (side === 'b') failures.push(`${name}: our script`)
          }
          made.push((await svc.schema(config.id, true)).tables.filter((t) => t.type === 'table'))
          await svc.disconnect(config.id)
          await svc.runScript(server.id, `DROP DATABASE IF EXISTS ${database}`)
        }
        const [theirs, mine] = made as [TableInfo[], TableInfo[]]
        const kinds = (changes: ReturnType<typeof compareSchemas>) => JSON.stringify(changes.reduce<Record<string, number>>((all, c) => ({ ...all, [c.kind]: (all[c.kind] ?? 0) + 1 }), {}))
        const toTheirs = compareSchemas(theirs, mine, { keepExtra: false })
        // Every name a constraint or index has, by kind: the two databases should use the same ones.
        const names = (tables: TableInfo[]) =>
          new Set(tables.flatMap((t) => [...t.indexes.map((i) => `${i.primary ? 'key' : i.unique ? (i.constraint ? 'unique constraint' : 'unique index') : 'index'} ${t.name}.${i.name}`), ...t.foreignKeys.map((f) => `foreign key ${t.name}.${f.name}`), ...(t.checks ?? []).map((c) => `check ${t.name}.${c.name}`)]))
        const [a, b] = [names(theirs), names(mine)]
        const onlyTheirs = [...a].filter((x) => !b.has(x))
        const onlyOurs = [...b].filter((x) => !a.has(x))
        report(`pair ${name}: tables ${theirs.length} / ${mine.length} | to make ours like DeZign's: ${kinds(toTheirs)} | names only in DeZign's: ${onlyTheirs.length} | only in ours: ${onlyOurs.length} | of ${a.size}`)
        if (process.env.DBM_DEZ_DEBUG) {
          for (const c of toTheirs.slice(0, 8)) report(`   CHANGE ${JSON.stringify(c).slice(0, 500)}`)
          for (const x of onlyTheirs.slice(0, 12)) report(`   DeZign's: ${x}`)
          for (const x of onlyOurs.slice(0, 12)) report(`   ours:     ${x}`)
        }
      }
    } finally {
      await svc.disconnectAll()
    }
    expect(failures).toEqual([])
  })
})

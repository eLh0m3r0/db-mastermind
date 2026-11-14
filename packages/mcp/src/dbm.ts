import { createWriteStream, readFileSync, writeFileSync } from 'node:fs'
import {
  buildDataDictionary,
  cellToText,
  checkModel,
  compareSchemas,
  DatabaseService,
  describeError,
  findChangedChecks,
  generateMigration,
  getDialect,
  isReadOnlyScript,
  migrationScript,
  parseDbml,
  splitStatements,
  type CellValue,
  type ConnectionConfig,
  type ResultField,
} from '@dbmastermind/core'
import { connectionFromUrl, connectionsFromFile } from './connection-args.js'

export const DBM_HELP = `dbm: DB Mastermind on the command line (scripts, CI)

Usage:
  dbm query      --url <url> "SELECT …" [--format csv|tsv|json|jsonl|markdown] [--out file] [--allow-writes]
  dbm query      --url <url> --file script.sql …
  dbm dictionary --url <url> [--format html|markdown] [--schema s] [--out file]
  dbm check      model.dbml [--strict]
  dbm diff       model.dbml --url <url> [--out migration.sql] [--drop-extra]

Connections:
  --url <url>          postgres://…, mysql://…, sqlserver://…, sqlite:///path, JDBC or ADO.NET; \${ENV_VAR} is expanded
  --config <file>      JSON array of connections; pick one with --connection <name>

Exit codes:
  0  done (diff: the database matches the model; check: no problems)
  1  error (check: problems found)
  2  diff: the database differs from the model (the migration is printed)

Read-only unless --allow-writes: the database itself refuses writes where it can.
`

export interface DbmIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
}

interface Options {
  command: string
  positional: string[]
  url?: string
  config?: string
  connection?: string
  format?: string
  out?: string
  file?: string
  schemas: string[]
  allowWrites: boolean
  strict: boolean
  dropExtra: boolean
}

function parse(argv: string[]): Options {
  const [command = '', ...rest] = argv
  const o: Options = { command, positional: [], schemas: [], allowWrites: false, strict: false, dropExtra: false }
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    const next = () => {
      const v = rest[++i]
      if (v === undefined) throw new Error(`${arg} needs a value`)
      return v
    }
    switch (arg) {
      case '--url':
        o.url = next()
        break
      case '--config':
        o.config = next()
        break
      case '--connection':
        o.connection = next()
        break
      case '--format':
        o.format = next()
        break
      case '--out':
      case '-o':
        o.out = next()
        break
      case '--file':
      case '-f':
        o.file = next()
        break
      case '--schema':
        o.schemas.push(next())
        break
      case '--allow-writes':
        o.allowWrites = true
        break
      case '--strict':
        o.strict = true
        break
      case '--drop-extra':
        o.dropExtra = true
        break
      default:
        if (arg.startsWith('-') && arg !== '-') throw new Error(`Unknown option ${arg}`)
        o.positional.push(arg)
    }
  }
  return o
}

function pickConnection(o: Options): ConnectionConfig {
  const list = o.url ? [connectionFromUrl(o.url, 'c1')] : o.config ? connectionsFromFile(o.config) : []
  if (!list.length) throw new Error('Give a connection: --url <url> or --config <file>')
  const config = o.connection ? list.find((c) => c.name === o.connection || c.id === o.connection) : list.length === 1 ? list[0] : undefined
  if (!config) throw new Error(o.connection ? `No connection named ${o.connection}` : 'The config has several connections: pick one with --connection <name>')
  // Writes only when asked; read-only is enforced by the database where it can (session settings).
  return { ...config, readOnly: o.allowWrites ? config.readOnly : true }
}

/** Rows as text in a file format, written as they come (no memory limit). */
export function formatter(format: string): { head(fields: ResultField[]): string; row(fields: ResultField[], row: CellValue[], first: boolean): string; tail(): string } {
  const plain = (v: CellValue) => (v === null || v === undefined ? '' : cellToText(v))
  const json = (v: CellValue): unknown => (v === null || typeof v === 'number' || typeof v === 'boolean' ? v : cellToText(v))
  const object = (fields: ResultField[], row: CellValue[]) => Object.fromEntries(fields.map((f, i) => [f.name, json(row[i] ?? null)]))
  switch (format) {
    case 'csv': {
      const cell = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s)
      return { head: (f) => `${f.map((x) => cell(x.name)).join(',')}\n`, row: (_f, r) => `${r.map((v) => cell(plain(v))).join(',')}\n`, tail: () => '' }
    }
    case 'tsv': {
      const cell = (s: string) => s.replace(/[\t\r\n]+/g, ' ')
      return { head: (f) => `${f.map((x) => cell(x.name)).join('\t')}\n`, row: (_f, r) => `${r.map((v) => cell(plain(v))).join('\t')}\n`, tail: () => '' }
    }
    case 'json':
      return { head: () => '[', row: (f, r, first) => `${first ? '\n' : ',\n'}  ${JSON.stringify(object(f, r))}`, tail: () => '\n]\n' }
    case 'jsonl':
      return { head: () => '', row: (f, r) => `${JSON.stringify(object(f, r))}\n`, tail: () => '' }
    case 'markdown': {
      const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')
      return { head: (f) => `| ${f.map((x) => cell(x.name)).join(' | ')} |\n|${f.map(() => ' --- |').join('')}\n`, row: (_f, r) => `| ${r.map((v) => cell(plain(v))).join(' | ')} |\n`, tail: () => '' }
    }
    default:
      throw new Error(`Unknown format ${format}: csv, tsv, json, jsonl or markdown`)
  }
}

/** Writes to --out (a file) or the given io. */
function output(o: Options, io: DbmIo) {
  if (!o.out) return { write: io.stdout, close: async () => {} }
  const stream = createWriteStream(o.out, 'utf8')
  return {
    write: (text: string) => void stream.write(text),
    close: () => new Promise<void>((resolve, reject) => stream.end((err?: Error | null) => (err ? reject(err) : resolve()))),
  }
}

async function query(o: Options, db: DatabaseService, io: DbmIo): Promise<number> {
  const config = pickConnection(o)
  const sql = o.file ? readFileSync(o.file, 'utf8') : o.positional.join(' ')
  if (!sql.trim()) throw new Error('Give the SQL as an argument or with --file')
  const fmt = formatter(o.format ?? 'csv')
  await db.connect(config)
  const out = output(o, io)
  try {
    const statements = splitStatements(sql, config.driver).filter((s) => s.text)
    // One read: streamed, any size. Anything else runs as a script; the last result set is written.
    if (statements.length === 1 && isReadOnlyScript(statements[0]!.text, config.driver)) {
      let first = true
      let headed = false
      let n = 0
      for await (const batch of db.streamQuery(config.id, statements[0]!.text)) {
        if (!headed) {
          out.write(fmt.head(batch.fields))
          headed = true
        }
        for (const row of batch.rows) {
          out.write(fmt.row(batch.fields, row, first))
          first = false
          n++
        }
      }
      if (headed) out.write(fmt.tail())
      io.stderr(`${n} row${n === 1 ? '' : 's'}\n`)
      return 0
    }
    const outcomes = await db.runScript(config.id, sql)
    const failed = outcomes.find((x) => x.error)
    if (failed) throw new Error(`${failed.error!.message}\n  in: ${failed.sql.slice(0, 200)}`)
    const last = outcomes.flatMap((x) => x.results ?? []).filter((r) => r.fields.length).at(-1)
    if (last) {
      out.write(fmt.head(last.fields))
      last.rows.forEach((row, i) => out.write(fmt.row(last.fields, row, i === 0)))
      out.write(fmt.tail())
    }
    const affected = outcomes.reduce((sum, x) => sum + (x.results ?? []).reduce((s, r) => s + (r.affectedRows ?? 0), 0), 0)
    io.stderr(`${outcomes.length} statement${outcomes.length === 1 ? '' : 's'}${affected ? `, ${affected} rows changed` : ''}\n`)
    return 0
  } finally {
    await out.close()
  }
}

async function dictionary(o: Options, db: DatabaseService, io: DbmIo): Promise<number> {
  const config = pickConnection(o)
  const format = (o.format ?? 'html') as 'html' | 'markdown'
  if (format !== 'html' && format !== 'markdown') throw new Error('--format is html or markdown')
  const info = await db.connect(config)
  const snapshot = await db.schema(config.id)
  const text = buildDataDictionary(snapshot, { format, title: snapshot.database ?? config.name, subtitle: `${info.product} ${info.version}`, schemas: o.schemas.length ? o.schemas : undefined })
  if (o.out) writeFileSync(o.out, text, 'utf8')
  else io.stdout(text)
  io.stderr(`${snapshot.tables.length} tables${o.out ? ` → ${o.out}` : ''}\n`)
  return 0
}

function readModel(path: string | undefined, defaultSchema?: string, driver?: string) {
  if (!path) throw new Error('Give the model file (.dbml)')
  const model = parseDbml(readFileSync(path, 'utf8'), { defaultSchema, enumType: driver === 'mssql' ? 'nvarchar(50)' : driver === 'oracle' ? 'VARCHAR2(50)' : 'varchar(50)' })
  if (model.errors.length) throw new Error(model.errors.map((e) => `${path}:${e.line}: ${e.message}`).join('\n'))
  return model
}

function check(o: Options, io: DbmIo): number {
  const model = readModel(o.positional[0])
  const issues = checkModel(model.tables)
  const counted = issues.filter((i) => o.strict || i.severity === 'warning')
  for (const i of issues) io.stdout(`${i.severity}: ${i.schema ? `${i.schema}.` : ''}${i.table}${i.column ? `.${i.column}` : ''}: ${i.kind.replace(/_/g, ' ')}${i.detail ? ` (${i.detail})` : ''}\n`)
  io.stderr(`${model.tables.length} tables, ${issues.length} findings\n`)
  return counted.length ? 1 : 0
}

async function diff(o: Options, db: DatabaseService, io: DbmIo): Promise<number> {
  const config = pickConnection({ ...o, allowWrites: false })
  await db.connect(config)
  const live = await db.schema(config.id, true)
  const model = readModel(o.positional[0], live.defaultSchema, config.driver)
  const checkChanged = await findChangedChecks(model.tables, live.tables, (items) => db.canonicalChecks(config.id, items)).catch(() => undefined)
  const changes = compareSchemas(model.tables, live.tables, { keepExtra: !o.dropExtra, model: true, checkChanged })
  if (!changes.length) {
    io.stderr('The database matches the model.\n')
    return 0
  }
  const dialect = getDialect(config.driver)
  const script = migrationScript(generateMigration(changes, dialect, live.tables), dialect)
  if (o.out) writeFileSync(o.out, script, 'utf8')
  else io.stdout(script)
  io.stderr(`${changes.length} change${changes.length === 1 ? '' : 's'} to make the database match the model${o.out ? ` → ${o.out}` : ''}\n`)
  return 2
}

/** Runs one dbm command; returns the exit code. Never throws: errors go to stderr with exit code 1. */
export async function runDbm(argv: string[], io: DbmIo, db = new DatabaseService()): Promise<number> {
  try {
    const o = parse(argv)
    switch (o.command) {
      case 'query':
        return await query(o, db, io)
      case 'dictionary':
        return await dictionary(o, db, io)
      case 'check':
        return check(o, io)
      case 'diff':
        return await diff(o, db, io)
      case '':
      case 'help':
      case '-h':
      case '--help':
        io.stdout(DBM_HELP)
        return o.command ? 0 : 1
      default:
        throw new Error(`Unknown command ${o.command}. Commands: query, dictionary, check, diff`)
    }
  } catch (err) {
    io.stderr(`dbm: ${describeError(err).message}\n`)
    return 1
  } finally {
    await db.disconnectAll().catch(() => {})
  }
}

import { getDialect, qualify } from './dialect.js'
import { createScript } from './ddl.js'
import type { DatabaseService } from './engine.js'
import { findPartition, findTable } from './schema-utils.js'
import type { DriverId, PartitionInfo, RoutineInfo, TableInfo, TableRef } from './types.js'
import { cellToText } from './values.js'

/** A view, function or procedure (or a table, whose CREATE statement is generated) whose SQL definition is wanted. */
export interface DefinedObject {
  schema?: string
  name: string
  kind: 'table' | 'view' | 'materialized_view' | 'function' | 'procedure' | 'sequence' | 'type' | 'extension'
  /** A routine's arguments as the explorer lists them (tells PostgreSQL overloads apart). */
  arguments?: string | null
}

export interface ObjectDefinition {
  /** Ready to edit and run: CREATE OR REPLACE (or what the database has instead). */
  sql: string
}

/** Engines that can show what (beyond tables) as SQL. */
export function definitionSupport(driver: DriverId): { views: boolean; routines: boolean } {
  switch (driver) {
    case 'postgres':
    case 'mysql':
    case 'mariadb':
    case 'mssql':
    case 'oracle':
    case 'duckdb':
      return { views: true, routines: true }
    case 'sqlite':
    case 'clickhouse':
    case 'bigquery':
    case 'trino':
      return { views: true, routines: false }
  }
}

/** Skips whitespace and comments at the start of a statement; returns where its first word begins. */
function statementStart(sql: string): number {
  let i = 0
  for (;;) {
    while (i < sql.length && /\s/.test(sql[i]!)) i++
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? sql.length : nl + 1
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 2
    } else return i
  }
}

/**
 * Rewrites the leading `CREATE` (after any comments) of a definition as `replacement` (CREATE OR REPLACE, CREATE OR
 * ALTER). A definition that already says OR REPLACE / OR ALTER keeps it; text without a leading CREATE is unchanged.
 */
export function withLeadingCreate(sql: string, replacement: string): string {
  const at = statementStart(sql)
  const m = /^CREATE(\s+OR\s+(REPLACE|ALTER))?\b/i.exec(sql.slice(at))
  if (!m) return sql
  return sql.slice(0, at) + replacement + sql.slice(at + m[0].length)
}

/**
 * Oracle source ("FUNCTION name (…) RETURN …" as ALL_SOURCE keeps it) with the routine's name replaced by
 * `qualified`. Comments before and inside the header, quoted names, Unicode names and an existing owner are handled;
 * a header it can't read throws rather than leave the name unqualified.
 */
export function qualifyOracleHeader(source: string, qualified: string): string {
  let i = 0
  const skip = () => {
    for (;;) {
      while (i < source.length && /\s/.test(source[i]!)) i++
      if (source.startsWith('--', i)) {
        const nl = source.indexOf('\n', i)
        i = nl === -1 ? source.length : nl + 1
      } else if (source.startsWith('/*', i)) {
        const end = source.indexOf('*/', i + 2)
        if (end === -1) throw new Error('Could not read the routine’s header')
        i = end + 2
      } else return
    }
  }
  const identifier = (): boolean => {
    if (source[i] === '"') {
      const end = source.indexOf('"', i + 1)
      if (end === -1) return false
      i = end + 1
      return true
    }
    const start = i
    while (i < source.length && /[\p{L}\p{N}_$#]/u.test(source[i]!)) i++
    return i > start
  }
  skip()
  const keyword = /^(FUNCTION|PROCEDURE)\b/i.exec(source.slice(i))
  if (!keyword) throw new Error('Could not read the routine’s header')
  i += keyword[0].length
  skip()
  const nameStart = i
  if (!identifier()) throw new Error('Could not read the routine’s header')
  let nameEnd = i
  const afterFirst = i
  skip()
  if (source[i] === '.') {
    i++
    skip()
    if (!identifier()) throw new Error('Could not read the routine’s header')
    nameEnd = i
  } else i = afterFirst
  return source.slice(0, nameStart) + qualified + source.slice(nameEnd)
}

const ensureSemicolon =(sql: string) => (/;\s*$/.test(sql) ? sql.trimEnd() : `${sql.trimEnd()};`)

/**
 * The SQL that defines an object, as the database keeps it, in a form that changes the object when run.
 * Tables get the CREATE statement the app generates from the catalog (marked as such).
 */
export async function objectDefinition(db: DatabaseService, id: string, object: DefinedObject): Promise<ObjectDefinition> {
  const config = db.config(id)
  const dialect = getDialect(config.driver)
  if (object.kind === 'table') {
    const snapshot = await db.schema(id)
    const table = findTable(snapshot, { schema: object.schema, name: object.name })
    if (table) return { sql: tableDefinition(table, config.driver) }
    const partition = findPartition(snapshot, { schema: object.schema, name: object.name })
    if (partition) return { sql: partitionDefinition(partition.partition, partitionParent(partition.parent, partition.partition)) }
    throw new Error(`Table ${object.name} not found`)
  }
  if (object.kind === 'sequence' || object.kind === 'type' || object.kind === 'extension') {
    const found = (await db.schema(id)).objects?.find((o) => o.kind === object.kind && o.name === object.name && (o.schema ?? '') === (object.schema ?? ''))
    if (!found) throw new Error(`${object.name} was not found; refresh the explorer`)
    return { sql: `-- Generated from the catalog.\n${found.definition}\n` }
  }
  const driver = db.driver(id)
  const first = async (sql: string, params: unknown[]): Promise<Record<string, unknown> | undefined> => {
    const [r] = await driver.execute(sql, { params })
    if (!r?.rows.length) return undefined
    return Object.fromEntries(r.fields.map((f, i) => [f.name.toLowerCase(), r.rows[0]![i]]))
  }
  const text = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : cellToText(v as never))
  const notFound = () => new Error(`The definition of ${object.name} was not found (it may have been dropped, or you may not have the privilege to read it)`)
  const name = qualify(dialect, { schema: object.schema, name: object.name })
  const isView = object.kind === 'view' || object.kind === 'materialized_view'

  switch (config.driver) {
    case 'postgres': {
      if (isView) {
        const row = await first(
          `SELECT c.relkind::text AS kind, pg_get_viewdef(c.oid, true) AS def
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('v', 'm')`,
          [object.schema ?? 'public', object.name],
        )
        if (!row) throw notFound()
        const body = ensureSemicolon(text(row.def))
        return text(row.kind) === 'm'
          ? { sql: `-- A materialized view can't be replaced: DROP MATERIALIZED VIEW ${name}; first, then run this.\nCREATE MATERIALIZED VIEW ${name} AS\n${body}\n` }
          : { sql: `CREATE OR REPLACE VIEW ${name} AS\n${body}\n` }
      }
      const row = await first(
        `SELECT pg_get_functiondef(p.oid) AS def
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = $1 AND p.proname = $2 AND ($3::text IS NULL OR pg_get_function_arguments(p.oid) = $3::text)
          ORDER BY p.oid LIMIT 1`,
        [object.schema ?? 'public', object.name, object.arguments ?? null],
      )
      if (!row?.def) throw notFound()
      return { sql: `${ensureSemicolon(text(row.def))}\n` }
    }
    case 'mysql':
    case 'mariadb': {
      const kind = isView ? 'VIEW' : object.kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION'
      const row = await first(`SHOW CREATE ${kind} ${name}`, [])
      const def = row ? text(row[`create ${kind.toLowerCase()}`]) : ''
      if (!def) throw notFound()
      // MySQL has CREATE OR REPLACE for views only (MariaDB for routines too, but DROP + CREATE works on both).
      if (isView) return { sql: `${ensureSemicolon(withLeadingCreate(def, 'CREATE OR REPLACE'))}\n` }
      // A body's own semicolons need another delimiter, as in the mysql client and Workbench.
      return { sql: `DROP ${kind} IF EXISTS ${name};\n\nDELIMITER $$\n${def.trim().replace(/;\s*$/, '')}$$\nDELIMITER ;\n` }
    }
    case 'mssql': {
      const row = await first(`SELECT OBJECT_DEFINITION(OBJECT_ID(@p1)) AS def`, [name])
      const def = text(row?.def)
      if (!def) throw notFound()
      return { sql: `${withLeadingCreate(def.trim(), 'CREATE OR ALTER')}\n` }
    }
    case 'oracle': {
      // The session's own schema when none is given (not the user name upper-cased: mixed-case users exist).
      const owner = object.schema ?? text((await first(`SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS "s" FROM dual`, []))?.s)
      const ownName = qualify(dialect, { schema: owner, name: object.name })
      if (isView) {
        const row = await first(`SELECT text_vc AS "def" FROM all_views WHERE owner = :1 AND view_name = :2`, [owner, object.name])
        if (!row?.def) throw notFound()
        return { sql: `CREATE OR REPLACE VIEW ${ownName} AS\n${ensureSemicolon(text(row.def))}\n` }
      }
      const [r] = await driver.execute(`SELECT text AS "text" FROM all_source WHERE owner = :1 AND name = :2 AND type = :3 ORDER BY line`, {
        params: [owner, object.name, object.kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION'],
      })
      const source = (r?.rows ?? []).map((row) => text(row[0])).join('')
      if (!source.trim()) throw notFound()
      // ALL_SOURCE starts at "FUNCTION name": the CREATE is the caller's, and the name gets its owner (run as another
      // user, an unqualified name would create the routine in that user's own schema). "/" ends the block.
      return { sql: `CREATE OR REPLACE ${qualifyOracleHeader(source, ownName).trimEnd()}\n/\n` }
    }
    case 'duckdb': {
      if (isView) {
        const row = await first(`SELECT sql FROM duckdb_views() WHERE schema_name = $1 AND view_name = $2 AND NOT internal`, [object.schema ?? 'main', object.name])
        if (!row?.sql) throw notFound()
        return { sql: `${ensureSemicolon(withLeadingCreate(text(row.sql), 'CREATE OR REPLACE'))}\n` }
      }
      const row = await first(
        `SELECT function_type, parameters, macro_definition FROM duckdb_functions()
          WHERE schema_name = $1 AND function_name = $2 AND function_type IN ('macro', 'table_macro') AND NOT internal LIMIT 1`,
        [object.schema ?? 'main', object.name],
      )
      if (!row?.macro_definition) throw notFound()
      const params = Array.isArray(row.parameters) ? (row.parameters as unknown[]).map(text).join(', ') : text(row.parameters).replace(/^\[|\]$/g, '')
      const table = text(row.function_type) === 'table_macro' ? 'TABLE ' : ''
      return { sql: `CREATE OR REPLACE MACRO ${name}(${params}) AS ${table}${ensureSemicolon(text(row.macro_definition))}\n` }
    }
    case 'sqlite': {
      const row = await first(`SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?`, [object.name])
      if (!row?.sql) throw notFound()
      // SQLite has no CREATE OR REPLACE VIEW.
      return { sql: `DROP VIEW IF EXISTS ${name};\n\n${ensureSemicolon(text(row.sql))}\n` }
    }
    case 'clickhouse':
    case 'bigquery':
    case 'trino': {
      if (!isView) throw new Error('This database has no routine definitions to show')
      const view = findTable(await db.schema(id, true), { schema: object.schema, name: object.name })
      if (!view?.definition) throw notFound()
      return { sql: `CREATE OR REPLACE VIEW ${name} AS\n${ensureSemicolon(view.definition)}\n` }
    }
  }
}

/** A table's CREATE statement generated from the catalog (with its indexes and foreign keys). */
export function tableDefinition(table: TableInfo, driver: DriverId): string {
  // The primary key keeps its own name (people_pkey), not a made-up pk_people_id.
  const pkName = table.indexes.find((i) => i.primary)?.name
  // A PostgreSQL column filled by nextval() of its own sequence was declared serial: say so (an identity column
  // would be another thing, and the sequence would be left behind).
  const SERIAL: Record<string, string> = { integer: 'serial', bigint: 'bigserial', smallint: 'smallserial' }
  const shown =
    driver === 'postgres'
      ? { ...table, columns: table.columns.map((c) => (c.isIdentity && /^nextval\(/i.test(c.defaultValue ?? '') && SERIAL[c.dataType] ? { ...c, dataType: SERIAL[c.dataType]!, defaultValue: null } : c)) }
      : table
  let script = createScript([shown], getDialect(driver), pkName ? { primaryKeyName: () => pkName } : {}).trim()
  const d = getDialect(driver)
  const name = qualify(d, table)
  // PostgreSQL: partitioning, partitions, triggers and row-level security, which the generated CREATE TABLE lacks.
  if (table.partitionBy) {
    const head = `CREATE TABLE ${name} (`
    const at = script.indexOf(head)
    const close = at === -1 ? -1 : script.indexOf('\n)', at)
    if (close !== -1) script = `${script.slice(0, close + 2)} PARTITION BY ${table.partitionBy}${script.slice(close + 2)}`
  }
  const extra: string[] = []
  const partitions = (list: PartitionInfo[] | undefined, parent: TableRef) => {
    for (const p of list ?? []) {
      extra.push(partitionDefinition(p, parent).trim())
      partitions(p.partitions, p)
    }
  }
  partitions(table.partitions, table)
  for (const t of table.triggers ?? []) extra.push(t.definition)
  if (table.rowSecurity) extra.push(`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY;`)
  for (const p of table.policies ?? []) extra.push(p.definition)
  const what = ['columns', 'keys', 'indexes', 'foreign keys', ...(table.partitions?.length ? ['partitions'] : []), ...(table.triggers?.length ? ['triggers'] : []), ...(table.policies?.length || table.rowSecurity ? ['row-level security'] : [])]
  const list = what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what.at(-1)}` : what[0]
  return `-- Generated from the catalog (not the server's own text): ${list}.\n${script}${extra.length ? `\n\n${extra.join('\n\n')}` : ''}\n`
}

/** The table (or partition) a partition belongs to. */
function partitionParent(table: TableInfo, partition: PartitionInfo): TableRef {
  const within = (list: PartitionInfo[] | undefined, parent: TableRef): TableRef | undefined => {
    for (const p of list ?? []) {
      if (p === partition) return parent
      const inner = within(p.partitions, p)
      if (inner) return inner
    }
    return undefined
  }
  return within(table.partitions, table) ?? table
}

/** CREATE TABLE … PARTITION OF parent FOR VALUES … (PostgreSQL). */
function partitionDefinition(p: PartitionInfo, parent: TableRef): string {
  const d = getDialect('postgres')
  return `CREATE TABLE ${qualify(d, p)} PARTITION OF ${qualify(d, parent)} ${p.bound}${p.partitionBy ? ` PARTITION BY ${p.partitionBy}` : ''};\n`
}

/** The explorer row of a routine as the object to define. */
export const routineObject = (r: RoutineInfo): DefinedObject => ({ schema: r.schema, name: r.name, kind: r.kind, arguments: r.arguments ?? null })

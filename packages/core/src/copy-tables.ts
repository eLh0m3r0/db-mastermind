import { getDialect, qualify, type Dialect } from './dialect.js'
import { createScript } from './ddl.js'
import type { DatabaseService } from './engine.js'
import type { BuiltQuery } from './filters.js'
import { buildBatchInserts } from './import.js'
import { findTable } from './schema-utils.js'
import { translateTables } from './type-map.js'
import type { CellValue, DriverId, TableInfo, TableRef } from './types.js'
import { isBinaryValue } from './values.js'

/** Copies tables (structure and data) from one connection to another, even to another kind of database. */
export interface CopyTablesOptions {
  tables: TableRef[]
  /** The target's schema for the copies (default: the target's default schema; the same schema on the same engine). */
  targetSchema?: string
  /** Create the tables the target lacks (types translated as forward engineering does). */
  create: boolean
  /** append: add the rows; replace: empty the target tables first (all in reverse foreign-key order). */
  mode: 'append' | 'replace'
  /** Rows read and written per round. */
  batchRows?: number
  signal?: AbortSignal
  onProgress?: (progress: CopyProgress) => void
}

export interface CopyProgress {
  table: string
  /** 0-based position of the table in the copy order. */
  index: number
  total: number
  rows: number
  done: boolean
}

export interface CopiedTable {
  table: string
  target: string
  rows: number
  created: boolean
  /** Columns left out: binary (their values cross the app shortened), generated, or missing in the target. */
  skippedColumns: string[]
  /** What the user should know (keys of new rows on engines whose sequences are not moved). */
  warnings?: string[]
}

const lower = (s: string | undefined) => (s ?? '').toLowerCase()
const display = (t: { schema?: string; name: string }) => (t.schema ? `${t.schema}.${t.name}` : t.name)

/** Parents before children, so foreign keys hold while rows arrive; a cycle keeps the given order. */
export function copyOrder(tables: TableInfo[]): TableInfo[] {
  const key = (t: { schema?: string; name: string }) => `${t.schema ?? ''}.${t.name}`
  const byKey = new Map(tables.map((t) => [key(t), t]))
  const out: TableInfo[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (t: TableInfo) => {
    const k = key(t)
    if (state.get(k)) return
    state.set(k, 'visiting')
    for (const fk of t.foreignKeys) {
      const parent = byKey.get(key({ schema: fk.refSchema ?? t.schema, name: fk.refTable }))
      if (parent && parent !== t && state.get(key(parent)) !== 'visiting') visit(parent)
    }
    state.set(k, 'done')
    out.push(t)
  }
  for (const t of tables) visit(t)
  return out
}

/** A value as the target database's driver takes it as a parameter. */
export function copyValue(v: CellValue, target: DriverId): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === 'boolean') return target === 'sqlite' || target === 'oracle' ? (v ? 1 : 0) : v
  if (typeof v === 'object') return JSON.stringify(v)
  return v
}

/** Which target column each source column fills: the same name first, else the only case-insensitive match. */
export function columnPairs(from: TableInfo, into: TableInfo): { pairs: [string, string][]; skipped: string[] } {
  const pairs: [string, string][] = []
  const skipped: string[] = []
  for (const c of from.columns) {
    const exact = into.columns.find((x) => x.name === c.name)
    const loose = into.columns.filter((x) => lower(x.name) === lower(c.name))
    const there = exact ?? (loose.length === 1 ? loose[0] : undefined)
    const binary = /binary|blob|bytea|image|raw|varbinary/i.test(c.dataType)
    if (!there || there.isGenerated || c.isGenerated || binary || pairs.some(([, to]) => to === there.name)) skipped.push(c.name)
    else pairs.push([c.name, there.name])
  }
  return { pairs, skipped }
}

export async function copyTables(db: DatabaseService, sourceId: string, targetId: string, options: CopyTablesOptions): Promise<CopiedTable[]> {
  const sourceDriver = db.config(sourceId).driver
  const targetDriver = db.config(targetId).driver
  if (db.config(targetId).readOnly) throw new Error('The target connection is read-only')
  const stopped = () => new Error('The copy was stopped: nothing was changed in the target')
  const dialect = getDialect(targetDriver)
  const source = await db.schema(sourceId, true)
  const picked = options.tables.map((ref) => {
    const t = findTable(source, ref)
    if (!t || t.type !== 'table') throw new Error(`Table ${display(ref)} not found in the source`)
    return t
  })
  const ordered = copyOrder(picked)
  // The target schema itself (MySQL's snapshot holds only the current database, Oracle's the user's schema).
  const readTarget = async () => {
    const snapshot = await db.schema(targetId, true)
    if (!options.targetSchema || snapshot.schemas.some((s) => lower(s) === lower(options.targetSchema))) return snapshot
    const extra = await db.driver(targetId).introspect({ schemas: [options.targetSchema] })
    return { ...snapshot, schemas: [...snapshot.schemas, ...extra.schemas], tables: [...snapshot.tables, ...extra.tables] }
  }
  let target = await readTarget()
  const sameEngine = sourceDriver === targetDriver || (['mysql', 'mariadb'].includes(sourceDriver) && ['mysql', 'mariadb'].includes(targetDriver))
  const schemaFor = (t: TableInfo) => options.targetSchema ?? (sameEngine && t.schema && target.schemas.some((s) => lower(s) === lower(t.schema)) ? t.schema : target.defaultSchema)
  const targetRef = (t: TableInfo): TableRef => ({ schema: schemaFor(t), name: t.name })

  // Every source table into a table of its own, and never onto itself (checked before anything changes).
  const seen = new Map<string, string>()
  for (const t of ordered) {
    const ref = targetRef(t)
    const k = `${lower(ref.schema)}.${lower(ref.name)}`
    if (seen.has(k)) throw new Error(`${seen.get(k)} and ${display(t)} would both go into ${qualify(dialect, ref)}: copy them one schema at a time`)
    seen.set(k, display(t))
    if (sourceId === targetId && lower(ref.schema) === lower(t.schema)) throw new Error(`${display(t)} would be copied onto itself: choose another schema or connection`)
  }
  if (options.signal?.aborted) throw stopped()

  // 1. Tables the target lacks, created in one script (foreign keys only between tables it will have).
  const missing = ordered.filter((t) => !findTable(target, targetRef(t)))
  const created = new Set<string>()
  if (missing.length) {
    if (!options.create) throw new Error(`The target has no table ${missing.map((t) => t.name).join(', ')}: create them, or let the copy create them`)
    const known = (schema: string | undefined, name: string) => ordered.some((x) => x.name === name && (x.schema ?? '') === (schema ?? '')) || !!findTable(target, { schema, name })
    const drafts = missing.map((t) => ({
      ...t,
      schema: schemaFor(t),
      foreignKeys: t.foreignKeys.filter((fk) => known(fk.refSchema ?? t.schema, fk.refTable)).map((fk) => ({ ...fk, refSchema: fk.refSchema === undefined ? undefined : schemaFor({ ...t, schema: fk.refSchema }) })),
    }))
    // Across engines defaults stay behind (their functions and literals differ: getdate(), ((0)) for a boolean); the
    // rows bring their values anyway.
    const portable = sameEngine ? drafts : drafts.map((t) => ({ ...t, columns: t.columns.map((c) => ({ ...c, defaultValue: null })) }))
    const script = createScript(sameEngine ? portable : translateTables(portable, targetDriver, sourceDriver), dialect, { from: sourceDriver })
    const failed = (await db.runScript(targetId, script)).find((o) => o.error)
    if (failed) throw new Error(`Creating the tables failed: ${failed.error!.message}\n  in: ${failed.sql.slice(0, 300)}`)
    for (const t of missing) created.add(t.name)
    target = await readTarget()
  }

  // 2. Rows: one transaction on the target for all tables, so a failure or Stop leaves it as it was (a replace too).
  const driver = db.driver(targetId)
  const session = `copy-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const exec = async (q: BuiltQuery) => {
    if (options.signal?.aborted) throw stopped()
    return driver.execute(q.sql, { params: q.params, session, signal: options.signal })
  }
  const out: CopiedTable[] = []
  const batchRows = options.batchRows ?? 1000
  // DuckDB checks a foreign key against the transaction's start: its replace empties the tables first, one by one.
  if (options.mode === 'replace' && targetDriver === 'duckdb') {
    for (const t of [...ordered].reverse()) {
      if (options.signal?.aborted) throw stopped()
      await db.transactionRaw(targetId, [{ sql: `DELETE FROM ${qualify(dialect, targetRef(t))}`, params: [] }])
    }
  }
  try {
    if (dialect.begin) await exec({ sql: dialect.begin, params: [] })
    if (options.mode === 'replace' && targetDriver !== 'duckdb') {
      for (const t of [...ordered].reverse()) await exec({ sql: `DELETE FROM ${qualify(dialect, targetRef(t))}`, params: [] })
    }
    for (const [index, t] of ordered.entries()) {
      const into = findTable(target, targetRef(t))!
      const { pairs, skipped } = columnPairs(t, into)
      const warnings: string[] = []
      const targetColumns = pairs.map(([, to]) => to)
      let identity = into.columns.some((c) => c.isIdentity && targetColumns.includes(c.name))
      // SQL Server: the catalog says for sure (IDENTITY_INSERT is needed for any identity column the rows fill).
      if (targetDriver === 'mssql') {
        const [r] = await exec({ sql: `SELECT OBJECTPROPERTY(OBJECT_ID('${qualify(dialect, into).replaceAll("'", "''")}'), 'TableHasIdentity')`, params: [] })
        identity = Number(r?.rows[0]?.[0] ?? 0) === 1
      }
      const from = getDialect(sourceDriver)
      const select = `SELECT ${pairs.map(([c]) => from.quoteIdent(c)).join(', ')} FROM ${qualify(from, { schema: t.schema, name: t.name })}`
      let rows = 0
      options.onProgress?.({ table: t.name, index, total: ordered.length, rows, done: false })
      for await (const batch of db.streamQuery(sourceId, select, { batchSize: batchRows, signal: options.signal })) {
        if (!batch.rows.length) continue
        const values = batch.rows.map((r) => r.map((v) => (isBinaryValue(v) ? null : copyValue(v, targetDriver))))
        for (const q of insertStatements(dialect, into, targetColumns, values as (string | null)[][], identity)) await exec(q)
        rows += batch.rows.length
        options.onProgress?.({ table: t.name, index, total: ordered.length, rows, done: false })
      }
      if (identity && rows) {
        const withIdentity = into.columns.filter((c) => c.isIdentity && targetColumns.includes(c.name)).map((c) => c.name)
        if (targetDriver === 'postgres') {
          // Inside the transaction: a missing privilege fails the copy instead of leaving keys that will collide.
          const table = qualify(dialect, into)
          for (const c of withIdentity) {
            await exec({ sql: `SELECT setval(pg_get_serial_sequence('${table.replaceAll("'", "''")}', '${c.replaceAll("'", "''")}'), COALESCE((SELECT MAX(${dialect.quoteIdent(c)}) FROM ${table}), 1))`, params: [] })
          }
        } else if (targetDriver === 'duckdb' || targetDriver === 'oracle') {
          warnings.push('New rows’ generated keys are not moved past the copied ones: set the sequence before inserting.')
        }
      }
      options.onProgress?.({ table: t.name, index, total: ordered.length, rows, done: true })
      out.push({ table: t.name, target: qualify(dialect, into), rows, created: created.has(t.name), skippedColumns: skipped, ...(warnings.length ? { warnings } : {}) })
    }
    if (options.signal?.aborted) throw stopped()
    if (dialect.commit) await driver.execute(dialect.commit, { session })
  } catch (err) {
    if (dialect.rollback) await driver.execute(dialect.rollback, { session }).catch(() => {})
    throw options.signal?.aborted ? stopped() : err
  } finally {
    await driver.releaseSession(session).catch(() => {})
  }
  return out
}

/** INSERTs that keep the source's key values, also into identity columns. */
function insertStatements(dialect: Dialect, into: TableInfo, columns: string[], rows: (string | null)[][], identity: boolean): BuiltQuery[] {
  const ref = { schema: into.schema, name: into.name }
  const inserts = buildBatchInserts(ref, columns, rows, dialect)
  if (!identity) return inserts
  if (dialect.id === 'mssql') {
    // In the INSERT's own batch: parameterized statements run in sp_executesql, whose SET options end with it.
    const name = qualify(dialect, ref)
    return inserts.map((q) => ({ ...q, sql: `SET IDENTITY_INSERT ${name} ON; ${q.sql}; SET IDENTITY_INSERT ${name} OFF` }))
  }
  // PostgreSQL GENERATED ALWAYS refuses a value unless told; BY DEFAULT ones take it either way.
  if (dialect.id === 'postgres') return inserts.map((q) => ({ ...q, sql: q.sql.replace(/\) VALUES /, ') OVERRIDING SYSTEM VALUE VALUES ') }))
  return inserts
}

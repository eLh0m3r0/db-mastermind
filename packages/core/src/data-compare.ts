import type { Dialect } from './dialect.js'
import type { DatabaseService } from './engine.js'
import { buildChangeStatements, inlineParams, type EditValue, type RowChange } from './mutations.js'
import type { CellValue, TableRef } from './types.js'
import { isBinaryValue } from './values.js'

export interface DataCompareSide {
  connectionId: string
  table: TableRef
}

export interface DataCompareOptions {
  source: DataCompareSide
  target: DataCompareSide
  /** Columns identifying a row; defaults to the primary key. */
  keyColumns?: string[]
  /** Rows read from each side at most (default 200 000). */
  maxRows?: number
  /** Differences kept for display (counts are always complete). */
  maxDiffs?: number
  signal?: AbortSignal
}

export interface RowDiff {
  /** missing: only in source · extra: only in target · changed: different values. */
  kind: 'missing' | 'extra' | 'changed'
  key: Record<string, CellValue>
  source?: Record<string, CellValue>
  target?: Record<string, CellValue>
  changed?: string[]
}

export interface DataCompareResult {
  columns: string[]
  keyColumns: string[]
  /** Columns that exist on only one side (not compared). */
  skippedColumns: string[]
  sourceRows: number
  targetRows: number
  identical: number
  counts: { missing: number; extra: number; changed: number }
  diffs: RowDiff[]
  /** A side had more rows than `maxRows`: the result covers only the first rows by key. */
  truncated: boolean
}

const BATCH = 5000

/** Comparable form of a value: engines disagree on booleans (true vs 1) and numeric scale (1.50 vs 1.5). */
export function comparableValue(v: CellValue): string {
  if (v === null) return '\u0000NULL'
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') {
    // Leading zeros mean a code ("007"), not a number.
    if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(v)) {
      const n = Number(v)
      if (Number.isFinite(n) && Math.abs(n) < Number.MAX_SAFE_INTEGER) return String(n)
    }
    return v
  }
  return JSON.stringify(v)
}

async function readAll(db: DatabaseService, side: DataCompareSide, keyColumns: string[], max: number, signal?: AbortSignal) {
  const rows: Record<string, CellValue>[] = []
  let truncated = false
  for (let offset = 0; ; offset += BATCH) {
    const limit = Math.min(BATCH, max + 1 - rows.length)
    const page = await db.fetchTable(side.connectionId, {
      table: side.table,
      sort: keyColumns.map((column) => ({ column, direction: 'asc' as const })),
      limit,
      offset,
      signal,
    })
    const names = page.result.fields.map((f) => f.name)
    for (const r of page.result.rows) rows.push(Object.fromEntries(names.map((n, i) => [n, r[i] ?? null])))
    if (rows.length > max) {
      rows.length = max
      truncated = true
      break
    }
    if (page.result.rows.length < limit) break
  }
  return { rows, truncated }
}

/** Compares the rows of two tables (any two connections, even different engines) by key. */
export async function compareTableData(db: DatabaseService, options: DataCompareOptions): Promise<DataCompareResult> {
  const max = options.maxRows ?? 200_000
  const maxDiffs = options.maxDiffs ?? 5000
  const [sourceInfo, targetInfo] = await Promise.all([db.findTable(options.source.connectionId, options.source.table), db.findTable(options.target.connectionId, options.target.table)])
  if (!sourceInfo) throw new Error(`Table ${options.source.table.name} not found in the source`)
  if (!targetInfo) throw new Error(`Table ${options.target.table.name} not found in the target`)

  // Match columns by name, case-insensitively (Oracle upper-cases, others don't).
  const targetByLower = new Map(targetInfo.columns.map((c) => [c.name.toLowerCase(), c.name]))
  const pairs = sourceInfo.columns.filter((c) => targetByLower.has(c.name.toLowerCase())).map((c) => ({ source: c.name, target: targetByLower.get(c.name.toLowerCase())! }))
  const pairedLower = new Set(pairs.map((p) => p.source.toLowerCase()))
  const skippedColumns = [...sourceInfo.columns, ...targetInfo.columns].map((c) => c.name).filter((n) => !pairedLower.has(n.toLowerCase()))

  const requestedKeys = options.keyColumns?.length ? options.keyColumns : targetInfo.primaryKey.length ? targetInfo.primaryKey : sourceInfo.primaryKey
  const keyPairs = requestedKeys.map((k) => pairs.find((p) => p.source.toLowerCase() === k.toLowerCase() || p.target.toLowerCase() === k.toLowerCase()))
  if (!requestedKeys.length || keyPairs.some((p) => !p)) throw new Error('Choose key columns that exist in both tables (the tables have no common primary key)')
  const keys = keyPairs as { source: string; target: string }[]

  const [source, target] = await Promise.all([
    readAll(db, options.source, keys.map((k) => k.source), max, options.signal),
    readAll(db, options.target, keys.map((k) => k.target), max, options.signal),
  ])

  const keyOf = (row: Record<string, CellValue>, side: 'source' | 'target') => JSON.stringify(keys.map((k) => comparableValue(row[k[side]] ?? null)))
  const targetRows = new Map(target.rows.map((r) => [keyOf(r, 'target'), r]))
  const result: DataCompareResult = {
    columns: pairs.map((p) => p.target),
    keyColumns: keys.map((k) => k.target),
    skippedColumns,
    sourceRows: source.rows.length,
    targetRows: target.rows.length,
    identical: 0,
    counts: { missing: 0, extra: 0, changed: 0 },
    diffs: [],
    truncated: source.truncated || target.truncated,
  }
  // Rows are reported with target column names so the sync script can use them directly.
  const asTarget = (row: Record<string, CellValue>) => Object.fromEntries(pairs.map((p) => [p.target, row[p.source] ?? null]))
  const keyRecord = (row: Record<string, CellValue>) => Object.fromEntries(keys.map((k) => [k.target, row[k.target] ?? null]))
  const push = (d: RowDiff) => {
    result.counts[d.kind]++
    if (result.diffs.length < maxDiffs) result.diffs.push(d)
  }
  for (const s of source.rows) {
    const k = keyOf(s, 'source')
    const t = targetRows.get(k)
    const sourceRow = asTarget(s)
    if (!t) {
      push({ kind: 'missing', key: keyRecord(sourceRow), source: sourceRow })
      continue
    }
    targetRows.delete(k)
    const changed = pairs.filter((p) => comparableValue(s[p.source] ?? null) !== comparableValue(t[p.target] ?? null)).map((p) => p.target)
    if (changed.length) push({ kind: 'changed', key: keyRecord(sourceRow), source: sourceRow, target: t, changed })
    else result.identical++
  }
  for (const t of targetRows.values()) push({ kind: 'extra', key: keyRecord(t), target: t })
  return result
}

function editValue(v: CellValue): EditValue {
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (isBinaryValue(v)) throw new Error('Binary columns cannot be synchronized with a script')
  return JSON.stringify(v)
}

export interface DataSyncOptions {
  insertMissing?: boolean
  updateChanged?: boolean
  deleteExtra?: boolean
}

/**
 * SQL that makes the target table match the source for the listed differences
 * (DELETE extra rows, UPDATE changed columns, INSERT missing rows), in one transaction.
 */
export function dataSyncScript(result: DataCompareResult, table: TableRef, dialect: Dialect, options: DataSyncOptions = {}): string {
  const { insertMissing = true, updateChanged = true, deleteExtra = false } = options
  const key = (d: RowDiff) => Object.fromEntries(Object.entries(d.key).map(([k, v]) => [k, editValue(v)]))
  const changes: RowChange[] = []
  if (deleteExtra) for (const d of result.diffs) if (d.kind === 'extra') changes.push({ type: 'delete', key: key(d) })
  if (updateChanged) {
    for (const d of result.diffs) {
      if (d.kind !== 'changed' || !d.source || !d.changed) continue
      changes.push({ type: 'update', key: key(d), values: Object.fromEntries(d.changed.map((c) => [c, editValue(d.source![c] ?? null)])) })
    }
  }
  if (insertMissing) {
    for (const d of result.diffs) {
      if (d.kind === 'missing' && d.source) changes.push({ type: 'insert', values: Object.fromEntries(Object.entries(d.source).map(([c, v]) => [c, editValue(v)])) })
    }
  }
  if (!changes.length) return ''
  const statements = buildChangeStatements(table, changes, dialect).map((q) => `${inlineParams(q, dialect)};`)
  const notes: string[] = []
  if (result.diffs.length < result.counts.missing + result.counts.extra + result.counts.changed) {
    notes.push(`-- Only the first ${result.diffs.length} differences are included; compare again after running this script.`)
  }
  if (result.truncated) notes.push('-- The tables were larger than the compare limit: rows beyond it were not compared.')
  const identityInsert = dialect.id === 'mssql' && insertMissing && changes.some((c) => c.type === 'insert')
  return [
    ...notes,
    dialect.id === 'mssql' ? 'SET XACT_ABORT ON;' : '',
    `${dialect.begin};`,
    ...(identityInsert ? [`-- If the key is an IDENTITY column, wrap the INSERTs in SET IDENTITY_INSERT … ON / OFF.`] : []),
    ...statements,
    `${dialect.commit};`,
  ]
    .filter(Boolean)
    .join('\n')
}

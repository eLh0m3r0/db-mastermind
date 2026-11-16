import { buildBatchInserts, createDriver, isBinaryValue, qualify, type BuiltQuery, type Dialect, type TableRef } from '@dbmastermind/core'

const sourceOf = (path: string) => `read_parquet('${path.replaceAll("'", "''")}')`

// Values as written (cellToText is for display: it shortens numbers and binary data).
const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  if (isBinaryValue(v as never)) throw new Error('The Parquet file has binary columns, which can’t be imported')
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

/**
 * A Parquet file's rows (header first) as text, read by an in-memory DuckDB; `limit`: only that many rows (the
 * preview), with `total` (header included, as for the other formats) from the file's metadata.
 */
export async function readParquet(path: string, limit?: number): Promise<{ rows: string[][]; total: number }> {
  const duck = createDriver({ id: 'parquet-import', name: 'parquet', driver: 'duckdb' })
  await duck.connect()
  try {
    const source = sourceOf(path)
    const [r] = await duck.execute(`SELECT * FROM ${source}${limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(limit))}` : ''}`)
    if (!r) return { rows: [], total: 0 }
    const rows = [r.fields.map((f) => f.name), ...r.rows.map((row) => row.map(text) as string[])]
    if (limit === undefined) return { rows, total: rows.length }
    const [count] = await duck.execute(`SELECT count(*) AS n FROM ${source}`)
    return { rows, total: Number(count?.rows[0]?.[0] ?? 0) + 1 }
  } finally {
    await duck.close().catch(() => {})
  }
}

export interface ParquetImport {
  table: TableRef
  /** Target column for each file column; null skips it. */
  mapping: (string | null)[]
  /** The first row (the column names, as the preview showed them) is not imported. */
  hasHeader: boolean
  emptyAsNull: boolean
  replace: boolean
  dialect: Dialect
}

/**
 * The INSERT statements of a Parquet import, one batch per chunk DuckDB streams (~2048 rows): only one chunk is in
 * memory at a time (for DatabaseService.transactionBatches, which pulls the next batch after the previous ran).
 * `imported.rows` counts the rows handed out so far.
 */
export function parquetInsertBatches(path: string, options: ParquetImport, imported: { rows: number } = { rows: 0 }): AsyncIterable<BuiltQuery[]> {
  const used = options.mapping.map((target, i) => ({ target, i })).filter((m): m is { target: string; i: number } => !!m.target)
  if (!used.length) throw new Error('Map at least one column')
  return {
    async *[Symbol.asyncIterator]() {
      const duck = createDriver({ id: 'parquet-import', name: 'parquet', driver: 'duckdb' })
      await duck.connect()
      try {
        // The preview's first row is the column names: "first row is a header" skips it, as for the other formats.
        let header = true
        if (options.replace) yield [{ sql: `DELETE FROM ${qualify(options.dialect, options.table)}`, params: [] }]
        for await (const batch of duck.stream!(`SELECT * FROM ${sourceOf(path)}`)) {
          const rows: (string | null)[][] = []
          if (header) {
            header = false
            if (!options.hasHeader) rows.push(batch.fields.map((f) => f.name))
          }
          for (const row of batch.rows) rows.push(row.map(text))
          if (!rows.length) continue
          imported.rows += rows.length
          yield buildBatchInserts(options.table, used.map((m) => m.target), rows.map((r) => used.map((m) => r[m.i] ?? null)), options.dialect, { emptyAsNull: options.emptyAsNull })
        }
      } finally {
        await duck.close().catch(() => {})
      }
    },
  }
}

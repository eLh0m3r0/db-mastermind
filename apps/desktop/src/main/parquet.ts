import { createDriver, isBinaryValue } from '@dbmastermind/core'

/**
 * A Parquet file's rows (header first) as text, read by an in-memory DuckDB; `limit`: only that many rows (the
 * preview), with `total` (header included, as for the other formats) from the file's metadata.
 */
export async function readParquet(path: string, limit?: number): Promise<{ rows: string[][]; total: number }> {
  const duck = createDriver({ id: 'parquet-import', name: 'parquet', driver: 'duckdb' })
  await duck.connect()
  try {
    const source = `read_parquet('${path.replaceAll("'", "''")}')`
    const [r] = await duck.execute(`SELECT * FROM ${source}${limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(limit))}` : ''}`)
    if (!r) return { rows: [], total: 0 }
    // Values as written (cellToText is for display: it shortens numbers and binary data).
    const text = (v: unknown) => {
      if (v === null) return null
      if (isBinaryValue(v as never)) throw new Error('The Parquet file has binary columns, which can’t be imported')
      return typeof v === 'object' ? JSON.stringify(v) : String(v)
    }
    const rows = [r.fields.map((f) => f.name), ...r.rows.map((row) => row.map(text) as string[])]
    if (limit === undefined) return { rows, total: rows.length }
    const [count] = await duck.execute(`SELECT count(*) AS n FROM ${source}`)
    return { rows, total: Number(count?.rows[0]?.[0] ?? 0) + 1 }
  } finally {
    await duck.close().catch(() => {})
  }
}

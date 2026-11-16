import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createDriver, DatabaseService } from '@dbmastermind/core'
import { parquetInsertBatches, readParquet } from '../src/main/parquet'

const dir = mkdtempSync(join(tmpdir(), 'dbm-parquet-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('Parquet import preview', () => {
  it('reads only the rows it shows and counts the rest from the file', async () => {
    const path = join(dir, 'big.parquet')
    const duck = createDriver({ id: 'make', name: 'make', driver: 'duckdb' })
    await duck.connect()
    await duck.execute(`COPY (SELECT range AS id, 'row ' || range AS note FROM range(5000)) TO '${path}' (FORMAT parquet)`)
    await duck.close()

    const preview = await readParquet(path, 50)
    expect(preview.rows).toHaveLength(51)
    expect(preview.rows[0]).toEqual(['id', 'note'])
    expect(preview.total).toBe(5001)

    const all = await readParquet(path)
    expect(all.rows).toHaveLength(5001)
  })

  it('imports chunk by chunk in one transaction, and a failure leaves nothing behind', async () => {
    const path = join(dir, 'import.parquet')
    const duck = createDriver({ id: 'make2', name: 'make2', driver: 'duckdb' })
    await duck.connect()
    await duck.execute(`COPY (SELECT range AS id, 'row ' || range AS note FROM range(5000)) TO '${path}' (FORMAT parquet)`)
    await duck.close()

    const svc = new DatabaseService()
    await svc.connect({ id: 'target', name: 'target', driver: 'duckdb' })
    try {
      await svc.runScript('target', 'CREATE TABLE t (id BIGINT PRIMARY KEY, note VARCHAR)')
      const options = { table: { name: 't' }, mapping: ['id', 'note'], hasHeader: true, emptyAsNull: false, replace: false, dialect: svc.driver('target').dialect }
      const counted = { rows: 0 }
      const sizes: number[] = []
      const batches = parquetInsertBatches(path, options, counted)
      const watched = {
        async *[Symbol.asyncIterator]() {
          for await (const b of batches) {
            sizes.push(b.reduce((n, q) => n + q.params.length, 0) / 2)
            yield b
          }
        },
      }
      await svc.transactionBatches('target', watched)
      expect(counted.rows).toBe(5000)
      // More than one chunk, none of them the whole file.
      expect(sizes.length).toBeGreaterThan(1)
      expect(Math.max(...sizes)).toBeLessThan(5000)
      const [n] = await svc.runScript('target', 'SELECT count(*) FROM t')
      expect(Number(n!.results![0]!.rows[0]![0])).toBe(5000)

      // The same rows again: the keys clash in a later statement, the whole import is rolled back, the rows stay.
      await expect(svc.transactionBatches('target', parquetInsertBatches(path, { ...options, replace: false }))).rejects.toThrow()
      const [again] = await svc.runScript('target', 'SELECT count(*) FROM t')
      expect(Number(again!.results![0]!.rows[0]![0])).toBe(5000)
    } finally {
      await svc.disconnectAll()
    }
  })
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createDriver } from '@dbmastermind/core'
import { readParquet } from '../src/main/parquet'

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
})

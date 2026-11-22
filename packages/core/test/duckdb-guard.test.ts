import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseService } from '../src/index.js'

// Review round 3: SQL nobody confirmed on DuckDB reads no file the user didn't hand to the connection, fetches no URL,
// and the user's own queries keep their external access.
const dir = mkdtempSync(join(tmpdir(), 'dbm-duckguard-'))
const svc = new DatabaseService()
afterAll(async () => {
  await svc.disconnectAll()
  rmSync(dir, { recursive: true, force: true })
})

describe('DuckDB: what SQL nobody confirmed may read', () => {
  it('only the files handed to the connection; no other file, glob or URL', { timeout: 60_000 }, async () => {
    const csv = join(dir, 'orders.csv')
    const other = join(dir, 'secret.txt')
    writeFileSync(csv, 'id,total\n1,10\n2,20\n')
    writeFileSync(other, 'not for you')
    await svc.connect({ id: 'files', name: 'Files', driver: 'duckdb' })
    svc.allowFiles('files', [csv])
    const [asked] = await svc.runScript('files', `SELECT sum(total) AS s FROM read_csv('${csv}')`, { readOnly: true })
    expect(asked!.error).toBeUndefined()
    expect(Number(asked!.results![0]!.rows[0]![0])).toBe(30)
    for (const sql of [`SELECT * FROM read_text('${other}')`, "SELECT * FROM read_text('/etc/hosts')", "SELECT * FROM glob('/Users/*/.ssh/*')", "SELECT * FROM read_csv('https://example.com/x.csv')", "SELECT * FROM read_parquet('s3://bucket/x.parquet')"]) {
      const [o] = await svc.runScript('files', sql, { readOnly: true })
      expect(o!.error?.message, sql).toMatch(/Permission Error|disabled by configuration|not allowed/i)
    }
    // The user's own query on the same connection still reads what it is told to.
    const [own] = await svc.runScript('files', `SELECT * FROM read_text('${other}')`)
    expect(own!.error).toBeUndefined()
  })

  it('a DuckDB database file: its tables are readable, the rest of the machine is not', { timeout: 60_000 }, async () => {
    const file = join(dir, 'shop.duckdb')
    await svc.connect({ id: 'shop', name: 'shop', driver: 'duckdb', filePath: file })
    await svc.runScript('shop', "CREATE TABLE t AS SELECT 42 AS answer")
    const [read] = await svc.runScript('shop', 'SELECT answer FROM t', { readOnly: true })
    expect(Number(read!.results![0]!.rows[0]![0])).toBe(42)
    const [hosts] = await svc.runScript('shop', "SELECT * FROM read_text('/etc/hosts')", { readOnly: true })
    expect(hosts!.error?.message).toMatch(/Permission Error|disabled by configuration/i)
  })
})

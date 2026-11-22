import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
      expect(o!.error?.message, sql).toMatch(/can't be read here: open it in DB Mastermind with Query a file, or allow it with --allow-files|Permission Error/)
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
    expect(hosts!.error?.message).toBe(`"/etc/hosts" can't be read here: open it in DB Mastermind with Query a file, or allow it with --allow-files (dbmastermind-mcp, dbm).`)
  })
})

describe("DuckDB: the files saved with the connection (its `files`, --allow-files), across runs", () => {
  const data = join(dir, 'data')
  const elsewhere = join(dir, 'elsewhere')
  mkdirSync(join(data, 'sub'), { recursive: true })
  mkdirSync(elsewhere, { recursive: true })
  writeFileSync(join(data, 'a.csv'), 'amount\n1\n')
  writeFileSync(join(data, 'b.csv'), 'amount\n2\n')
  writeFileSync(join(data, 'sub', 'c.csv'), 'amount\n4\n')
  writeFileSync(join(elsewhere, 'x.csv'), 'amount\n100\n')
  const sum = async (id: string, from: string) => {
    const [o] = await svc.runScript(id, `SELECT sum(amount) AS s FROM read_csv('${from}')`, { readOnly: true })
    return o!.error ? o!.error.message : Number(o!.results![0]!.rows[0]![0])
  }

  it('a file in the list is readable from a fresh connection; another file is refused with what to do', { timeout: 60_000 }, async () => {
    await svc.connect({ id: 'saved', name: 'Duck', driver: 'duckdb', files: [join(data, 'a.csv')] })
    expect(await sum('saved', join(data, 'a.csv'))).toBe(1)
    expect(await sum('saved', join(elsewhere, 'x.csv'))).toBe(`"${join(elsewhere, 'x.csv')}" can't be read here: open it in DB Mastermind with Query a file, or allow it with --allow-files (dbmastermind-mcp, dbm).`)
    await expect(async () => {
      for await (const _ of svc.streamQuery('saved', `SELECT * FROM read_csv('${join(elsewhere, 'x.csv')}')`, { readOnly: true })) void _
    }).rejects.toThrow(/can't be read here/)
  })

  it('a folder allows the files under it and globs inside it; not outside, not through .., not with a link in it', { timeout: 60_000 }, async () => {
    await svc.connect({ id: 'folder', name: 'Duck', driver: 'duckdb', files: [data] })
    expect(await sum('folder', join(data, 'b.csv'))).toBe(2)
    expect(await sum('folder', join(data, '*.csv'))).toBe(3)
    expect(await sum('folder', join(data, '**', '*.csv'))).toBe(7)
    expect(await sum('folder', join(elsewhere, '*.csv'))).toMatch(/can't be read here/)
    expect(await sum('folder', `${data}/../elsewhere/x.csv`)).toMatch(/can't be read here/)
    // A link inside the folder (DuckDB would follow it): the folder is not allowed at all.
    const linked = join(dir, 'linked')
    mkdirSync(linked, { recursive: true })
    writeFileSync(join(linked, 'ok.csv'), 'amount\n8\n')
    symlinkSync(join(elsewhere, 'x.csv'), join(linked, 'link.csv'))
    await svc.connect({ id: 'linked', name: 'Duck', driver: 'duckdb', files: [linked, `${data}/../elsewhere`] })
    expect(await sum('linked', join(linked, 'link.csv'))).toMatch(/can't be read here/)
    expect(await sum('linked', join(linked, 'ok.csv'))).toMatch(/can't be read here/)
    expect(await sum('linked', join(elsewhere, 'x.csv'))).toMatch(/can't be read here/)
  })
})

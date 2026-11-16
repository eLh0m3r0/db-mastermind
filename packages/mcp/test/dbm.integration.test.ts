import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DatabaseService } from '@dbmastermind/core'
import { runDbm } from '../src/dbm'

const PG_URL = 'postgres://postgres:mastermind@127.0.0.1:54329/mastermind'
const skip = (process.env.DBM_SKIP ?? '').split(',').includes('postgres')
const dir = mkdtempSync(join(tmpdir(), 'dbm-diff-'))

async function dbm(...argv: string[]) {
  let stdout = ''
  let stderr = ''
  const code = await runDbm(argv, { stdout: (t) => void (stdout += t), stderr: (t) => void (stderr += t) })
  return { code, stdout, stderr }
}

describe.skipIf(skip)('dbm diff on PostgreSQL', () => {
  const db = new DatabaseService()
  beforeAll(async () => {
    await db.connect({ id: 'pg', name: 'pg', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' })
    for (const sql of ['DROP SCHEMA IF EXISTS dbm_diff CASCADE', 'CREATE SCHEMA dbm_diff', 'CREATE TABLE dbm_diff.items (id int PRIMARY KEY, qty int NOT NULL, CONSTRAINT qty_positive CHECK (qty > 0))']) {
      const [o] = await db.runScript('pg', sql)
      if (o?.error) throw new Error(o.error.message)
    }
  })
  afterAll(async () => {
    await db.runScript('pg', 'DROP SCHEMA IF EXISTS dbm_diff CASCADE')
    await db.disconnectAll()
    rmSync(dir, { recursive: true, force: true })
  })

  const model = (condition: string) => {
    const path = join(dir, `${condition.replace(/\W+/g, '_')}.dbml`)
    writeFileSync(path, `Table dbm_diff.items {\n  id int [pk]\n  qty int [not null]\n\n  checks {\n    \`${condition}\` [name: 'qty_positive']\n  }\n}\n`)
    return path
  }

  it('finds a check whose condition changed under the same name, on its read-only connection (review finding)', async () => {
    expect(await dbm('diff', model('qty > 0'), '--url', PG_URL)).toMatchObject({ code: 0, stderr: expect.stringMatching(/matches/) })
    const r = await dbm('diff', model('qty >= 0'), '--url', PG_URL)
    expect(r.code).toBe(2)
    expect(r.stdout).toMatch(/DROP CONSTRAINT "qty_positive"[\s\S]*ADD CONSTRAINT "qty_positive" CHECK \(qty >= 0\)/)
  })
})

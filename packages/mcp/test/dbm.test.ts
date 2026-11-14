import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DatabaseService } from '@dbmastermind/core'
import { runDbm } from '../src/dbm'

const dir = mkdtempSync(join(tmpdir(), 'dbm-cli-'))
const file = join(dir, 'shop.db')
const url = `sqlite://${file}`
afterAll(() => rmSync(dir, { recursive: true, force: true }))

beforeAll(async () => {
  const db = new DatabaseService()
  await db.connect({ id: 'x', name: 'x', driver: 'sqlite', filePath: file })
  for (const sql of [
    'CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT)',
    `INSERT INTO customers (name, note) VALUES ('Alice', 'says "hi", twice'), ('Bob', NULL)`,
  ])
    await db.runScript('x', sql)
  await db.disconnectAll()
})

async function dbm(...argv: string[]) {
  let stdout = ''
  let stderr = ''
  const code = await runDbm(argv, {
    stdout: (t) => {
      stdout += t
    },
    stderr: (t) => {
      stderr += t
    },
  })
  return { code, stdout, stderr }
}

describe('dbm query', () => {
  it('writes CSV by default, quoting what needs it', async () => {
    const r = await dbm('query', '--url', url, 'SELECT id, name, note FROM customers ORDER BY id')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('id,name,note\n1,Alice,"says ""hi"", twice"\n2,Bob,\n')
    expect(r.stderr).toMatch(/2 rows/)
  })

  it('JSON, JSON Lines and Markdown, and --out to a file', async () => {
    expect(JSON.parse((await dbm('query', '--url', url, '--format', 'json', 'SELECT id, note FROM customers ORDER BY id')).stdout)).toEqual([
      { id: 1, note: 'says "hi", twice' },
      { id: 2, note: null },
    ])
    expect((await dbm('query', '--url', url, '--format', 'jsonl', 'SELECT name FROM customers ORDER BY id')).stdout).toBe('{"name":"Alice"}\n{"name":"Bob"}\n')
    expect((await dbm('query', '--url', url, '--format', 'markdown', 'SELECT name FROM customers ORDER BY id')).stdout).toBe('| name |\n| --- |\n| Alice |\n| Bob |\n')
    const out = join(dir, 'out.tsv')
    expect((await dbm('query', '--url', url, '--format', 'tsv', '--out', out, 'SELECT name FROM customers ORDER BY id')).stdout).toBe('')
    expect(readFileSync(out, 'utf8')).toBe('name\nAlice\nBob\n')
  })

  it('is read-only unless --allow-writes', async () => {
    const refused = await dbm('query', '--url', url, "INSERT INTO customers (name) VALUES ('Eve')")
    expect(refused.code).toBe(1)
    expect(refused.stderr).toMatch(/read-only/i)
    const done = await dbm('query', '--url', url, '--allow-writes', "INSERT INTO customers (name) VALUES ('Eve')")
    expect(done.code).toBe(0)
    expect((await dbm('query', '--url', url, 'SELECT count(*) AS n FROM customers')).stdout).toBe('n\n3\n')
  })

  it('waits for a slow output and reports a file it can not write (review findings)', async () => {
    let text = ''
    let pending = 0
    let most = 0
    const code = await runDbm(['query', '--url', url, 'SELECT name FROM customers ORDER BY id'], {
      stdout: async (t) => {
        pending++
        most = Math.max(most, pending)
        await new Promise((r) => setTimeout(r, 5))
        text += t
        pending--
      },
      stderr: () => {},
    })
    expect(code).toBe(0)
    expect(text).toBe('name\nAlice\nBob\nEve\n')
    expect(most).toBe(1)
    const r = await dbm('query', '--url', url, '--out', join(dir, 'no', 'such', 'folder', 'x.csv'), 'SELECT 1 AS one')
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/Could not write/)
  })

  it('reads the SQL from a file and says what is wrong', async () => {
    writeFileSync(join(dir, 'q.sql'), 'SELECT name FROM customers WHERE id = 1;\n')
    expect((await dbm('query', '--url', url, '--file', join(dir, 'q.sql'))).stdout).toBe('name\nAlice\n')
    expect(await dbm('query', '--url', url, 'SELECT * FROM nope')).toMatchObject({ code: 1, stderr: expect.stringMatching(/no such table/) })
    expect(await dbm('query', 'SELECT 1')).toMatchObject({ code: 1, stderr: expect.stringMatching(/--url/) })
    expect(await dbm('query', '--url', url, '--format', 'xml', 'SELECT 1')).toMatchObject({ code: 1, stderr: expect.stringMatching(/Unknown format/) })
  })
})

describe('dbm check / diff / dictionary', () => {
  const model = (extra = '') => {
    const path = join(dir, `model${extra ? '-x' : ''}.dbml`)
    writeFileSync(path, `Table customers {\n  id integer [pk]\n  name text [not null]\n  note text\n${extra}}\n`)
    return path
  }

  it('check: exit 1 on problems, 0 without', async () => {
    const bad = join(dir, 'bad.dbml')
    writeFileSync(bad, 'Table logs {\n  message text\n}\n')
    expect(await dbm('check', bad)).toMatchObject({ code: 1, stdout: expect.stringMatching(/logs: no primary key/) })
    expect((await dbm('check', model())).code).toBe(0)
  })

  it('diff: 0 when the database matches the model, 2 with the migration when it does not', async () => {
    expect(await dbm('diff', model(), '--url', url)).toMatchObject({ code: 0, stderr: expect.stringMatching(/matches/) })
    const r = await dbm('diff', model('  vip boolean\n'), '--url', url)
    expect(r.code).toBe(2)
    expect(r.stdout).toMatch(/ALTER TABLE ("main"\.)?"customers" ADD COLUMN "vip"/)
  })

  it('dictionary: Markdown with the tables', async () => {
    const r = await dbm('dictionary', '--url', url, '--format', 'markdown')
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/customers/)
  })

  it('help and unknown commands', async () => {
    expect(await dbm('--help')).toMatchObject({ code: 0, stdout: expect.stringMatching(/dbm query/) })
    expect(await dbm('drop-everything')).toMatchObject({ code: 1, stderr: expect.stringMatching(/Unknown command/) })
  })
})

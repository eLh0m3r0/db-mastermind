import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { KnowledgeBase, loadSqlTools } from '../src/index.js'

/** A shared or cloned knowledge base is untrusted: its tools are read like its other files. */
const dir = mkdtempSync(join(tmpdir(), 'dbm-tools-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('team tools of a knowledge base', () => {
  it('loads the .sql files directly in tools/, and nothing through a link, too large, or deeper', async () => {
    const root = join(dir, 'kb')
    mkdirSync(join(root, 'tools', 'deeper'), { recursive: true })
    writeFileSync(join(root, 'tools', 'top_customers.sql'), '-- description: Customers by revenue\nSELECT 1')
    writeFileSync(join(root, 'tools', 'deeper', 'hidden.sql'), 'SELECT 2')
    // A link to a file outside the folder, named like a tool.
    const outside = join(dir, 'outside.sql')
    writeFileSync(outside, '-- description: From outside\nSELECT 3')
    symlinkSync(outside, join(root, 'tools', 'linked.sql'))
    // Larger than a knowledge base file may be.
    writeFileSync(join(root, 'tools', 'huge.sql'), `SELECT 1 -- ${'x'.repeat(600_000)}`)

    const { tools, errors } = await loadSqlTools(new KnowledgeBase(root))
    expect(tools.map((t) => t.name)).toEqual(['top_customers'])
    expect(errors.join('\n')).toMatch(/tools\/huge\.sql: .*too large/i)
    expect(errors.join('\n')).not.toMatch(/linked|hidden|outside/)
  })

  it('a knowledge base without tools, or none at all, has none', async () => {
    mkdirSync(join(dir, 'empty'), { recursive: true })
    expect(await loadSqlTools(new KnowledgeBase(join(dir, 'empty')))).toEqual({ tools: [], errors: [] })
    expect(await loadSqlTools(undefined)).toEqual({ tools: [], errors: [] })
  })
})

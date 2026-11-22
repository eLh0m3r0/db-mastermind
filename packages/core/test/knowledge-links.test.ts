import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DB_TOOLS, KnowledgeBase, agentDatabase, DatabaseService, type ToolContext } from '../src/index.js'

/**
 * Wave 10: a knowledge base is contained on its real path. A shared or cloned folder can carry links to a file or a
 * folder outside: the app's editor and the agent tools (read_knowledge, write_knowledge, search_knowledge) neither
 * read nor write through them.
 */
const dir = mkdtempSync(join(tmpdir(), 'dbm-kblinks-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const kb = join(dir, 'kb')
const outside = join(dir, 'outside')
mkdirSync(join(kb, 'area'), { recursive: true })
mkdirSync(outside, { recursive: true })
writeFileSync(join(kb, 'README.md'), '# Inside\n')
writeFileSync(join(outside, 'secret.md'), '# Secret\nthe outside text\n')
symlinkSync(join(outside, 'secret.md'), join(kb, 'link.md'))
symlinkSync(outside, join(kb, 'linkdir'))

describe('knowledge base links', () => {
  const base = new KnowledgeBase(kb)

  it('a link to a file or a folder outside is not read, listed or searched', async () => {
    await expect(base.read('link.md')).rejects.toThrow(/knowledge base/)
    await expect(base.read('linkdir/secret.md')).rejects.toThrow(/outside the knowledge base/)
    expect((await base.list()).map((f) => f.path)).toEqual(['README.md'])
    expect(JSON.stringify(await base.search('outside text secret'))).not.toMatch(/outside text/)
  })

  it('nothing is written or deleted through a link', async () => {
    await expect(base.write('linkdir/new.md', 'x')).rejects.toThrow(/knowledge base/)
    await expect(base.write('link.md', 'overwritten')).rejects.toThrow(/link/)
    expect(existsSync(join(outside, 'new.md'))).toBe(false)
    expect(readFileSync(join(outside, 'secret.md'), 'utf8')).toMatch(/the outside text/)
    await expect(base.remove('linkdir/secret.md')).rejects.toThrow(/knowledge base/)
    expect(existsSync(join(outside, 'secret.md'))).toBe(true)
    // Plain notes still work.
    expect(await base.write('area/ok', '# ok\n')).toBe('area/ok.md')
    expect((await base.read('area/ok.md')).title).toBe('ok')
  })

  it('a link swapped in where a note was is refused when opened (no-follow)', async () => {
    writeFileSync(join(kb, 'swap.md'), '# swap\n')
    rmSync(join(kb, 'swap.md'))
    symlinkSync(join(kb, 'README.md'), join(kb, 'swap.md'))
    // (Its target is inside, so the path check passes: opening without following refuses it.)
    await expect(base.read('swap.md')).rejects.toThrow(/link/)
    await expect(base.write('swap.md', 'x')).rejects.toThrow(/link/)
    expect(readFileSync(join(kb, 'README.md'), 'utf8')).toBe('# Inside\n')
  })

  it('the agent tools go the same way', async () => {
    const svc = new DatabaseService()
    await svc.connect({ id: 'l', name: 'l', driver: 'sqlite', filePath: join(dir, 'x.db') })
    const ctx: ToolContext = { db: agentDatabase(svc, { allowData: true }), connectionId: 'l', allowData: true, knowledge: base, allowKnowledgeWrites: true }
    const tool = (name: string) => DB_TOOLS.find((t) => t.name === name)!
    expect(await tool('read_knowledge').run(ctx, { path: 'linkdir/secret.md' }).catch((e: Error) => e.message)).not.toMatch(/the outside text/)
    expect(await tool('write_knowledge').run(ctx, { path: 'linkdir/planted.md', content: 'x' }).catch((e: Error) => e.message)).toMatch(/knowledge base|link/)
    expect(existsSync(join(outside, 'planted.md'))).toBe(false)
    await svc.disconnectAll()
  })
})

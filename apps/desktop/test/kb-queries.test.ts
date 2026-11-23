import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedQuery } from '../src/shared/api'

/**
 * Saved queries shared with the team through a connection's knowledge base: `queries/<folder>/<name>.sql` in the
 * team folder's format. New ones are local; sharing and taking back are the user's acts; always per connection.
 */

const dir = mkdtempSync(join(tmpdir(), 'dbm-kbq-'))
const state = vi.hoisted(() => ({ connections: [] as { id: string; name: string; knowledgeBasePath?: string }[], local: [] as SavedQuery[], team: undefined as string | undefined }))
vi.mock('../src/main/connections', () => ({ listConnections: () => state.connections }))
vi.mock('../src/main/team', () => ({ teamDir: () => state.team }))
vi.mock('../src/main/library', () => ({
  listSavedQueries: () => state.local,
  saveQuery: (q: SavedQuery) => {
    const saved = { ...q, id: q.id ?? `local-${state.local.length + 1}`, createdAt: '', updatedAt: '' }
    state.local = [...state.local.filter((x) => x.id !== saved.id), saved]
    return saved
  },
  deleteSavedQuery: (id: string) => void (state.local = state.local.filter((q) => q.id !== id)),
}))

const kbq = await import('../src/main/kb-queries')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let kb = ''
const tree = (root = join(kb, 'queries')): string[] =>
  existsSync(root) ? readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(root.length + 1)).sort() : []
const local = (q: Partial<SavedQuery>) => {
  const saved = { id: `local-${state.local.length + 1}`, name: 'Paid orders', sql: 'select * from orders where paid', createdAt: '', updatedAt: '', ...q } as SavedQuery
  state.local.push(saved)
  return saved
}

beforeEach(() => {
  kb = mkdtempSync(join(dir, 'kb-'))
  state.connections = [{ id: 'shop', name: 'Shop', knowledgeBasePath: kb }, { id: 'shop-prod', name: 'Shop prod', knowledgeBasePath: kb }, { id: 'crm', name: 'CRM' }]
  state.local = []
  state.team = undefined
})

describe('saved queries in a knowledge base', () => {
  it('Share with the team writes a plain .sql file (folders kept) and the local one goes; Keep on this computer only takes it back', async () => {
    const q = local({ connectionId: 'shop', folder: 'Reports/Monthly', description: 'Paid this month' })
    const shared = await kbq.shareQuery(q.id, 'shop')
    expect(shared).toMatchObject({ shared: true, name: 'Paid orders', folder: 'Reports/Monthly', connectionId: 'shop', sql: 'select * from orders where paid' })
    expect(tree()).toEqual(['Reports/Monthly/Paid orders.sql'])
    expect(readFileSync(join(kb, 'queries', 'Reports', 'Monthly', 'Paid orders.sql'), 'utf8')).toBe('-- description: Paid this month\nselect * from orders where paid\n')
    expect(state.local).toEqual([])
    const back = await kbq.unshareQuery(shared.id)
    expect(back).toMatchObject({ name: 'Paid orders', folder: 'Reports/Monthly', connectionId: 'shop', description: 'Paid this month' })
    expect(tree()).toEqual([])
  })

  it('a query without a connection that is shared becomes that connection’s', async () => {
    const q = local({})
    const shared = await kbq.shareQuery(q.id, 'shop')
    expect(shared.connectionId).toBe('shop')
  })

  it('saving writes only a changed text, keeps the folder and description a tab does not send; a rename renames the file; delete removes it', async () => {
    const shared = await kbq.shareQuery(local({ connectionId: 'shop', folder: 'Ops', description: 'Note' }).id, 'shop')
    const file = join(kb, 'queries', 'Ops', 'Paid orders.sql')
    const before = readFileSync(file, 'utf8')
    await kbq.saveKnowledgeQuery({ id: shared.id, sql: shared.sql })
    expect(readFileSync(file, 'utf8')).toBe(before)
    const changed = await kbq.saveKnowledgeQuery({ id: shared.id, sql: 'select 2' })
    expect(readFileSync(file, 'utf8')).toBe('-- description: Note\nselect 2\n')
    const renamed = await kbq.saveKnowledgeQuery({ id: changed.id, name: 'Paid', folder: 'Ops', sql: 'select 2' })
    expect(tree()).toEqual(['Ops/Paid.sql'])
    await kbq.deleteKnowledgeQuery(renamed.id)
    expect(tree()).toEqual([])
  })

  it('a hand-written file is read (a -- connection: line ignored); a hostile one is listed with what is wrong, never followed', async () => {
    mkdirSync(join(kb, 'queries', 'Team mates'), { recursive: true })
    writeFileSync(join(kb, 'queries', 'Team mates', 'Top.sql'), '-- connection: Somewhere else\r\n-- description: Best customers\r\nselect 1\r\n')
    writeFileSync(join(kb, 'queries', 'Huge.sql'), `select '${'x'.repeat(600 * 1024)}'`)
    writeFileSync(join(dir, 'secret.sql'), 'select secret')
    symlinkSync(join(dir, 'secret.sql'), join(kb, 'queries', 'Link.sql'))
    writeFileSync(join(kb, 'queries', '<b>bold<∕b>.sql'), '<script>alert(1)</script>')
    const list = (await kbq.listKnowledgeQueries()).filter((q) => q.connectionId === 'shop')
    expect(list.map((q) => [q.folder ?? '', q.name, q.problem ? 'problem' : q.sql])).toEqual([
      ['', '<b>bold<∕b>', '<script>alert(1)</script>'],
      ['', 'Huge', 'problem'],
      ['Team mates', 'Top', 'select 1'],
    ])
    expect(list.find((q) => q.name === 'Top')?.description).toBe('Best customers')
  })

  it('belongs to its connection: one without the folder lists none; two sharing a folder on purpose both do', async () => {
    await kbq.shareQuery(local({ connectionId: 'shop' }).id, 'shop')
    const list = await kbq.listKnowledgeQueries()
    expect(list.map((q) => q.connectionId).sort()).toEqual(['shop', 'shop-prod'])
    await expect(kbq.shareQuery(local({ connectionId: 'crm' }).id, 'shop')).rejects.toThrow(/another connection/)
    await expect(kbq.shareQuery(local({ connectionId: 'crm', name: 'x' }).id, 'crm')).rejects.toThrow(/no knowledge base/)
  })

  it('a knowledge base inside the team folder lists none of the team folder’s own queries twice', async () => {
    const team = mkdtempSync(join(dir, 'team-'))
    mkdirSync(join(team, 'queries'), { recursive: true })
    writeFileSync(join(team, 'queries', 'Shared.sql'), 'select 1')
    state.team = team
    // A connection whose knowledge base is the team folder itself (its queries/ is the team folder's).
    state.connections = [{ id: 'shop', name: 'Shop', knowledgeBasePath: team }]
    expect(await kbq.listKnowledgeQueries()).toEqual([])
    // The usual layout: knowledge/<connection> inside the team folder, with its own queries/.
    mkdirSync(join(team, 'knowledge', 'shop', 'queries'), { recursive: true })
    writeFileSync(join(team, 'knowledge', 'shop', 'queries', 'Mine.sql'), 'select 2')
    state.connections = [{ id: 'shop', name: 'Shop', knowledgeBasePath: join(team, 'knowledge', 'shop') }]
    expect((await kbq.listKnowledgeQueries()).map((q) => q.name)).toEqual(['Mine'])
  })
})

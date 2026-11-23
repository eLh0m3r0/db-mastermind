import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Dashboard } from '../src/shared/api'

/**
 * Where dashboards live: a connection with a knowledge base keeps new ones as `dashboards/<name>.md` in it, others on
 * this computer; always per connection. Files are written only on a real change, renamed with the dashboard, and a
 * file that isn't a dashboard is listed with what is wrong.
 */

const dir = mkdtempSync(join(tmpdir(), 'dbm-dash-'))
const state = vi.hoisted(() => ({ connections: [] as { id: string; knowledgeBasePath?: string }[], local: [] as Dashboard[] }))
vi.mock('../src/main/connections', () => ({ listConnections: () => state.connections }))
vi.mock('../src/main/library', () => ({
  listDashboards: (connectionId?: string) => state.local.filter((d) => !connectionId || d.connectionId === connectionId),
  saveDashboard: (d: Dashboard) => {
    const saved = { ...d, id: d.id ?? `local-${state.local.length + 1}`, createdAt: '', updatedAt: '' }
    state.local = [...state.local.filter((x) => x.id !== saved.id), saved]
    return saved
  },
  deleteDashboard: (id: string) => void (state.local = state.local.filter((d) => d.id !== id)),
}))

const storage = await import('../src/main/dashboards')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let kb = ''
const tile = (title: string, sql: string) => ({ id: '', title, sql, chart: null, span: 1 as const })
const files = () => (existsSync(join(kb, 'dashboards')) ? readdirSync(join(kb, 'dashboards')).sort() : [])
/** A dashboard made (on this computer, as every new one) and then shared with the team. */
const shareNew = async (d: Parameters<typeof storage.saveDashboard>[0]) => storage.shareDashboard((await storage.saveDashboard(d)).id)

beforeEach(() => {
  kb = mkdtempSync(join(dir, 'kb-'))
  state.connections = [{ id: 'shop', knowledgeBasePath: kb }, { id: 'prod', knowledgeBasePath: kb }, { id: 'other' }]
  state.local = []
})

describe('dashboards in a knowledge base', () => {
  it('a new dashboard stays on this computer, also with a knowledge base; Share with the team makes it a readable file', async () => {
    const local = await storage.saveDashboard({ connectionId: 'shop', name: 'Sales overview', refreshSeconds: 60, tiles: [tile('Customers', 'select count(*) as customers from customers')] })
    expect(local.shared).toBeUndefined()
    expect(files()).toEqual([])
    const d = await storage.shareDashboard(local.id)
    expect(d).toMatchObject({ shared: true, name: 'Sales overview' })
    expect(files()).toEqual(['Sales overview.md'])
    expect(readFileSync(join(kb, 'dashboards', 'Sales overview.md'), 'utf8')).toBe('---\ndashboard: true\nrefresh: 60\n---\n# Sales overview\n\n## Customers\n\n```sql\nselect count(*) as customers from customers\n```\n')
    expect(state.local).toEqual([])
  })

  it('belongs to its connection: one without the folder never lists it; one sharing the folder on purpose does', async () => {
    const d = await shareNew({ connectionId: 'shop', name: 'Ops', refreshSeconds: 0, tiles: [] })
    await storage.saveDashboard({ connectionId: 'other', name: 'Mine', refreshSeconds: 0, tiles: [] })
    expect((await storage.listDashboards('other')).map((x) => x.name)).toEqual(['Mine'])
    expect((await storage.listDashboards('prod')).map((x) => x.name)).toEqual(['Ops'])
    // An id names its connection: another connection can't write it.
    await expect(storage.saveDashboard({ ...d, connectionId: 'other' })).rejects.toThrow(/another connection/)
  })

  it('saving without a change leaves the file alone; a rename renames the file; delete removes it', async () => {
    const d = await shareNew({ connectionId: 'shop', name: 'Ops', refreshSeconds: 0, tiles: [tile('A', 'select 1')] })
    const file = join(kb, 'dashboards', 'Ops.md')
    utimesSync(file, new Date(2000, 0, 1), new Date(2000, 0, 1))
    await storage.saveDashboard(d)
    expect(statSync(file).mtime.getFullYear()).toBe(2000)
    const renamed = await storage.saveDashboard({ ...d, name: 'Operations' })
    expect(files()).toEqual(['Operations.md'])
    expect(renamed.id).not.toBe(d.id)
    // Another dashboard of the same name gets its own file.
    await shareNew({ connectionId: 'shop', name: 'Operations', refreshSeconds: 0, tiles: [] })
    expect(files()).toEqual(['Operations 2.md', 'Operations.md'])
    await storage.deleteDashboard(renamed.id)
    expect(files()).toEqual(['Operations 2.md'])
  })

  it('a late save never brings a deleted dashboard back (the file, or one kept on this computer)', async () => {
    const shared = await shareNew({ connectionId: 'shop', name: 'Gone', refreshSeconds: 0, tiles: [tile('A', 'select 1')] })
    await storage.deleteDashboard(shared.id)
    await expect(storage.saveDashboard({ ...shared, tiles: [tile('B', 'select 2')] })).rejects.toThrow(/no longer exists/)
    expect(files()).not.toContain('Gone.md')
    // A teammate's delete (the file is simply not there any more) counts the same.
    const other = await shareNew({ connectionId: 'shop', name: 'Theirs', refreshSeconds: 0, tiles: [] })
    rmSync(join(kb, 'dashboards', 'Theirs.md'))
    await expect(storage.saveDashboard({ ...other, refreshSeconds: 60 })).rejects.toThrow(/no longer exists/)
    expect(files()).not.toContain('Theirs.md')
    // One kept on this computer ('other' has no knowledge base folder).
    const local = await storage.saveDashboard({ connectionId: 'other', name: 'Local', refreshSeconds: 0, tiles: [] })
    await storage.deleteDashboard(local.id)
    await expect(storage.saveDashboard({ ...local, refreshSeconds: 30 })).rejects.toThrow(/no longer exists/)
    expect((await storage.listDashboards('other')).map((d) => d.name)).not.toContain('Local')
  })

  it('a file changed by hand is read as it is now; one that is not a dashboard is listed with what is wrong', async () => {
    mkdirSync(join(kb, 'dashboards'), { recursive: true })
    writeFileSync(join(kb, 'dashboards', 'Teammate.md'), '# From a teammate\n\n## Paid\n\n```sql\nselect count(*) from orders\n```\n')
    writeFileSync(join(kb, 'dashboards', 'Broken.md'), '## A\n```sql\nselect 1\n')
    writeFileSync(join(kb, 'notes.md'), '# Not a dashboard')
    const list = await storage.listDashboards('shop')
    expect(list.map((d) => [d.name, d.tiles.length, d.problem ?? ''])).toEqual([
      ['Broken', 0, 'A code block is not closed'],
      ['From a teammate', 1, ''],
    ])
  })

  it('one kept on this computer stays there until shared; Keep on this computer only takes it back and removes the file', async () => {
    const local = await storage.saveDashboard({ connectionId: 'shop', name: 'Dashboard 1', refreshSeconds: 0, tiles: [tile('A', 'select 1')] })
    expect((await storage.listDashboards('shop')).map((d) => [d.name, !!d.shared])).toEqual([['Dashboard 1', false]])
    const shared = await storage.shareDashboard(local.id)
    expect(shared.shared).toBe(true)
    expect(files()).toEqual(['Dashboard 1.md'])
    expect(state.local).toEqual([])
    const back = await storage.unshareDashboard(shared.id)
    expect(back.shared).toBeUndefined()
    expect(files()).toEqual([])
    expect((await storage.listDashboards('shop')).map((d) => [d.name, !!d.shared, d.tiles.map((t) => t.sql)])).toEqual([['Dashboard 1', false, ['select 1']]])
  })
})

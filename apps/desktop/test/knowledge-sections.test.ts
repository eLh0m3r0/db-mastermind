import { describe, expect, it } from 'vitest'
import { knowledgeSections } from '../src/renderer/src/features/knowledge/sections'
import type { Dashboard, KnowledgeFileInfo, SavedQuery } from '../src/shared/api'

/** The Knowledge tab shows its folder by kind: notes, dashboards, queries, AI tools; a dashboard file is not a note. */
describe('knowledge base sections', () => {
  const files = [
    { path: 'README.md', title: 'Overview', size: 1, modifiedAt: '', tables: [] },
    { path: 'sales/orders.md', title: 'Orders', size: 1, modifiedAt: '', tables: ['orders'] },
    { path: 'dashboards/Sales.md', title: 'Sales', size: 1, modifiedAt: '', tables: [] },
  ] as KnowledgeFileInfo[]
  const dashboards = [{ id: 'kb:a', name: 'Sales', shared: true }, { id: 'local', name: 'Mine' }] as Dashboard[]
  const queries = [{ id: 'kbq:a', name: 'Paid', folder: 'Reports', shared: true }, { id: 'l', name: 'Scratch' }] as SavedQuery[]
  const tools = ['tools/top_customers.sql']

  it('sorts the folder by kind and keeps a dashboard file out of the notes', () => {
    const s = knowledgeSections({ files, dashboards, queries, tools }, () => true)
    expect(s.notes.map((f) => f.path)).toEqual(['README.md', 'sales/orders.md'])
    expect(s.dashboards.map((d) => d.name)).toEqual(['Sales'])
    expect(s.queries.map((q) => q.name)).toEqual(['Paid'])
    expect(s.tools).toEqual(['tools/top_customers.sql'])
  })

  it('one search covers all four', () => {
    const s = knowledgeSections({ files, dashboards, queries, tools }, (text) => /sales|top/i.test(text))
    expect([s.notes.length, s.dashboards.length, s.queries.length, s.tools.length]).toEqual([1, 1, 0, 1])
  })
})

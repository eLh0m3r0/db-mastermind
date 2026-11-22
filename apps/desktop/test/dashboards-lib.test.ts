import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store/settings', () => ({ useSettings: { getState: () => ({ settings: { language: 'en' } }) } }))
vi.mock('@/lib/api', () => ({ api: {} }))
vi.mock('@/components/ui/ContextMenu', () => ({ openMenu: () => undefined }))
vi.mock('@/components/ui/ConfirmDialog', () => ({ askText: async () => null, confirmAction: async () => false }))
vi.mock('@/store/ui', () => ({ toast: () => undefined }))
vi.mock('@/store/workspace', () => ({ useWorkspace: { getState: () => ({ tabs: [] }) } }))
vi.mock('@/lib/utils', () => ({ errorMessage: String, uid: () => 'id' }))
vi.mock('@/lib/i18n', () => ({ t: (s: string, v?: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_: string, k: string) => v?.[k] ?? '') }))

const { nextDashboardName, resolveChart, tileRequest } = await import('../src/renderer/src/lib/dashboards')

describe('dashboards in the window', () => {
  it('a new dashboard is "Dashboard N" with a number no other has, a freed one first', () => {
    expect(nextDashboardName([])).toBe('Dashboard 1')
    expect(nextDashboardName([{ name: 'Dashboard 1' }, { name: 'Dashboard 2' }])).toBe('Dashboard 3')
    // Dashboard 1 was deleted: the next is Dashboard 1 again, never a second Dashboard 2.
    expect(nextDashboardName([{ name: 'Dashboard 2' }])).toBe('Dashboard 1')
    expect(nextDashboardName([{ name: 'Sales' }, { name: 'Dashboard 1' }])).toBe('Dashboard 2')
  })

  it('a tile runs as a guarded read with the row cap, whatever the connection allows', () => {
    expect(tileRequest('shop', 'select 1', 'r1')).toEqual({ connectionId: 'shop', sql: 'select 1', runId: 'r1', maxRows: 5000, readOnly: true })
  })

  it('chart columns are found by name, by position when the name is missing', () => {
    const fields = [{ name: 'orders' }, { name: 'month' }]
    expect(resolveChart({ kind: 'line', x: 0, ys: [1], xName: 'month', yNames: ['orders'] }, fields)).toMatchObject({ x: 1, ys: [0] })
    expect(resolveChart({ kind: 'line', x: 0, ys: [1], xName: 'gone', yNames: [''] }, fields)).toMatchObject({ x: 0, ys: [1] })
  })
})

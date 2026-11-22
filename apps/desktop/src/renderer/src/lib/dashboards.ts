import { useCallback, useEffect, useState } from 'react'
import type { Dashboard, DashboardTile, RunQueryRequest } from '@shared/api'
import { openMenu } from '@/components/ui/ContextMenu'
import { api } from '@/lib/api'
import { t } from '@/lib/i18n'
import { errorMessage, uid } from '@/lib/utils'
import { toast } from '@/store/ui'
import { useWorkspace } from '@/store/workspace'
import { confirmAction } from '@/components/ui/ConfirmDialog'

/**
 * How a tile runs: as SQL nobody confirmed (a dashboard may come from a teammate's file), on the guarded read path, in
 * a read-only transaction that is always rolled back, with the row cap. A tile that isn't a read is refused with the
 * guard's sentence, whatever the connection allows.
 */
export function tileRequest(connectionId: string, sql: string, runId: string): RunQueryRequest {
  return { connectionId, sql, runId, maxRows: 5000, readOnly: true }
}

const CHANGED = 'dbm:dashboards-changed'

/** Tells every list and open dashboard of this connection that its dashboards changed (saved, renamed, deleted). */
export function dashboardsChanged(connectionId: string, dashboardId?: string) {
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: { connectionId, dashboardId } }))
}

/** Calls `fn` whenever a dashboard of this connection changes anywhere in the window. */
export function onDashboardsChanged(connectionId: string, fn: (dashboardId?: string) => void): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<{ connectionId: string; dashboardId?: string }>).detail
    if (detail.connectionId === connectionId) fn(detail.dashboardId)
  }
  window.addEventListener(CHANGED, listener)
  return () => window.removeEventListener(CHANGED, listener)
}

/** The connection's dashboards, kept up to date. */
export function useDashboards(connectionId: string): Dashboard[] {
  const [list, setList] = useState<Dashboard[]>([])
  const load = useCallback(() => void api.listDashboards(connectionId).then(setList, () => setList([])), [connectionId])
  useEffect(() => {
    load()
    return onDashboardsChanged(connectionId, load)
  }, [connectionId, load])
  return list
}

/** Saves a dashboard and tells the lists. */
export async function saveDashboard(dashboard: Parameters<typeof api.saveDashboard>[0]): Promise<Dashboard> {
  const saved = await api.saveDashboard(dashboard)
  dashboardsChanged(saved.connectionId, saved.id)
  return saved
}

/** Asks, deletes, and tells the lists (an open tab of it closes). */
export async function deleteDashboard(d: Pick<Dashboard, 'id' | 'name' | 'connectionId'>): Promise<boolean> {
  if (!(await confirmAction({ title: t('Delete dashboard “{name}”?', { name: d.name }), confirmLabel: t('Delete'), danger: true }))) return false
  await api.deleteDashboard(d.id)
  dashboardsChanged(d.connectionId, d.id)
  const ws = useWorkspace.getState()
  for (const tab of ws.tabs.filter((x) => x.kind === 'dashboard' && x.dashboardId === d.id)) ws.close(tab.id)
  return true
}

/** "Dashboard N" with the first N no dashboard of the connection is named (one deleted leaves its number free). */
export function nextDashboardName(existing: { name: string }[]): string {
  const names = new Set(existing.map((d) => d.name))
  for (let n = existing.length + 1; ; n++) {
    const name = t('Dashboard {n}', { n: String(n) })
    if (!names.has(name)) {
      // A lower number freed by a deletion is taken first.
      for (let m = 1; m < n; m++) if (!names.has(t('Dashboard {n}', { n: String(m) }))) return t('Dashboard {n}', { n: String(m) })
      return name
    }
  }
}

/** Menu next to a result: add it to an existing dashboard of the connection or a new one. */
export async function pinToDashboard(anchor: HTMLElement, connectionId: string, tile: Omit<DashboardTile, 'id'>) {
  const dashboards = await api.listDashboards(connectionId)
  const add = async (id?: string) => {
    try {
      const existing = dashboards.find((d) => d.id === id)
      const saved = await saveDashboard({
        id: existing?.id,
        connectionId,
        name: existing?.name ?? nextDashboardName(dashboards),
        refreshSeconds: existing?.refreshSeconds ?? 0,
        tiles: [...(existing?.tiles ?? []), { ...tile, id: uid('tile') }],
      })
      toast({
        kind: 'success',
        message: t('Pinned to {name}', { name: saved.name }),
        action: { label: t('Open'), run: () => openDashboard(connectionId, saved.id, saved.name) },
      })
    } catch (err) {
      toast({ kind: 'error', message: t('Could not pin the result'), detail: errorMessage(err) })
    }
  }
  openMenu(anchor, [
    ...dashboards.map((d) => ({ label: d.name, onClick: () => void add(d.id) })),
    ...(dashboards.length ? ['separator' as const] : []),
    { label: t('New dashboard'), onClick: () => void add() },
  ])
}

export function openDashboard(connectionId: string, dashboardId?: string, name?: string) {
  const ws = useWorkspace.getState()
  const existing = ws.tabs.find((x) => x.kind === 'dashboard' && x.connectionId === connectionId && x.dashboardId === dashboardId)
  if (existing) ws.activate(existing.id)
  else ws.open({ kind: 'dashboard', connectionId, dashboardId, title: name ?? t('Dashboards') }, { reuse: false })
}

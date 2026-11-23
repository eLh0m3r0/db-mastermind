import { useCallback, useEffect, useState } from 'react'
import type { Dashboard, DashboardTile, RunQueryRequest } from '@shared/api'
import { openMenu } from '@/components/ui/ContextMenu'
import { api } from '@/lib/api'
import { t } from '@/lib/i18n'
import { errorMessage, uid } from '@/lib/utils'
import { toast } from '@/store/ui'
import { useWorkspace } from '@/store/workspace'
import { askText, confirmAction } from '@/components/ui/ConfirmDialog'

/**
 * How a tile runs: as SQL nobody confirmed (a dashboard may come from a teammate's file), on the guarded read path, in
 * a read-only transaction that is always rolled back, with the row cap. A tile that isn't a read is refused with the
 * guard's sentence, whatever the connection allows.
 */
export function tileRequest(connectionId: string, sql: string, runId: string): RunQueryRequest {
  return { connectionId, sql, runId, maxRows: 5000, readOnly: true }
}

/** A chart's columns by name where the result has them (a knowledge base file names them), else by index. */
export function resolveChart(chart: NonNullable<DashboardTile['chart']>, fields: { name: string }[]) {
  const at = (name: string | undefined, fallback: number) => {
    const i = name ? fields.findIndex((f) => f.name === name) : -1
    return i >= 0 ? i : fallback
  }
  return { ...chart, x: at(chart.xName, chart.x), ys: chart.ys.map((y, i) => at(chart.yNames?.[i], y)) }
}

const CHANGED = 'dbm:dashboards-changed'

/**
 * Tells every list and open dashboard of this connection that its dashboards changed (saved, renamed, deleted).
 * `origin`: who changed it (an open dashboard ignores its own saves).
 */
export function dashboardsChanged(connectionId: string, dashboardId?: string, origin?: string) {
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: { connectionId, dashboardId, origin } }))
}

/** Calls `fn` whenever a dashboard of this connection changes anywhere in the window. */
export function onDashboardsChanged(connectionId: string, fn: (dashboardId?: string, origin?: string) => void): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<{ connectionId: string; dashboardId?: string; origin?: string }>).detail
    if (detail.connectionId === connectionId) fn(detail.dashboardId, detail.origin)
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
export async function saveDashboard(dashboard: Parameters<typeof api.saveDashboard>[0], origin?: string): Promise<Dashboard> {
  const saved = await api.saveDashboard(dashboard)
  // A rename may give it a new id (a knowledge base file is named after it): open tabs follow.
  if (dashboard.id && saved.id !== dashboard.id) {
    const ws = useWorkspace.getState()
    for (const tab of ws.tabs) if (tab.kind === 'dashboard' && tab.dashboardId === dashboard.id) ws.update(tab.id, { dashboardId: saved.id, title: saved.name })
  }
  dashboardsChanged(saved.connectionId, saved.id, origin)
  return saved
}

/** Shares a dashboard of this computer with the team (the connection's knowledge base), after asking once. */
export async function shareDashboard(d: Dashboard): Promise<void> {
  if (!(await confirmAction({ title: t('Share “{name}” with the team?', { name: d.name }), message: t('Everyone who uses this connection’s knowledge base will have it.'), confirmLabel: t('Share') }))) return
  try {
    const shared = await api.shareDashboard(d.id)
    retarget(d.id, shared.id)
    dashboardsChanged(d.connectionId, shared.id)
  } catch (err) {
    toast({ kind: 'error', message: t('Could not share the dashboard'), detail: errorMessage(err) })
  }
}

/** Keeps a shared dashboard on this computer only (its file leaves the knowledge base), after asking once. */
export async function unshareDashboard(d: Dashboard): Promise<void> {
  if (!(await confirmAction({ title: t('Keep “{name}” on this computer only?', { name: d.name }), message: t('Your colleagues will no longer have it.'), confirmLabel: t('Keep on this computer only') }))) return
  try {
    const local = await api.unshareDashboard(d.id)
    retarget(d.id, local.id)
    dashboardsChanged(d.connectionId, local.id)
  } catch (err) {
    toast({ kind: 'error', message: t('Could not move the dashboard'), detail: errorMessage(err) })
  }
}

/** Open tabs of a dashboard follow it to its new id. */
function retarget(from: string, to: string) {
  const ws = useWorkspace.getState()
  for (const tab of ws.tabs) if (tab.kind === 'dashboard' && tab.dashboardId === from) ws.update(tab.id, { dashboardId: to })
}

/** Renames a dashboard (asked in a dialog) and the tabs that show it. */
export async function renameDashboard(d: Dashboard): Promise<void> {
  const name = (await askText({ title: t('Rename dashboard'), value: d.name, confirmLabel: t('Rename') }))?.trim()
  if (!name || name === d.name) return
  try {
    const saved = await saveDashboard({ ...d, name })
    const ws = useWorkspace.getState()
    for (const tab of ws.tabs) if (tab.kind === 'dashboard' && tab.dashboardId === saved.id) ws.update(tab.id, { title: saved.name })
  } catch (err) {
    toast({ kind: 'error', message: t('Could not rename the dashboard'), detail: errorMessage(err) })
  }
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
  const usable = dashboards.filter((d) => !d.problem)
  openMenu(anchor, [
    ...usable.map((d) => ({ label: d.name, onClick: () => void add(d.id) })),
    ...(usable.length ? ['separator' as const] : []),
    { label: t('New dashboard'), onClick: () => void add() },
  ])
}

export function openDashboard(connectionId: string, dashboardId?: string, name?: string) {
  const ws = useWorkspace.getState()
  const existing = ws.tabs.find((x) => x.kind === 'dashboard' && x.connectionId === connectionId && x.dashboardId === dashboardId)
  if (existing) ws.activate(existing.id)
  else ws.open({ kind: 'dashboard', connectionId, dashboardId, title: name ?? t('Dashboards') }, { reuse: false })
}

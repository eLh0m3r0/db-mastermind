import type { DashboardTile } from '@shared/api'
import { openMenu } from '@/components/ui/ContextMenu'
import { api } from '@/lib/api'
import { t } from '@/lib/i18n'
import { errorMessage, uid } from '@/lib/utils'
import { toast } from '@/store/ui'
import { useWorkspace } from '@/store/workspace'

/** Menu next to a result: add it to an existing dashboard of the connection or a new one. */
export async function pinToDashboard(anchor: HTMLElement, connectionId: string, tile: Omit<DashboardTile, 'id'>) {
  const dashboards = await api.listDashboards(connectionId)
  const add = async (id?: string) => {
    try {
      const existing = dashboards.find((d) => d.id === id)
      const saved = await api.saveDashboard({
        id: existing?.id,
        connectionId,
        name: existing?.name ?? t('Dashboard {n}', { n: String(dashboards.length + 1) }),
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

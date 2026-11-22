import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Columns2, LayoutDashboard, RefreshCw, TerminalSquare, Trash2, X } from 'lucide-react'
import { cellToText, type QueryResult } from '@dbmastermind/core/browser'
import type { Dashboard, DashboardTile } from '@shared/api'
import { ResultChart } from '@/components/chart/ResultChart'
import { Button, IconButton } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input, Select } from '@/components/ui/Input'
import { Spinner } from '@/components/ui/Spinner'
import { api } from '@/lib/api'
import { deleteDashboard, onDashboardsChanged, openDashboard, resolveChart, saveDashboard, tileRequest, useDashboards } from '@/lib/dashboards'
import { useConnections } from '@/store/connections'
import { formatDate, useT } from '@/lib/i18n'
import { cn, debounce, errorMessage, formatDuration, uid } from '@/lib/utils'
import { useWorkspace, type DashboardTab } from '@/store/workspace'

interface TileState {
  result?: QueryResult
  error?: string
  loading: boolean
  at?: number
}

const REFRESH = [0, 60, 300, 900, 3600]

function TileView({
  connectionId,
  tile,
  state,
  onRefresh,
  onChange,
  onRemove,
}: {
  connectionId: string
  tile: DashboardTile
  state?: TileState
  onRefresh: () => void
  onChange: (tile: DashboardTile) => void
  onRemove: () => void
}) {
  const t = useT()
  const newQuery = useWorkspace((s) => s.newQuery)
  const [title, setTitle] = useState(tile.title)
  useEffect(() => setTitle(tile.title), [tile.title])
  const r = state?.result

  return (
    <div className={cn('flex h-[340px] min-w-0 flex-col rounded-lg border border-line bg-elevated', tile.span === 2 && 'col-span-2')}>
      <div className="group flex h-9 shrink-0 items-center gap-1 border-b border-line px-2">
        <input
          className="min-w-0 flex-1 truncate rounded bg-transparent px-1 text-[12.5px] font-semibold outline-none focus:bg-subtle"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== tile.title && onChange({ ...tile, title: title.trim() })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        {state?.loading ? <Spinner size={12} className="text-fg-faint" /> : state?.at && <span className="text-[10.5px] text-fg-faint">{formatDate(state.at, 'time')}</span>}
        <div className="flex opacity-50 group-hover:opacity-100">
          <IconButton label={t('Refresh')} onClick={onRefresh}>
            <RefreshCw size={12} />
          </IconButton>
          <IconButton label={tile.span === 2 ? t('Half width') : t('Full width')} onClick={() => onChange({ ...tile, span: tile.span === 2 ? 1 : 2 })}>
            <Columns2 size={12} />
          </IconButton>
          <IconButton label={t('Open in SQL editor')} onClick={() => newQuery(connectionId, tile.sql, tile.title)}>
            <TerminalSquare size={12} />
          </IconButton>
          <IconButton label={t('Remove from dashboard')} onClick={onRemove}>
            <X size={12} />
          </IconButton>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {state?.error ? (
          <div className="p-3 text-[12px] whitespace-pre-wrap text-danger">{state.error}</div>
        ) : !r ? (
          <div className="flex h-full items-center justify-center">
            <Spinner size={16} className="text-fg-faint" />
          </div>
        ) : tile.chart ? (
          <ResultChart
            fields={r.fields}
            rows={r.rows}
            config={resolveChart(tile.chart, r.fields)}
            onConfigChange={(chart) => onChange({ ...tile, chart: { ...chart, xName: r.fields[chart.x]?.name, yNames: chart.ys.map((y) => r.fields[y]?.name ?? '') } })}
          />
        ) : r.fields.length === 1 && r.rows.length === 1 ? (
          // A single value reads best as a big number.
          <div className="flex h-full flex-col items-center justify-center gap-1">
            <span className="text-[34px] font-semibold tabular-nums">{r.rows[0]![0] === null ? '—' : cellToText(r.rows[0]![0]!)}</span>
            <span className="text-[12px] text-fg-muted">{r.fields[0]!.name}</span>
          </div>
        ) : (
          <div className="h-full overflow-auto">
            <table className="w-full border-collapse font-mono text-[11.5px]">
              <thead className="sticky top-0 bg-subtle text-left">
                <tr>
                  {r.fields.map((f, i) => (
                    <th key={i} className="border-b border-line px-2 py-1 font-semibold whitespace-nowrap">
                      {f.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.rows.slice(0, 200).map((row, ri) => (
                  <tr key={ri} className="border-b border-line">
                    {row.map((v, ci) => (
                      <td key={ci} className={cn('max-w-[240px] truncate px-2 py-0.5 whitespace-nowrap', typeof v === 'number' && 'text-right tabular-nums')}>
                        {v === null ? <span className="text-null italic">NULL</span> : cellToText(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function DashboardList({ tab }: { tab: DashboardTab }) {
  const t = useT()
  const list = useDashboards(tab.connectionId)
  if (!list.length)
    return (
      <EmptyState icon={<LayoutDashboard size={28} />} title={t('No dashboards yet')}>
        {t('Run a query and use Add to dashboard above its result. Charts stay charts, single values become big numbers.')}
      </EmptyState>
    )
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3 p-4">
      {list.map((d) => (
        <button key={d.id} type="button" onClick={() => openDashboard(tab.connectionId, d.id, d.name)} className="flex flex-col gap-1 rounded-lg border border-line bg-elevated p-4 text-left hover:border-accent/60" data-testid="dashboard-card">
          <span className="flex items-center gap-2 text-[13px] font-semibold">
            <LayoutDashboard size={14} className="text-accent" /> {d.name}
          </span>
          <span className="text-[12px] text-fg-muted">{d.problem ? d.problem : t('{n} tiles', { n: String(d.tiles.length) })}</span>
        </button>
      ))}
    </div>
  )
}

/** Pinned query results of one dashboard, refreshed on demand or periodically. */
export function DashboardView({ tab }: { tab: DashboardTab }) {
  const t = useT()
  const updateTab = useWorkspace((s) => s.update)
  const close = useWorkspace((s) => s.close)
  // undefined: loading; null: it no longer exists (deleted elsewhere, its file removed).
  const [dashboard, setDashboard] = useState<Dashboard | null | undefined>(undefined)
  const [states, setStates] = useState<Record<string, TileState>>({})
  const dashboardRef = useRef(dashboard)
  dashboardRef.current = dashboard
  const active = useWorkspace((s) => s.activeTabId === tab.id)
  const status = useConnections((s) => s.runtime[tab.connectionId]?.status)
  const byUser = useConnections((s) => !!s.runtime[tab.connectionId]?.byUser)
  const connectionName = useConnections((s) => s.list.find((c) => c.id === tab.connectionId)?.name ?? '')

  /** Reads the dashboard again (a change elsewhere: a pin, the Saved tab, the file edited outside); tiles that changed run again. */
  const load = useCallback(async () => {
    if (!tab.dashboardId) return
    const next = (await api.listDashboards(tab.connectionId).catch(() => [])).find((d) => d.id === tab.dashboardId) ?? null
    const now = dashboardRef.current
    if (now && next && JSON.stringify({ ...now, updatedAt: '', createdAt: '' }) === JSON.stringify({ ...next, updatedAt: '', createdAt: '' })) return
    if (now && next) {
      const same = (a: DashboardTile, b?: DashboardTile) => !!b && a.sql === b.sql
      setStates((s) => Object.fromEntries(next.tiles.flatMap((x, i) => (same(x, now.tiles[i]) && s[now.tiles[i]!.id] ? [[x.id, s[now.tiles[i]!.id]!]] : []))))
    }
    setDashboard(next)
    if (next) updateTab(tab.id, { title: next.name })
  }, [tab.connectionId, tab.dashboardId, tab.id, updateTab])

  useEffect(() => {
    void load()
    // Its own saves come back here too: ignored (origin), the rest is read again.
    return onDashboardsChanged(tab.connectionId, (id, origin) => origin !== tab.id && (!id || id === tab.dashboardId) && void load())
  }, [load, tab.connectionId, tab.dashboardId, tab.id])
  // A file changed outside the app (a pull, a hand edit): read again when the window or the tab comes back.
  useEffect(() => {
    if (!active) return
    void load()
    const look = () => void load()
    window.addEventListener('focus', look)
    return () => window.removeEventListener('focus', look)
  }, [active, load])

  const persist = useMemo(() => debounce((d: Dashboard) => void saveDashboard(d, tab.id).catch(() => {}), 500), [tab.id])
  const change = (d: Dashboard) => {
    setDashboard(d)
    persist(d)
  }

  // A connection not open yet (after a restart) is opened once, as a tab of it would; one the user closed or that
  // failed waits for Connect instead of failing every tile.
  useEffect(() => {
    if (tab.dashboardId && status !== 'connected' && status !== 'connecting' && status !== 'error' && !byUser) void useConnections.getState().connect(tab.connectionId)
  }, [tab.dashboardId, tab.connectionId, status, byUser])
  const connected = status === 'connected'

  const runTile = useCallback(
    async (tile: DashboardTile) => {
      setStates((s) => ({ ...s, [tile.id]: { ...s[tile.id], loading: true } }))
      try {
        const outcomes = await api.runQuery(tileRequest(tab.connectionId, tile.sql, uid('dash')))
        const failed = outcomes.find((o) => o.error)
        const result = outcomes.flatMap((o) => o.results ?? []).find((r) => r.fields.length)
        setStates((s) => ({ ...s, [tile.id]: { loading: false, at: Date.now(), result, error: failed?.error?.message ?? (result ? undefined : t('The query returned no rows')) } }))
      } catch (err) {
        setStates((s) => ({ ...s, [tile.id]: { loading: false, at: Date.now(), error: errorMessage(err) } }))
      }
    },
    [tab.connectionId, t],
  )

  const refreshAll = useCallback(() => {
    for (const tile of dashboardRef.current?.tiles ?? []) void runTile(tile)
  }, [runTile])

  // Tiles run when the dashboard is open and its connection is: each one that has no result yet.
  useEffect(() => {
    if (!dashboard || !connected) return
    for (const tile of dashboard.tiles) if (!states[tile.id]) void runTile(tile)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboard, connected])

  // Auto-refresh only while the tab is open.
  useEffect(() => {
    if (!dashboard?.refreshSeconds || !connected) return
    const timer = setInterval(refreshAll, dashboard.refreshSeconds * 1000)
    return () => clearInterval(timer)
  }, [dashboard?.refreshSeconds, refreshAll, connected])

  if (!tab.dashboardId) return <DashboardList tab={tab} />
  if (dashboard === undefined)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={18} className="text-fg-faint" />
      </div>
    )
  if (dashboard === null)
    return (
      <EmptyState icon={<LayoutDashboard size={28} />} title={t('This dashboard no longer exists')}>
        <span>{t('It was deleted, or its file was removed from the knowledge base.')}</span>
        <Button size="sm" onClick={() => close(tab.id)}>
          {t('Close tab')}
        </Button>
      </EmptyState>
    )
  if (dashboard.problem)
    return (
      <EmptyState icon={<LayoutDashboard size={28} />} title={t('This dashboard file can’t be read')}>
        {dashboard.problem}
      </EmptyState>
    )
  if (!connected && status !== 'connecting')
    return (
      <EmptyState icon={<LayoutDashboard size={28} />} title={t('{name} is not connected', { name: connectionName })}>
        <Button size="sm" variant="primary" onClick={() => void useConnections.getState().connect(tab.connectionId)}>
          {t('Connect')}
        </Button>
      </EmptyState>
    )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
        <LayoutDashboard size={15} className="text-accent" />
        {/* Given on Enter or when leaving the field: a knowledge base file is named after the dashboard. */}
        <Input
          key={`${dashboard.id}:${dashboard.name}`}
          inputSize="sm"
          className="w-64 font-semibold"
          defaultValue={dashboard.name}
          data-testid="dashboard-name"
          onBlur={(e) => {
            const name = e.target.value.trim()
            if (!name || name === dashboard.name) return void (e.target.value = dashboard.name)
            change({ ...dashboard, name })
            updateTab(tab.id, { title: name })
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              ;(e.target as HTMLInputElement).value = dashboard.name
              ;(e.target as HTMLInputElement).blur()
            }
          }}
        />
        <div className="flex-1" />
        <span className="text-[11.5px] text-fg-muted">{t('Auto-refresh')}</span>
        <Select inputSize="sm" className="w-28" value={dashboard.refreshSeconds} onChange={(e) => change({ ...dashboard, refreshSeconds: Number(e.target.value) })}>
          {REFRESH.map((s) => (
            <option key={s} value={s}>
              {s ? formatDuration(s * 1000) : t('Off')}
            </option>
          ))}
        </Select>
        <Button size="sm" icon={<RefreshCw size={13} />} onClick={refreshAll}>
          {t('Refresh')}
        </Button>
        <IconButton
          label={t('Delete dashboard')}
          onClick={() => void deleteDashboard(dashboard)}
        >
          <Trash2 size={13} />
        </IconButton>
      </div>
      {dashboard.tiles.length === 0 ? (
        <EmptyState icon={<LayoutDashboard size={28} />} title={t('This dashboard is empty')}>
          {t('Run a query and use Add to dashboard above its result. Charts stay charts, single values become big numbers.')}
        </EmptyState>
      ) : (
        <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-3 overflow-auto p-3">
          {dashboard.tiles.map((tile) => (
            <TileView
              key={tile.id}
              connectionId={tab.connectionId}
              tile={tile}
              state={states[tile.id]}
              onRefresh={() => void runTile(tile)}
              onChange={(next) => change({ ...dashboard, tiles: dashboard.tiles.map((x) => (x.id === next.id ? next : x)) })}
              onRemove={() => change({ ...dashboard, tiles: dashboard.tiles.filter((x) => x.id !== tile.id) })}
            />
          ))}
        </div>
      )}
    </div>
  )
}

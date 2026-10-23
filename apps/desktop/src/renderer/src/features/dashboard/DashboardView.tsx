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
import { openDashboard } from '@/lib/dashboards'
import { formatDate, useT } from '@/lib/i18n'
import { cn, debounce, errorMessage, formatDuration, uid } from '@/lib/utils'
import { useWorkspace, type DashboardTab } from '@/store/workspace'
import { confirmAction } from '@/components/ui/ConfirmDialog'

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
          <ResultChart fields={r.fields} rows={r.rows} config={tile.chart} onConfigChange={(chart) => onChange({ ...tile, chart })} />
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
  const [list, setList] = useState<Dashboard[] | null>(null)
  useEffect(() => {
    void api.listDashboards(tab.connectionId).then(setList)
  }, [tab.connectionId])
  if (!list) return null
  if (!list.length)
    return (
      <EmptyState icon={<LayoutDashboard size={28} />} title={t('No dashboards yet')}>
        {t('Run a query and use the pin button above its result to put it on a dashboard. Charts stay charts, single values become big numbers.')}
      </EmptyState>
    )
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3 p-4">
      {list.map((d) => (
        <button key={d.id} type="button" onClick={() => openDashboard(tab.connectionId, d.id, d.name)} className="flex flex-col gap-1 rounded-lg border border-line bg-elevated p-4 text-left hover:border-accent/60">
          <span className="flex items-center gap-2 text-[13px] font-semibold">
            <LayoutDashboard size={14} className="text-accent" /> {d.name}
          </span>
          <span className="text-[12px] text-fg-muted">{t('{n} tiles', { n: String(d.tiles.length) })}</span>
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
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [states, setStates] = useState<Record<string, TileState>>({})
  const dashboardRef = useRef(dashboard)
  dashboardRef.current = dashboard

  useEffect(() => {
    if (!tab.dashboardId) return
    void api.listDashboards(tab.connectionId).then((all) => setDashboard(all.find((d) => d.id === tab.dashboardId) ?? null))
  }, [tab.connectionId, tab.dashboardId])

  const persist = useMemo(() => debounce((d: Dashboard) => void api.saveDashboard(d), 500), [])
  const change = (d: Dashboard) => {
    setDashboard(d)
    persist(d)
  }

  const runTile = useCallback(
    async (tile: DashboardTile) => {
      setStates((s) => ({ ...s, [tile.id]: { ...s[tile.id], loading: true } }))
      try {
        const outcomes = await api.runQuery({ connectionId: tab.connectionId, sql: tile.sql, runId: uid('dash'), maxRows: 5000 })
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

  useEffect(() => {
    if (dashboard) refreshAll()
    // Run once when the dashboard loads; later runs come from refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboard?.id])

  useEffect(() => {
    if (!dashboard?.refreshSeconds) return
    const timer = setInterval(refreshAll, dashboard.refreshSeconds * 1000)
    return () => clearInterval(timer)
  }, [dashboard?.refreshSeconds, refreshAll])

  if (!tab.dashboardId) return <DashboardList tab={tab} />
  if (!dashboard)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={18} className="text-fg-faint" />
      </div>
    )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
        <LayoutDashboard size={15} className="text-accent" />
        <Input
          inputSize="sm"
          className="w-64 font-semibold"
          value={dashboard.name}
          onChange={(e) => {
            change({ ...dashboard, name: e.target.value })
            updateTab(tab.id, { title: e.target.value || t('Dashboard') })
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
          onClick={async () => {
            if (!(await confirmAction({ title: t('Delete dashboard “{name}”?', { name: dashboard.name }), confirmLabel: t('Delete'), danger: true }))) return
            void api.deleteDashboard(dashboard.id).then(() => close(tab.id))
          }}
        >
          <Trash2 size={13} />
        </IconButton>
      </div>
      {dashboard.tiles.length === 0 ? (
        <EmptyState icon={<LayoutDashboard size={28} />} title={t('This dashboard is empty')}>
          {t('Run a query and use the pin button above its result to put it on a dashboard. Charts stay charts, single values become big numbers.')}
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

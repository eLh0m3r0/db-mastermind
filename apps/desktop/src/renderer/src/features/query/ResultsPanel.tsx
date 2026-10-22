import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, BarChart3, CheckCircle2, Copy, Download, TerminalSquare, XCircle } from 'lucide-react'
import { cellToText, type CellValue, type QueryResult, type SortSpec, type StatementOutcome } from '@dbmastermind/core/browser'
import { defaultChartConfig, ResultChart, type ChartConfig } from '@/components/chart/ResultChart'
import { openCellViewer } from '@/components/grid/CellViewer'
import { DataGrid, selectionToTsv, type GridSelection } from '@/components/grid/DataGrid'
import { IconButton } from '@/components/ui/Button'
import { openMenu } from '@/components/ui/ContextMenu'
import { EmptyState } from '@/components/ui/EmptyState'
import { Spinner } from '@/components/ui/Spinner'
import { api } from '@/lib/api'
import { cn, copyText, errorMessage, formatCount, formatDuration } from '@/lib/utils'
import { useSettings } from '@/store/settings'
import { toast } from '@/store/ui'
import { copyRowsAs, EXPORT_FORMATS } from '../results/copy'
import type { DriverId } from '@dbmastermind/core/browser'
import { tp, useT } from '@/lib/i18n'

interface ResultTab {
  key: string
  label: string
  result: QueryResult
  statement: StatementOutcome
}

function compareCells(a: CellValue, b: CellValue): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const ta = cellToText(a)
  const tb = cellToText(b)
  const na = Number(ta)
  const nb = Number(tb)
  if (ta !== '' && tb !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
  return ta.localeCompare(tb, undefined, { numeric: true, sensitivity: 'base' })
}

export function ResultsPanel({
  outcomes,
  running,
  startedAt,
  driver,
  connectionId,
  onShowStatement,
}: {
  outcomes: StatementOutcome[] | null
  running: boolean
  startedAt: number | null
  driver: DriverId
  connectionId: string
  onShowStatement: (outcome: StatementOutcome) => void
}) {
  const settings = useSettings((s) => s.settings)
  const [active, setActive] = useState<string>('auto')
  const [sorts, setSorts] = useState<Record<string, SortSpec[]>>({})
  const [selection, setSelection] = useState<GridSelection | null>(null)
  const [charts, setCharts] = useState<Record<string, ChartConfig | null>>({})
  const tr = useT()
  const language = useSettings((s) => s.settings?.language)

  const tabs = useMemo<ResultTab[]>(() => {
    const out: ResultTab[] = []
    let n = 0
    outcomes?.forEach((o, si) => {
      o.results?.forEach((r, ri) => {
        if (r.fields.length === 0) return
        n++
        out.push({ key: `${si}:${ri}`, label: tr('Result {n}', { n }), result: r, statement: o })
      })
    })
    return out
    // Labels are translated, so recompute when the language changes.
  }, [outcomes, language, tr])

  const hasError = outcomes?.some((o) => o.error)
  const activeKey =
    active !== 'auto' && (active === 'messages' || tabs.some((t) => t.key === active))
      ? active
      : hasError || tabs.length === 0
        ? 'messages'
        : tabs[tabs.length - 1]!.key
  const current = tabs.find((t) => t.key === activeKey)

  const sortedRows = useMemo(() => {
    if (!current) return []
    const sort = sorts[current.key]
    if (!sort?.length) return current.result.rows
    const idx = sort.map((s) => ({ i: current.result.fields.findIndex((f) => f.name === s.column), dir: s.direction === 'asc' ? 1 : -1 }))
    return [...current.result.rows].sort((a, b) => {
      for (const { i, dir } of idx) {
        const c = compareCells(a[i] ?? null, b[i] ?? null)
        if (c !== 0) return c * dir
      }
      return 0
    })
  }, [current, sorts])

  if (running && !outcomes) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-fg-muted">
        <Spinner size={18} />
        <RunningTimer startedAt={startedAt} />
      </div>
    )
  }

  if (!outcomes) {
    return (
      <EmptyState icon={<TerminalSquare size={26} />} title={tr('Run a query to see results')}>
        <span>
          <b>⌘↵</b> {tr('runs the statement under the cursor or the selection')} · <b>⇧⌘↵</b> {tr('runs the whole script')}
        </span>
      </EmptyState>
    )
  }

  const exportCurrent = (anchor: HTMLElement) => {
    if (!current) return
    openMenu(
      anchor,
      EXPORT_FORMATS.map((f) => ({
        label: f.label,
        onClick: async () => {
          try {
            const path = await api.exportResult({
              format: f.id,
              defaultName: 'query-result',
              result: { fields: current.result.fields, rows: sortedRows },
              connectionId,
            })
            if (path) toast({ kind: 'success', message: tr('Export finished'), detail: path, action: { label: tr('Show in folder'), run: () => void api.showItemInFolder(path) } })
          } catch (err) {
            toast({ kind: 'error', message: tr('Export failed'), detail: errorMessage(err) })
          }
        },
      })),
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-line bg-subtle px-1.5">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActive(t.key)}
            className={cn(
              'h-6 rounded px-2 text-[12px]',
              activeKey === t.key ? 'bg-elevated font-medium text-fg shadow-sm' : 'text-fg-muted hover:text-fg',
            )}
          >
            {t.label}
            <span className="ml-1.5 text-fg-faint">{formatCount(t.result.rowCount)}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => setActive('messages')}
          className={cn(
            'flex h-6 items-center gap-1 rounded px-2 text-[12px]',
            activeKey === 'messages' ? 'bg-elevated font-medium text-fg shadow-sm' : 'text-fg-muted hover:text-fg',
          )}
        >
          {hasError && <XCircle size={12} className="text-danger" />}
          {tr('Messages')}
        </button>
        <div className="flex-1" />
        {running && (
          <span className="flex items-center gap-1.5 pr-2 text-[12px] text-fg-muted">
            <Spinner size={12} /> <RunningTimer startedAt={startedAt} />
          </span>
        )}
        {current && (
          <>
            {current.result.truncated && (
              <span className="flex items-center gap-1 pr-2 text-[11.5px] text-warning" title={tr('Raise the limit in Settings → Max result rows')}>
                <AlertTriangle size={12} /> {tr('First {n} rows', { n: formatCount(current.result.rowCount) })}
              </span>
            )}
            <span className="pr-2 text-[11.5px] text-fg-faint">{formatDuration(current.result.durationMs)}</span>
            {(() => {
              const chartable = defaultChartConfig(current.result.fields, sortedRows)
              if (!chartable) return null
              const showing = !!charts[current.key]
              return (
                <IconButton
                  label={showing ? tr('Show table') : tr('Show chart')}
                  active={showing}
                  onClick={() => setCharts((c) => ({ ...c, [current.key]: showing ? null : (c[`${current.key}:last`] ?? chartable) }))}
                >
                  <BarChart3 size={13} />
                </IconButton>
              )
            })()}
            <IconButton label={tr('Copy all as TSV')} onClick={() => void copyText(selectionToTsv(current.result.fields, sortedRows, { anchor: { row: 0, col: 0 }, focus: { row: sortedRows.length - 1, col: current.result.fields.length - 1 } }, true))}>
              <Copy size={13} />
            </IconButton>
            <IconButton label={tr('Export')} onClick={(e) => exportCurrent(e.currentTarget)}>
              <Download size={13} />
            </IconButton>
          </>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {activeKey === 'messages' || !current ? (
          <div className="h-full overflow-auto p-2 font-mono text-[12px] select-text">
            {outcomes.length === 0 && <div className="p-2 text-fg-faint">{tr('Nothing to run.')}</div>}
            {outcomes.map((o, i) => (
              <div
                key={i}
                className={cn('mb-1.5 rounded-md border p-2', o.error ? 'border-danger/30 bg-danger-soft' : 'border-line bg-subtle')}
              >
                <div className="flex items-center gap-2">
                  {o.error ? <XCircle size={13} className="shrink-0 text-danger" /> : <CheckCircle2 size={13} className="shrink-0 text-success" />}
                  <button type="button" className="min-w-0 flex-1 truncate text-left text-fg-muted hover:text-fg" onClick={() => onShowStatement(o)} title={tr('Show in editor')}>
                    {o.sql.replace(/\s+/g, ' ').slice(0, 160)}
                  </button>
                  <span className="shrink-0 text-fg-faint">{formatDuration(o.durationMs)}</span>
                </div>
                {o.note && <div className="mt-1 pl-5 text-fg-muted">{o.note}</div>}
                {o.error ? (
                  <div className="mt-1.5 pl-5 whitespace-pre-wrap text-danger">
                    {o.error.message}
                    {o.error.code && <span className="ml-2 text-fg-faint">[{o.error.code}]</span>}
                  </div>
                ) : (
                  <div className="mt-1 pl-5 text-fg-muted">
                    {o.results?.map((r, ri) => (
                      <div key={ri}>
                        {r.fields.length > 0
                          ? `${tp(r.rowCount, { one: '{n} row returned', many: '{n} rows returned' })}${r.truncated ? ` (${tr('truncated')})` : ''}`
                          : `${tp(r.affectedRows ?? r.rowCount, { one: '{n} row affected', many: '{n} rows affected' })}${r.command ? ` · ${r.command}` : ''}`}
                      </div>
                    ))}
                    {!o.results?.length && 'OK'}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : charts[current.key] ? (
          <ResultChart
            fields={current.result.fields}
            rows={sortedRows}
            config={charts[current.key]!}
            onConfigChange={(config) => setCharts((c) => ({ ...c, [current.key]: config, [`${current.key}:last`]: config }))}
          />
        ) : (
          <DataGrid
            key={current.key}
            fields={current.result.fields}
            rows={sortedRows}
            sort={sorts[current.key]}
            onSortChange={(s) => setSorts((prev) => ({ ...prev, [current.key]: s }))}
            nullDisplay={settings?.nullDisplay}
            onSelectionChange={setSelection}
            onContextMenu={(e, pos, sel) =>
              openMenu(e, [
                ...(pos && pos.row >= 0
                  ? [{ label: tr('View value…'), onClick: () => openCellViewer(sortedRows[pos.row]?.[pos.col] ?? null, current.result.fields[pos.col]?.name ?? '', current.result.fields[pos.col]?.dataType) }]
                  : []),
                { label: tr('Copy'), icon: <Copy size={13} />, onClick: () => sel && void copyText(selectionToTsv(current.result.fields, sortedRows, sel)) },
                { label: tr('Copy with headers'), onClick: () => sel && void copyText(selectionToTsv(current.result.fields, sortedRows, sel, true)) },
                {
                  label: tr('Copy rows as'),
                  submenu: (['json', 'csv', 'markdown', 'sql'] as const).map((format) => ({
                    label: format === 'sql' ? 'SQL INSERT' : format.toUpperCase(),
                    onClick: () => {
                      const s = sel ?? selection
                      if (!s) return
                      const r0 = Math.min(s.anchor.row, s.focus.row)
                      const r1 = Math.max(s.anchor.row, s.focus.row)
                      void copyText(copyRowsAs(format, current.result.fields, sortedRows.slice(r0, r1 + 1), driver))
                    },
                  })),
                },
              ])
            }
          />
        )}
      </div>
    </div>
  )
}

function RunningTimer({ startedAt }: { startedAt: number | null }) {
  const [, force] = useState(0)
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 100)
    return () => clearInterval(t)
  }, [])
  if (!startedAt) return null
  return <span className="tabular-nums">{formatDuration(Date.now() - startedAt)}</span>
}

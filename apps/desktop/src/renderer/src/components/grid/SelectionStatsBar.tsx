import { useMemo } from 'react'
import type { CellValue, ResultField } from '@dbmastermind/core/browser'
import { useT } from '@/lib/i18n'
import { copyText, formatCount } from '@/lib/utils'
import { toast } from '@/store/ui'
import { selectionBounds, type GridSelection } from './DataGrid'
import { selectionStats } from './selection-stats'

/**
 * Count / sum / average / min / max of the selected cells (distinct values for text), shown only with two or more
 * cells selected. A click on a value copies it.
 */
export function SelectionStatsBar({ fields, rows, selection, dataTypes }: { fields: ResultField[]; rows: CellValue[][]; selection: GridSelection | null; dataTypes?: (string | undefined)[] }) {
  const t = useT()
  const stats = useMemo(() => {
    if (!selection) return null
    const bounds = selectionBounds(selection)
    if (bounds.r0 < 0 || bounds.c0 < 0) return null
    const s = selectionStats(fields, rows, bounds, dataTypes)
    return s.cells >= 2 ? s : null
  }, [fields, rows, selection, dataTypes])
  if (!stats) return null
  /** Exact decimal text shown with digit grouping; past what a double holds exactly, as it is. */
  const number = (text: string) => {
    const [whole = '', fraction = ''] = text.replace('-', '').split('.')
    if (whole.length + fraction.length > 15) return text
    return Number(text).toLocaleString(undefined, { minimumFractionDigits: fraction.length, maximumFractionDigits: fraction.length })
  }
  const item = (label: string, shown: string, raw: string) => (
    <button
      key={label}
      type="button"
      className="shrink-0 rounded px-1 whitespace-nowrap hover:bg-hover hover:text-fg"
      title={t('Copy {value}', { value: raw })}
      onClick={() => {
        void copyText(raw)
        toast({ kind: 'success', message: t('Copied {value}', { value: raw }) })
      }}
    >
      <span className="text-fg-faint">{label}</span> <span className="font-medium text-fg tabular-nums">{shown}</span>
    </button>
  )
  const parts = [item(t('Count'), formatCount(stats.count), String(stats.count))]
  if (stats.tooMany) {
    // (Only the count: looking at every one of so many cells would freeze the window.)
  } else if (stats.sum !== undefined) {
    parts.push(
      item(t('Sum'), number(stats.sum), stats.sum),
      item(t('Avg'), number(stats.avg!), stats.avg!),
      item(t('Min'), number(stats.min!), stats.min!),
      item(t('Max'), number(stats.max!), stats.max!),
    )
  } else if (stats.distinct !== undefined) parts.push(item(t('Distinct'), formatCount(stats.distinct), String(stats.distinct)))
  if (stats.empty) parts.push(item(t('Empty'), formatCount(stats.empty), String(stats.empty)))
  return (
    <div className="flex min-w-0 items-center gap-0.5 overflow-hidden text-[11.5px] text-fg-muted" data-testid="selection-stats">
      {parts}
    </div>
  )
}

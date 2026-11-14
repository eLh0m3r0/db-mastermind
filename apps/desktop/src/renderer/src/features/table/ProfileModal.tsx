import { useEffect, useState } from 'react'
import { cellToText, type CellValue, type ColumnProfile, type FilterNode, type TableRef } from '@dbmastermind/core/browser'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { errorMessage, formatCount, uid } from '@/lib/utils'

/**
 * A column's values at a glance (rows, empty, distinct, min / max, the most common ones), with the tab's filter.
 * A click on a common value filters the grid to it.
 */
export function ProfileModal({
  connectionId,
  table,
  column,
  filter,
  session,
  onClose,
  onFilter,
}: {
  connectionId: string
  table: TableRef
  column: string | null
  filter?: FilterNode
  session?: string
  onClose: () => void
  onFilter: (value: CellValue) => void
}) {
  const t = useT()
  const [profile, setProfile] = useState<ColumnProfile | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!column) return
    setProfile(null)
    setError(null)
    const runId = uid('profile')
    let stale = false
    api
      .profileColumn({ connectionId, table, column, filter, session, runId })
      .then((p) => !stale && setProfile(p))
      .catch((err) => !stale && setError(errorMessage(err)))
    return () => {
      stale = true
      void api.cancelQuery(runId)
    }
  }, [connectionId, table, column, filter, session])

  const percent = (n: number) => (profile && profile.total ? `${((n / profile.total) * 100).toFixed(n === profile.total || n === 0 ? 0 : 1)} %` : '')
  const text = (v: CellValue | undefined) => (v === null || v === undefined ? 'NULL' : cellToText(v))
  return (
    <Modal open={!!column} onClose={onClose} title={t('Values of {column}', { column: column ?? '' })} width={480} footer={<><div className="flex-1" /><Button onClick={onClose}>{t('Close')}</Button></>}>
      {error ? (
        <div className="text-[12.5px] text-danger">{error}</div>
      ) : !profile ? (
        <div className="flex items-center gap-2 py-6 text-[12.5px] text-fg-muted">
          <Spinner size={14} /> {t('Counting values…')}
        </div>
      ) : (
        <div className="flex flex-col gap-3 text-[12.5px]" data-testid="column-profile">
          {filter && <div className="text-[11.5px] text-fg-faint">{t('Rows that match the table’s filter.')}</div>}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-fg-muted">{t('Rows')}</dt>
            <dd className="tabular-nums">{formatCount(profile.total)}</dd>
            <dt className="text-fg-muted">{t('Empty (NULL)')}</dt>
            <dd className="tabular-nums">
              {formatCount(profile.total - profile.filled)} {profile.total > profile.filled && <span className="text-fg-faint">{percent(profile.total - profile.filled)}</span>}
            </dd>
            {profile.distinct !== undefined && (
              <>
                <dt className="text-fg-muted">{t('Distinct values')}</dt>
                <dd className="tabular-nums">{formatCount(profile.distinct)}</dd>
              </>
            )}
            {profile.min !== undefined && profile.filled > 0 && (
              <>
                <dt className="text-fg-muted">{t('Smallest')}</dt>
                <dd className="truncate font-mono text-[12px]">{text(profile.min)}</dd>
                <dt className="text-fg-muted">{t('Largest')}</dt>
                <dd className="truncate font-mono text-[12px]">{text(profile.max)}</dd>
              </>
            )}
          </dl>
          {profile.top.length > 0 && (
            <div className="flex flex-col gap-1">
              <div className="text-[11.5px] font-semibold text-fg-muted">{t('Most common values (click to filter)')}</div>
              {profile.top.map((item, i) => (
                <button
                  key={i}
                  type="button"
                  className="group relative flex items-center gap-2 overflow-hidden rounded px-2 py-1 text-left hover:bg-hover"
                  onClick={() => onFilter(item.value)}
                  title={t('Show only rows with this value')}
                >
                  <span className="absolute inset-y-0 left-0 bg-accent-soft" style={{ width: `${profile.total ? (item.count / profile.total) * 100 : 0}%` }} />
                  <span className={`relative min-w-0 flex-1 truncate font-mono text-[12px] ${item.value === null ? 'text-null italic' : ''}`}>{text(item.value)}</span>
                  <span className="relative tabular-nums text-fg-muted">{formatCount(item.count)}</span>
                  <span className="relative w-14 text-right tabular-nums text-fg-faint">{percent(item.count)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

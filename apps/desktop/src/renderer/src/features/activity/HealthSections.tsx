import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, TerminalSquare } from 'lucide-react'
import { checkModel, getDialect, qualify, type DriverId, type StorageReport, type TopQueries, type TopQuery } from '@dbmastermind/core/browser'
import { Button, IconButton } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { cn, errorMessage, formatBytes, formatCount, formatDuration } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { useWorkspace } from '@/store/workspace'

/** Loads on mount and on Refresh (these are cumulative numbers: no auto-refresh). */
function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = useCallback(async () => {
    setBusy(true)
    try {
      setData(await load())
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }, [load])
  useEffect(() => {
    void run()
  }, [run])
  return { data, error, busy, reload: run }
}

function Toolbar({ children, busy, onRefresh }: { children?: React.ReactNode; busy: boolean; onRefresh: () => void }) {
  const t = useT()
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5 text-[12px] text-fg-muted">
      {children}
      <div className="flex-1" />
      <IconButton label={t('Refresh')} onClick={onRefresh}>
        <RefreshCw size={13} className={cn(busy && 'animate-spin')} />
      </IconButton>
    </div>
  )
}

type SortKey = 'totalMs' | 'calls' | 'meanMs' | 'rows'

/** The statements that took the most time since the server's statistics were reset. */
export function TopQueriesSection({ connectionId }: { connectionId: string }) {
  const t = useT()
  const readOnly = useConnections((s) => s.list.find((c) => c.id === connectionId)?.readOnly)
  const newQuery = useWorkspace((s) => s.newQuery)
  const load = useCallback(() => api.topQueries(connectionId), [connectionId])
  const { data, error, busy, reload } = useLoad<TopQueries>(load)
  const [sort, setSort] = useState<SortKey>('totalMs')
  const sorted = useMemo(() => (data?.available ? [...data.queries].sort((a, b) => (b[sort] ?? 0) - (a[sort] ?? 0)) : []), [data, sort])
  const header = (key: SortKey, label: string) => (
    <th className="border-b border-line px-2 py-1.5 text-right font-semibold whitespace-nowrap">
      <button type="button" className={cn('hover:text-fg', sort === key && 'text-fg underline')} onClick={() => setSort(key)}>
        {label}
      </button>
    </th>
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="top-queries">
      <Toolbar busy={busy} onRefresh={() => void reload()}>
        {data?.available && <span>{t('Totals since the statistics were last reset; parameters are shown as placeholders.')}</span>}
      </Toolbar>
      {error && <div className="shrink-0 border-b border-line bg-danger-soft px-3 py-1.5 text-[12px] text-danger">{error}</div>}
      {!data ? (
        !error && (
          <div className="flex items-center gap-2 p-4 text-[12.5px] text-fg-muted">
            <Spinner size={14} /> {t('Reading statement statistics…')}
          </div>
        )
      ) : !data.available ? (
        <div className="m-4 flex max-w-[720px] flex-col gap-2 rounded-lg border border-line p-4 text-[12.5px]" data-testid="top-queries-unavailable">
          <div className="font-semibold">{t('No statement statistics')}</div>
          <div className="text-fg-muted">{t(data.reason)}</div>
          {data.enableSql && (
            <div className="flex items-center gap-2">
              <code className="rounded bg-muted px-2 py-1 font-mono text-[12px]">{data.enableSql}</code>
              {!readOnly && (
                <Button size="xs" icon={<TerminalSquare size={12} />} onClick={() => newQuery(connectionId, data.enableSql!, t('Enable statistics'))}>
                  {t('Open in SQL editor')}
                </Button>
              )}
            </div>
          )}
        </div>
      ) : sorted.length === 0 ? (
        <div className="p-4 text-[12.5px] text-fg-muted">{t('No statements recorded yet.')}</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 z-10 bg-subtle text-left text-[11px] text-fg-muted">
              <tr>
                <th className="border-b border-line px-2 py-1.5 font-semibold">{t('Statement')}</th>
                {header('calls', t('Calls'))}
                {header('totalMs', t('Total time'))}
                {header('meanMs', t('Mean time'))}
                {header('rows', t('Rows'))}
                <th className="border-b border-line" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((q: TopQuery, i) => (
                <tr key={i} className="group border-b border-line align-top hover:bg-hover">
                  <td className="max-w-[640px] px-2 py-1.5">
                    <div className="line-clamp-2 font-mono text-[11.5px] break-all whitespace-pre-wrap select-text" title={q.query}>
                      {q.query}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatCount(q.calls)}</td>
                  <td className="px-2 py-1.5 text-right font-medium tabular-nums">{formatDuration(Math.round(q.totalMs))}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{q.meanMs < 1 ? `${q.meanMs.toFixed(2)} ms` : formatDuration(Math.round(q.meanMs))}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{q.rows === undefined ? '' : formatCount(q.rows)}</td>
                  <td className="px-2 py-1 text-right whitespace-nowrap">
                    <IconButton label={t('Open in SQL editor')} onClick={() => newQuery(connectionId, q.query, t('Top query'))}>
                      <TerminalSquare size={13} />
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** DROP INDEX in the database's own words; opened in the editor, never run from here. */
function dropIndexSql(driver: DriverId, schema: string | undefined, table: string, index: string): string {
  const d = getDialect(driver)
  if (driver === 'mssql' || driver === 'mysql' || driver === 'mariadb') return `DROP INDEX ${d.quoteIdent(index)} ON ${qualify(d, { schema, name: table })};`
  return `DROP INDEX ${qualify(d, { schema, name: index })};`
}

/** Table and index sizes, indexes nothing used, and indexes that repeat or cover another. */
export function StorageSection({ connectionId }: { connectionId: string }) {
  const t = useT()
  const connection = useConnections((s) => s.list.find((c) => c.id === connectionId))
  const schema = useConnections((s) => s.runtime[connectionId]?.schema)
  const newQuery = useWorkspace((s) => s.newQuery)
  const load = useCallback(() => api.storageReport(connectionId), [connectionId])
  const { data, error, busy, reload } = useLoad<StorageReport>(load)
  const max = Math.max(1, ...(data?.tables.map((x) => x.totalBytes ?? x.rows ?? 0) ?? []))
  const driver = connection?.driver ?? 'postgres'
  // Repeated / covered indexes, from the live schema (the same checks as for models).
  const repeated = useMemo(() => {
    if (!schema) return []
    return checkModel(schema.tables, { driver })
      .filter((i) => (i.kind === 'duplicate_index' && i.detail !== 'primary key') || i.kind === 'redundant_index')
      .flatMap((issue) => {
        const table = schema.tables.find((x) => x.name === issue.table && (x.schema ?? '') === (issue.schema ?? ''))
        const index = table?.indexes.find((ix) => !ix.primary && !ix.constraint && ix.name !== issue.detail && ix.columns.join(', ') === issue.column)
        return table && index ? [{ issue, table, index }] : []
      })
  }, [schema, driver])
  const openDrop = (schemaName: string | undefined, table: string, index: string, why: string) =>
    newQuery(connectionId, `-- ${why}\n-- ${t('Check before dropping: a rare report or a nightly job may still need it.')}\n${dropIndexSql(driver, schemaName, table, index)}\n`, t('Drop {index}', { index }))
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="storage">
      <Toolbar busy={busy} onRefresh={() => void reload()}>
        {data && <span>{t('Largest first, as the database reports them; row counts are estimates.')}</span>}
      </Toolbar>
      {error && <div className="shrink-0 border-b border-line bg-danger-soft px-3 py-1.5 text-[12px] text-danger">{error}</div>}
      {!data ? (
        !error && (
          <div className="flex items-center gap-2 p-4 text-[12.5px] text-fg-muted">
            <Spinner size={14} /> {t('Measuring tables…')}
          </div>
        )
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 z-10 bg-subtle text-left text-[11px] text-fg-muted">
              <tr>
                {[t('Table'), t('Rows'), t('Total'), t('Data'), t('Indexes')].map((h, i) => (
                  <th key={h} className={cn('border-b border-line px-2 py-1.5 font-semibold whitespace-nowrap', i > 0 && 'text-right')}>
                    {h}
                  </th>
                ))}
                <th className="w-[160px] border-b border-line" />
              </tr>
            </thead>
            <tbody>
              {data.tables.map((x) => (
                <tr key={`${x.schema}.${x.name}`} className="border-b border-line hover:bg-hover">
                  <td className="px-2 py-1.5">
                    {x.schema && <span className="text-fg-faint">{x.schema}.</span>}
                    <span className="font-medium">{x.name}</span>
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{x.rows === undefined ? '' : formatCount(Math.round(x.rows))}</td>
                  <td className="px-2 py-1.5 text-right font-medium tabular-nums">{x.totalBytes === undefined ? '' : formatBytes(x.totalBytes)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-fg-muted">{x.dataBytes === undefined ? '' : formatBytes(x.dataBytes)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-fg-muted">{x.indexBytes === undefined ? '' : formatBytes(x.indexBytes)}</td>
                  <td className="px-2 py-1.5">
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(1, ((x.totalBytes ?? x.rows ?? 0) / max) * 100)}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="flex flex-col gap-2 p-3" data-testid="index-findings">
            <h3 className="text-[12.5px] font-semibold">{t('Index findings')}</h3>
            {data.unusedIndexes === undefined ? (
              <div className="text-[12px] text-fg-faint">{data.unusedNote ? t(data.unusedNote) : t('This database does not track how indexes are used.')}</div>
            ) : data.unusedIndexes.length === 0 ? (
              <div className="text-[12px] text-fg-faint">{t('Every index has been used since {since}.', { since: data.statsSince ?? t('the server started') })}</div>
            ) : (
              <>
                <div className="text-[12px] text-fg-muted">{t('Never used since {since} (unique and primary-key indexes are not listed):', { since: data.statsSince ?? t('the server started') })}</div>
                {data.unusedIndexes.map((ix) => (
                  <div key={`${ix.schema}.${ix.table}.${ix.index}`} className="flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-[12px]">
                    <span className="font-mono">{ix.index}</span>
                    <span className="text-fg-muted">{t('on {table}', { table: ix.table })}</span>
                    {ix.bytes !== undefined && <span className="text-fg-faint">{formatBytes(ix.bytes)}</span>}
                    <div className="flex-1" />
                    {!connection?.readOnly && (
                      <Button size="xs" variant="ghost" onClick={() => openDrop(ix.schema, ix.table, ix.index, t('{index} was never used since {since}.', { index: ix.index, since: data.statsSince ?? t('the server started') }))}>
                        {t('Open DROP INDEX in editor')}
                      </Button>
                    )}
                  </div>
                ))}
              </>
            )}
            {repeated.map(({ issue, table, index }) => (
              <div key={`${table.schema}.${table.name}.${index.name}`} className="flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-[12px]" data-testid="repeated-index">
                <span className="font-mono">{index.name}</span>
                <span className="text-fg-muted">
                  {issue.kind === 'duplicate_index' ? t('repeats {other} on {table}', { other: issue.detail ?? '', table: table.name }) : t('is covered by {other} on {table}', { other: issue.detail ?? '', table: table.name })}
                </span>
                <div className="flex-1" />
                {!connection?.readOnly && (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => openDrop(table.schema, table.name, index.name, issue.kind === 'duplicate_index' ? t('{index} repeats {other}.', { index: index.name, other: issue.detail ?? '' }) : t('{index} is covered by {other}.', { index: index.name, other: issue.detail ?? '' }))}
                  >
                    {t('Open DROP INDEX in editor')}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

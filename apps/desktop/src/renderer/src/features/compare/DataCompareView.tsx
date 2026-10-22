import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Minus, Pencil, Plus, Rows3 } from 'lucide-react'
import { cellToText, dataSyncScript, getDialect, type CellValue, type DataCompareResult, type RowDiff, type TableRef } from '@dbmastermind/core/browser'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Checkbox, Input, Segmented, Select } from '@/components/ui/Input'
import { api } from '@/lib/api'
import { tp, useT } from '@/lib/i18n'
import { cn, errorMessage, formatCount } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { toast } from '@/store/ui'
import { useWorkspace, type DataCompareTab } from '@/store/workspace'

const refKey = (t?: TableRef) => (t ? `${t.schema ?? ''}\u0001${t.name}` : '')
const parseRef = (key: string): TableRef | undefined => {
  if (!key) return undefined
  const [schema, name] = key.split('\u0001')
  return { schema: schema || undefined, name: name! }
}

function TablePicker({ connectionId, value, onChange }: { connectionId?: string; value?: TableRef; onChange: (t?: TableRef) => void }) {
  const t = useT()
  const schema = useConnections((s) => (connectionId ? s.runtime[connectionId]?.schema : undefined))
  const loadSchema = useConnections((s) => s.loadSchema)
  const connect = useConnections((s) => s.connect)
  useEffect(() => {
    if (connectionId && !schema) void connect(connectionId).then((ok) => (ok ? loadSchema(connectionId) : undefined))
  }, [connectionId, schema, connect, loadSchema])
  const tables = (schema?.tables ?? []).filter((x) => x.type === 'table' || x.type === 'view')
  const multi = new Set(tables.map((x) => x.schema ?? '')).size > 1
  return (
    <Select inputSize="sm" className="w-48" value={refKey(value)} onChange={(e) => onChange(parseRef(e.target.value))} disabled={!connectionId}>
      <option value="">{t('Table…')}</option>
      {tables.map((x) => (
        <option key={refKey(x)} value={refKey(x)}>
          {multi && x.schema ? `${x.schema}.${x.name}` : x.name}
        </option>
      ))}
    </Select>
  )
}

const show = (v: CellValue | undefined) => (v === undefined ? '' : cellToText(v))

/** Compares the rows of two tables (e.g. a code list on test vs production) and writes the sync script. */
export function DataCompareView({ tab }: { tab: DataCompareTab }) {
  const t = useT()
  const connections = useConnections((s) => s.list)
  const updateTab = useWorkspace((s) => s.update)
  const newQuery = useWorkspace((s) => s.newQuery)
  const [result, setResult] = useState<DataCompareResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<'all' | RowDiff['kind']>('all')
  const [sync, setSync] = useState({ insertMissing: true, updateChanged: true, deleteExtra: false })
  const target = connections.find((c) => c.id === tab.connectionId)

  const run = async () => {
    if (!tab.sourceId || !tab.sourceTable || !tab.targetTable) return
    setBusy(true)
    try {
      const keyColumns = tab.keyColumns?.split(',').map((s) => s.trim()).filter(Boolean)
      setResult(await api.compareData({ source: { connectionId: tab.sourceId, table: tab.sourceTable }, target: { connectionId: tab.connectionId, table: tab.targetTable }, keyColumns }))
      setFilter('all')
    } catch (err) {
      toast({ kind: 'error', message: t('Compare failed'), detail: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  const script = useMemo(() => {
    if (!result || !target || !tab.targetTable) return ''
    try {
      return dataSyncScript(result, tab.targetTable, getDialect(target.driver), sync)
    } catch (err) {
      return `-- ${errorMessage(err)}`
    }
  }, [result, target, tab.targetTable, sync])

  const diffs = useMemo(() => (result?.diffs ?? []).filter((d) => filter === 'all' || d.kind === filter).slice(0, 1000), [result, filter])
  const totalDiffs = result ? result.counts.missing + result.counts.extra + result.counts.changed : 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <Rows3 size={15} className="text-accent" />
        <Select inputSize="sm" className="w-44" value={tab.sourceId ?? ''} onChange={(e) => updateTab(tab.id, { sourceId: e.target.value || undefined, sourceTable: undefined })}>
          <option value="">{t('Source…')}</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <TablePicker
          connectionId={tab.sourceId}
          value={tab.sourceTable}
          onChange={(table) => updateTab(tab.id, { sourceTable: table, targetTable: tab.targetTable ?? (tab.sourceId === tab.connectionId ? undefined : table) })}
        />
        <ArrowRight size={14} className="text-fg-faint" />
        <Select inputSize="sm" className="w-44" value={tab.connectionId} onChange={(e) => updateTab(tab.id, { connectionId: e.target.value, targetTable: undefined })}>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <TablePicker connectionId={tab.connectionId} value={tab.targetTable} onChange={(table) => updateTab(tab.id, { targetTable: table })} />
        <Input
          inputSize="sm"
          className="w-40"
          placeholder={t('Key: primary key')}
          title={t('Columns that identify a row, comma separated. Defaults to the primary key.')}
          value={tab.keyColumns ?? ''}
          onChange={(e) => updateTab(tab.id, { keyColumns: e.target.value })}
        />
        <Button size="sm" variant="primary" loading={busy} disabled={!tab.sourceId || !tab.sourceTable || !tab.targetTable} onClick={() => void run()}>
          {t('Compare')}
        </Button>
      </div>
      {!result ? (
        <EmptyState icon={<Rows3 size={28} />} title={t('Compare table data')}>
          {t('Pick the same table in two databases (e.g. a code list on test and on production). DB Mastermind matches rows by key and writes the script that makes the target match.')}
        </EmptyState>
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-3 py-1.5 text-[12px]">
            <Segmented
              size="xs"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: `${t('All differences')} ${formatCount(totalDiffs)}` },
                { value: 'missing', label: `${t('Only in source')} ${formatCount(result.counts.missing)}` },
                { value: 'extra', label: `${t('Only in target')} ${formatCount(result.counts.extra)}` },
                { value: 'changed', label: `${t('Different')} ${formatCount(result.counts.changed)}` },
              ]}
            />
            <span className="text-fg-faint">
              {tp(result.identical, { one: '{n} identical row', many: '{n} identical rows' })} · {t('key')} {result.keyColumns.join(', ')}
            </span>
            {result.skippedColumns.length > 0 && (
              <span className="text-warning" title={result.skippedColumns.join(', ')}>
                {tp(result.skippedColumns.length, { one: '{n} column exists on one side only', many: '{n} columns exist on one side only' })}
              </span>
            )}
            {result.truncated && <span className="text-warning">{t('Only the first 200,000 rows by key were compared.')}</span>}
          </div>
          {totalDiffs === 0 ? (
            <EmptyState icon={<Rows3 size={28} />} title={t('The data is identical')} />
          ) : (
            <div className="flex min-h-0 flex-1">
              <div className="w-[55%] min-w-[360px] overflow-auto border-r border-line">
                <table className="w-full border-collapse text-[12px]">
                  <thead className="sticky top-0 bg-subtle text-left text-[11px] text-fg-muted">
                    <tr>
                      <th className="w-6 border-b border-line px-2 py-1.5" />
                      <th className="border-b border-line px-2 py-1.5 font-semibold">{t('Key')}</th>
                      <th className="border-b border-line px-2 py-1.5 font-semibold">{t('Difference')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diffs.map((d, i) => {
                      const Icon = d.kind === 'missing' ? Plus : d.kind === 'extra' ? Minus : Pencil
                      return (
                        <tr key={i} className="border-b border-line align-top hover:bg-hover">
                          <td className="px-2 py-1.5">
                            <Icon size={12} className={d.kind === 'missing' ? 'text-success' : d.kind === 'extra' ? 'text-danger' : 'text-warning'} />
                          </td>
                          <td className="px-2 py-1.5 font-mono text-[11.5px] whitespace-nowrap">{Object.values(d.key).map(show).join(', ')}</td>
                          <td className="px-2 py-1.5">
                            {d.kind === 'changed' ? (
                              <div className="flex flex-col gap-0.5">
                                {d.changed!.map((c) => (
                                  <div key={c} className="font-mono text-[11.5px]">
                                    <span className="text-fg-muted">{c}:</span> <span className="text-danger line-through decoration-danger/40">{show(d.target?.[c])}</span>{' '}
                                    <ArrowRight size={10} className="inline text-fg-faint" /> <span className="text-success">{show(d.source?.[c])}</span>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <span className={cn('line-clamp-2 font-mono text-[11.5px]', d.kind === 'extra' ? 'text-danger' : 'text-success')}>
                                {Object.entries(d.source ?? d.target ?? {})
                                  .map(([k, v]) => `${k}=${show(v)}`)
                                  .join('  ')}
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {diffs.length >= 1000 && <div className="px-3 py-2 text-[11.5px] text-fg-faint">{t('Showing the first 1,000 differences.')}</div>}
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-3 py-1.5 text-[12px]">
                  <span className="font-medium">{t('Sync script for {name}', { name: target?.name ?? '' })}</span>
                  <Checkbox checked={sync.insertMissing} onChange={(v) => setSync((s) => ({ ...s, insertMissing: v }))} label={t('Insert missing')} />
                  <Checkbox checked={sync.updateChanged} onChange={(v) => setSync((s) => ({ ...s, updateChanged: v }))} label={t('Update different')} />
                  <Checkbox checked={sync.deleteExtra} onChange={(v) => setSync((s) => ({ ...s, deleteExtra: v }))} label={t('Delete extra')} />
                  <div className="flex-1" />
                  <Button size="xs" variant="primary" disabled={!script} onClick={() => newQuery(tab.connectionId, script, t('Data sync'))}>
                    {t('Open in SQL editor')}
                  </Button>
                </div>
                <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap select-text">{script}</pre>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

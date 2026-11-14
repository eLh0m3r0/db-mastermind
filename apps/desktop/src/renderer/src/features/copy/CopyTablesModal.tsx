import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Check, Square } from 'lucide-react'
import type { CopiedTable, CopyProgress, TableRef } from '@dbmastermind/core/browser'
import { Button } from '@/components/ui/Button'
import { Checkbox, Input, Segmented, Select } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { api, bridge } from '@/lib/api'
import { tp, useT } from '@/lib/i18n'
import { cn, errorMessage, formatCount, uid } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { useUi } from '@/store/ui'

const key = (t: TableRef) => `${t.schema ?? ''}.${t.name}`

/**
 * Copies tables, structure and rows, to another connection (another kind of database too): pick the target, the
 * tables, append or replace; progress table by table, Stop at any time.
 */
export function CopyTablesModal() {
  const t = useT()
  const modal = useUi((s) => s.modal)
  const setUi = useUi((s) => s.set)
  const open = modal?.kind === 'copy'
  const sourceId = open ? modal.connectionId : ''
  const list = useConnections((s) => s.list)
  const source = list.find((c) => c.id === sourceId)
  const schema = useConnections((s) => s.runtime[sourceId]?.schema)
  const targetSchemaOf = useConnections((s) => s.runtime)
  const loadSchema = useConnections((s) => s.loadSchema)
  const [targetId, setTargetId] = useState('')
  const [targetSchema, setTargetSchema] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [mode, setMode] = useState<'append' | 'replace'>('append')
  const [run, setRun] = useState<{ id: string; progress?: CopyProgress } | null>(null)
  const [result, setResult] = useState<CopiedTable[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setPicked(new Set((modal.tables ?? []).map(key)))
    // A target from an earlier copy may be this copy's source.
    setTargetId('')
    setResult(null)
    setError(null)
    setRun(null)
    setFilter('')
    if (!schema) void loadSchema(sourceId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // The target's schemas, to choose where the copies go.
  useEffect(() => {
    if (!targetId) return
    setTargetSchema('')
    void loadSchema(targetId)
  }, [targetId, loadSchema])
  const targetSnapshot = targetId ? targetSchemaOf[targetId]?.schema : undefined

  useEffect(() => {
    if (!run) return
    return bridge.on('copy:progress', (p) => {
      if (p.runId === run.id) setRun((r) => (r ? { ...r, progress: p } : r))
    })
  }, [run?.id])

  const tables = useMemo(() => (schema?.tables ?? []).filter((x) => x.type === 'table'), [schema])
  const visible = tables.filter((x) => !filter || `${x.schema ?? ''}.${x.name}`.toLowerCase().includes(filter.toLowerCase()))
  const targets = list.filter((c) => c.id !== sourceId && !c.readOnly && !['clickhouse', 'bigquery', 'trino'].includes(c.driver))
  const close = () => {
    if (run) void api.cancelQuery(run.id)
    setUi({ modal: undefined })
  }

  const start = async () => {
    const id = uid('copy')
    setRun({ id })
    setError(null)
    setResult(null)
    try {
      const chosen = tables.filter((x) => picked.has(key(x))).map((x) => ({ schema: x.schema, name: x.name }))
      setResult(await api.copyTables({ sourceId, targetId, tables: chosen, targetSchema: targetSchema || undefined, mode, runId: id }))
      void loadSchema(targetId, true)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setRun(null)
    }
  }

  const target = list.find((c) => c.id === targetId)
  return (
    <Modal
      open={open}
      onClose={close}
      title={t('Copy tables to another connection')}
      width={620}
      footer={
        <>
          {run ? (
            <Button variant="danger" icon={<Square size={11} fill="currentColor" />} onClick={() => void api.cancelQuery(run.id)}>
              {t('Stop')}
            </Button>
          ) : null}
          <div className="flex-1" />
          <Button onClick={close}>{result ? t('Close') : t('Cancel')}</Button>
          {!result && (
            <Button variant="primary" disabled={!targetId || !picked.size || !!run} loading={!!run} onClick={() => void start()} data-testid="copy-start">
              {tp(picked.size, { one: 'Copy {n} table', many: 'Copy {n} tables' })}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[12.5px]" data-testid="copy-tables">
        <div className="flex items-end gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[12px] font-medium text-fg-muted">{t('From')}</span>
            <div className="truncate rounded-md border border-line bg-subtle px-2.5 py-1.5">{source?.name}</div>
          </div>
          <ArrowRight size={16} className="mb-2 shrink-0 text-fg-faint" />
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[12px] font-medium text-fg-muted">{t('To')}</span>
            <Select value={targetId} onChange={(e) => setTargetId(e.target.value)} disabled={!!run || !!result} data-testid="copy-target">
              <option value="">{t('Choose a connection…')}</option>
              {targets.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </label>
          {targetSnapshot && targetSnapshot.schemas.length > 1 && (
            <label className="flex w-40 flex-col gap-1">
              <span className="text-[12px] font-medium text-fg-muted">{t('Schema')}</span>
              <Select value={targetSchema} onChange={(e) => setTargetSchema(e.target.value)} disabled={!!run || !!result}>
                <option value="">{t('Default ({schema})', { schema: targetSnapshot.defaultSchema ?? '' })}</option>
                {targetSnapshot.schemas.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </label>
          )}
        </div>
        {target?.environment === 'production' && <div className="rounded-md bg-danger-soft px-2.5 py-1.5 text-[12px] text-danger">{t('The target is a PRODUCTION connection.')}</div>}

        {result ? (
          <div className="flex flex-col gap-1" data-testid="copy-result">
            {result.map((r) => (
              <div key={r.target} className="flex items-center gap-2 rounded-md border border-line px-3 py-1.5">
                <Check size={13} className="text-success" />
                <span className="font-medium">{r.table}</span>
                <span className="text-fg-muted">→ {r.target}</span>
                <span className="ml-auto tabular-nums">{tp(r.rows, { one: '{n} row', many: '{n} rows' })}</span>
                {r.created && <span className="text-[11px] text-fg-faint">{t('created')}</span>}
                {r.skippedColumns.length > 0 && <span className="text-[11px] text-warning" title={r.skippedColumns.join(', ')}>{tp(r.skippedColumns.length, { one: '{n} column left out', many: '{n} columns left out' })}</span>}
                {r.warnings?.map((w) => (
                  <span key={w} className="text-[11px] text-warning" title={t(w)}>
                    {t('keys: see note')}
                  </span>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Input inputSize="sm" className="flex-1" placeholder={t('Filter tables…')} value={filter} onChange={(e) => setFilter(e.target.value)} disabled={!!run} />
              <Button size="xs" variant="ghost" disabled={!!run} onClick={() => setPicked(new Set([...picked, ...visible.map(key)]))}>
                {t('All')}
              </Button>
              <Button size="xs" variant="ghost" disabled={!!run} onClick={() => setPicked(new Set())}>
                {t('None')}
              </Button>
            </div>
            <div className="max-h-[240px] overflow-auto rounded-md border border-line">
              {visible.map((x) => {
                const k = key(x)
                const p = run?.progress
                const state = p && p.table === x.name ? (p.done ? 'done' : 'running') : undefined
                return (
                  <div key={k} className={cn('flex items-center gap-2 border-b border-line px-2.5 py-1 last:border-b-0', state === 'running' && 'bg-accent-soft/40')}>
                    <Checkbox
                      checked={picked.has(k)}
                      disabled={!!run}
                      onChange={(on) => setPicked((prev) => {
                        const next = new Set(prev)
                        if (on) next.add(k)
                        else next.delete(k)
                        return next
                      })}
                      label={x.schema ? `${x.schema}.${x.name}` : x.name}
                    />
                    <span className="ml-auto text-[11px] text-fg-faint tabular-nums">{state ? tp(p!.rows, { one: '{n} row', many: '{n} rows' }) : x.rowEstimate ? `≈ ${formatCount(x.rowEstimate)}` : ''}</span>
                  </div>
                )
              })}
            </div>
            <div className="flex items-center gap-2">
              <Segmented
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'append', label: t('Add the rows'), title: t('Tables the target lacks are created; existing ones keep their rows') },
                  { value: 'replace', label: t('Replace the rows'), title: t('Existing target tables are emptied first') },
                ]}
              />
              <span className="text-[11.5px] text-fg-faint">
                {mode === 'replace' ? t('The target tables are emptied first.') : t('Missing tables are created, types translated for the target.')}
              </span>
            </div>
            {run?.progress && (
              <div className="text-[12px] text-fg-muted" data-testid="copy-progress">
                {t('Copying {table} ({n} of {total})…', { table: run.progress.table, n: String(run.progress.index + 1), total: String(run.progress.total) })}
              </div>
            )}
          </>
        )}
        {error && <div className="rounded-md bg-danger-soft px-2.5 py-1.5 text-[12px] whitespace-pre-wrap text-danger">{error}</div>}
        <div className="text-[11.5px] text-fg-faint">{t('Rows keep their keys and arrive parents first. Binary columns are left out; across database kinds, column defaults too.')}</div>
      </div>
    </Modal>
  )
}

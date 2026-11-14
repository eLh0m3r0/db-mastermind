import { useEffect, useState } from 'react'
import { CheckCircle2, Square, TerminalSquare, XCircle } from 'lucide-react'
import { isDangerousStatement, splitStatements, type StatementOutcome } from '@dbmastermind/core/browser'
import { Button, IconButton } from '@/components/ui/Button'
import { confirmAction } from '@/components/ui/ConfirmDialog'
import { Checkbox, Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { api } from '@/lib/api'
import { tp, useT } from '@/lib/i18n'
import { cn, errorMessage, formatCount, uid } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { useUi } from '@/store/ui'
import { useWorkspace } from '@/store/workspace'

interface Outcome {
  connectionId: string
  state: 'waiting' | 'running' | 'ok' | 'failed' | 'skipped'
  rows?: number
  changed?: number
  error?: string
}

/**
 * One script on several connections (dev, test, prod; the tenant databases), one after another, each as the editor
 * runs it there (read-only connections stay read-only). Dangerous statements are confirmed once, naming every
 * production target.
 */
export function RunManyModal() {
  const t = useT()
  const modal = useUi((s) => s.modal)
  const setUi = useUi((s) => s.set)
  const open = modal?.kind === 'runMany'
  const list = useConnections((s) => s.list)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [stopOnError, setStopOnError] = useState(true)
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [stopped, setStopped] = useState(false)
  const sql = open ? modal.sql : ''
  // (A ref: the loop reads it between connections.)
  const stoppedRef = useState(() => ({ current: false }))[0]
  const origin = open ? list.find((c) => c.id === modal.connectionId) : undefined

  useEffect(() => {
    if (!open) return
    setPicked(new Set(origin ? [origin.id] : []))
    setOutcomes(null)
    setFilter('')
    setStopped(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const candidates = list.filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()))
  const close = () => {
    // Closing stops the rest too, not only the connection that runs now.
    stoppedRef.current = true
    if (runId) void api.cancelQuery(runId)
    setUi({ modal: undefined })
  }

  const start = async () => {
    const targets = list.filter((c) => picked.has(c.id))
    const dangerous = splitStatements(sql, targets[0]?.driver ?? 'postgres').filter((s) => isDangerousStatement(s.text))
    const production = targets.filter((c) => c.environment === 'production')
    if (dangerous.length || production.length) {
      const ok = await confirmAction({
        title: tp(targets.length, { one: 'Run on {n} connection?', many: 'Run on {n} connections?' }),
        items: [...dangerous.map((d) => d.text.replace(/\s+/g, ' ').slice(0, 160)), ...production.map((c) => t('PRODUCTION: {name}', { name: c.name }))],
        warning: production.length ? t('PRODUCTION connection') : undefined,
        confirmLabel: t('Run'),
        danger: true,
      })
      if (!ok) return
    }
    setStopped(false)
    stoppedRef.current = false
    const rows: Outcome[] = targets.map((c) => ({ connectionId: c.id, state: 'waiting' }))
    setOutcomes([...rows])
    for (const [i, c] of targets.entries()) {
      if (stoppedRef.current) {
        rows[i] = { ...rows[i]!, state: 'skipped' }
        continue
      }
      rows[i] = { ...rows[i]!, state: 'running' }
      setOutcomes([...rows])
      const id = uid('many')
      setRunId(id)
      try {
        const result: StatementOutcome[] = await api.runQuery({ connectionId: c.id, sql, runId: id, maxRows: 1000 })
        const failed = result.find((o) => o.error)
        const sets = result.flatMap((o) => o.results ?? [])
        rows[i] = {
          connectionId: c.id,
          state: failed ? 'failed' : 'ok',
          rows: sets.filter((r) => r.fields.length).reduce((n, r) => n + r.rowCount, 0),
          changed: sets.reduce((n, r) => n + (r.affectedRows ?? 0), 0),
          error: failed?.error?.message,
        }
      } catch (err) {
        rows[i] = { connectionId: c.id, state: 'failed', error: errorMessage(err) }
      }
      setOutcomes([...rows])
      if (rows[i]!.state === 'failed' && stopOnError) stoppedRef.current = true
    }
    setOutcomes([...rows])
    setRunId(null)
  }

  const running = !!runId
  const done = outcomes && !running
  return (
    <Modal
      open={open}
      onClose={close}
      title={t('Run on several connections')}
      width={600}
      footer={
        <>
          {running && (
            <Button
              variant="danger"
              icon={<Square size={11} fill="currentColor" />}
              onClick={() => {
                stoppedRef.current = true
                setStopped(true)
                if (runId) void api.cancelQuery(runId)
              }}
            >
              {t('Stop')}
            </Button>
          )}
          <div className="flex-1" />
          <Button onClick={close}>{done ? t('Close') : t('Cancel')}</Button>
          {!outcomes && (
            <Button variant="primary" disabled={!picked.size || !sql.trim()} onClick={() => void start()} data-testid="run-many-start">
              {tp(picked.size, { one: 'Run on {n} connection', many: 'Run on {n} connections' })}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[12.5px]" data-testid="run-many">
        <pre className="max-h-24 overflow-auto rounded-md border border-line bg-subtle p-2 font-mono text-[11.5px] whitespace-pre-wrap">{sql.trim()}</pre>
        {!outcomes ? (
          <>
            <Input inputSize="sm" placeholder={t('Filter connections…')} value={filter} onChange={(e) => setFilter(e.target.value)} />
            <div className="max-h-[260px] overflow-auto rounded-md border border-line">
              {candidates.map((c) => (
                <div key={c.id} className="flex items-center gap-2 border-b border-line px-2.5 py-1 last:border-b-0">
                  <Checkbox
                    checked={picked.has(c.id)}
                    onChange={(on) =>
                      setPicked((prev) => {
                        const next = new Set(prev)
                        if (on) next.add(c.id)
                        else next.delete(c.id)
                        return next
                      })
                    }
                    label={c.name}
                  />
                  <span className="ml-auto text-[11px] text-fg-faint">
                    {c.driver}
                    {c.readOnly ? ` · ${t('read-only')}` : ''}
                    {c.environment === 'production' ? ' · PROD' : ''}
                  </span>
                </div>
              ))}
            </div>
            <Checkbox checked={stopOnError} onChange={setStopOnError} label={t('Stop at the first connection that fails')} />
          </>
        ) : (
          <div className="flex flex-col gap-1" data-testid="run-many-results">
            {outcomes.map((o) => {
              const c = list.find((x) => x.id === o.connectionId)
              return (
                <div key={o.connectionId} className={cn('flex items-start gap-2 rounded-md border border-line px-3 py-1.5', o.state === 'failed' && 'border-danger/40')}>
                  {o.state === 'ok' ? <CheckCircle2 size={14} className="mt-0.5 text-success" /> : o.state === 'failed' ? <XCircle size={14} className="mt-0.5 text-danger" /> : <span className="mt-1 h-3 w-3 rounded-full border border-line-strong" />}
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{c?.name}</div>
                    <div className="text-[11.5px] text-fg-muted">
                      {o.state === 'running'
                        ? t('Running…')
                        : o.state === 'waiting'
                          ? t('Waiting')
                          : o.state === 'skipped'
                            ? t('Not run (stopped)')
                            : o.error
                              ? o.error
                              : [o.rows ? tp(o.rows, { one: '{n} row', many: '{n} rows' }) : '', o.changed ? t('{n} changed', { n: formatCount(o.changed) }) : ''].filter(Boolean).join(' · ') || t('Done')}
                    </div>
                  </div>
                  {done && (
                    <IconButton label={t('Open in a query tab')} onClick={() => { useWorkspace.getState().newQuery(o.connectionId, sql); close() }}>
                      <TerminalSquare size={13} />
                    </IconButton>
                  )}
                </div>
              )
            })}
            {stopped && <div className="text-[11.5px] text-fg-faint">{t('Stopped: the remaining connections were not run.')}</div>}
          </div>
        )}
      </div>
    </Modal>
  )
}

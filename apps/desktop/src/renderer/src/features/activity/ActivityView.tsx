import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, Ban, CircleStop, RefreshCw, TerminalSquare } from 'lucide-react'
import type { SessionActivity } from '@dbmastermind/core/browser'
import { Button, IconButton } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge, Checkbox, Input, Segmented } from '@/components/ui/Input'
import { StorageSection, TopQueriesSection } from './HealthSections'
import { api } from '@/lib/api'
import { tp, useT } from '@/lib/i18n'
import { cn, errorMessage, formatDuration } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { toast } from '@/store/ui'
import { useWorkspace, type ActivityTab } from '@/store/workspace'
import { confirmAction } from '@/components/ui/ConfirmDialog'

const IDLE = /^(idle|sleep|sleeping|inactive)$/i
const SLOW_MS = 10_000

/** Sessions on the server with their running statements; cancel a query or end a session. */
export function ActivityView({ tab }: { tab: ActivityTab }) {
  const t = useT()
  const connection = useConnections((s) => s.list.find((c) => c.id === tab.connectionId))
  const newQuery = useWorkspace((s) => s.newQuery)
  const tabs = useWorkspace((s) => s.tabs)
  const activate = useWorkspace((s) => s.activate)
  const [onlyApp, setOnlyApp] = useState(false)
  const [sessions, setSessions] = useState<SessionActivity[] | null>(null)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [auto, setAuto] = useState(true)
  const [showIdle, setShowIdle] = useState(false)
  const [search, setSearch] = useState('')
  const section = tab.section ?? 'sessions'
  const updateTab = useWorkspace((s) => s.update)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      setSessions(await api.listActivity(tab.connectionId))
      setError(undefined)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }, [tab.connectionId])

  useEffect(() => {
    if (section !== 'sessions') return
    void load()
    if (!auto) return
    const timer = setInterval(() => void load(), 3000)
    return () => clearInterval(timer)
  }, [load, auto, section])

  /** How many sessions each session blocks. */
  const blocking = useMemo(() => {
    const out = new Map<string, number>()
    for (const s of sessions ?? []) for (const b of s.blockedBy ?? []) out.set(b, (out.get(b) ?? 0) + 1)
    return out
  }, [sessions])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (sessions ?? []).filter(
      (s) =>
        // An idle session holding locks others wait for (or a transaction nobody ends) is exactly what you're looking for.
        (showIdle || s.own || !!s.session || s.idleInTransaction || !IDLE.test(s.state ?? '') || blocking.has(s.id)) &&
        (!onlyApp || s.own || !!s.session || /DB Mastermind/i.test(s.application ?? '')) &&
        (!q || [s.id, s.user, s.database, s.client, s.application, s.query].some((v) => v?.toLowerCase().includes(q))),
    )
  }, [sessions, showIdle, onlyApp, search, blocking])

  const stop = async (s: SessionActivity, mode: 'cancel' | 'terminate') => {
    if (mode === 'terminate' && !(await confirmAction({ title: t('End session {id}?', { id: s.id }), message: t('Its open transaction is rolled back.'), confirmLabel: t('End session'), danger: true }))) return
    try {
      await api.stopSession(tab.connectionId, s.id, mode)
      toast({ kind: 'success', message: mode === 'cancel' ? t('Query cancelled') : t('Session ended') })
      void load()
    } catch (err) {
      toast({ kind: 'error', message: t('Could not stop the session'), detail: errorMessage(err) })
    }
  }

  const canStop = !connection?.readOnly

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <Activity size={15} className="text-accent" />
        <span className="text-[12.5px] font-semibold">{t('Server activity')}</span>
        <Segmented
          value={section}
          onChange={(next) => updateTab(tab.id, { section: next })}
          options={[
            { value: 'sessions', label: t('Sessions') },
            { value: 'queries', label: t('Top queries'), title: t('The statements that took the most time since the statistics were reset') },
            { value: 'storage', label: t('Storage'), title: t('Table and index sizes, unused indexes') },
          ]}
        />
        {section === 'sessions' && sessions && <span className="text-[11.5px] text-fg-faint">{tp(visible.length, { one: '{n} session', many: '{n} sessions' })}</span>}
        <div className="flex-1" />
        {section === 'sessions' && (
          <>
        <Input inputSize="sm" className="w-56" placeholder={t('Search sessions…')} value={search} onChange={(e) => setSearch(e.target.value)} />
        <Checkbox checked={onlyApp} onChange={setOnlyApp} label={t('Only DB Mastermind')} />
        <Checkbox checked={showIdle} onChange={setShowIdle} label={t('Show idle')} />
        <Checkbox checked={auto} onChange={setAuto} label={t('Auto-refresh')} />
        <IconButton label={t('Refresh')} onClick={() => void load()}>
          <RefreshCw size={13} className={cn(busy && 'animate-spin')} />
        </IconButton>
          </>
        )}
      </div>
      {section === 'queries' ? <TopQueriesSection connectionId={tab.connectionId} /> : section === 'storage' ? <StorageSection connectionId={tab.connectionId} /> : (
      <>
      {error && <div className="shrink-0 border-b border-line bg-danger-soft px-3 py-1.5 text-[12px] text-danger">{error}</div>}
      {sessions && visible.length === 0 ? (
        <EmptyState icon={<Activity size={28} />} title={t('Nothing is running')}>
          {t('Only active sessions are shown. Turn on “Show idle” to see every connection.')}
        </EmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 z-10 bg-subtle text-left text-[11px] font-semibold text-fg-muted">
              <tr>
                {[t('Session'), t('User'), t('Database'), t('Client'), t('State'), t('Running for'), t('Query'), ''].map((h, i) => (
                  <th key={i} className="border-b border-line px-2 py-1.5 font-semibold whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((s) => {
                const slow = !IDLE.test(s.state ?? '') && (s.durationMs ?? 0) > SLOW_MS
                return (
                  <tr key={s.id} className="group border-b border-line align-top hover:bg-hover">
                    <td className="px-2 py-1.5 font-mono whitespace-nowrap tabular-nums">
                      {s.id}
                      {s.own && (
                        <Badge tone="accent" className="ml-1.5">
                          {t('this app')}
                        </Badge>
                      )}
                      {s.session && (
                        <button type="button" className="ml-1.5" title={t('Go to the tab')} onClick={() => tabs.some((x) => x.id === s.session) && activate(s.session!)}>
                          <Badge tone="accent">{tabs.find((x) => x.id === s.session)?.title ?? t('this app')}</Badge>
                        </button>
                      )}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{s.user}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{s.database}</td>
                    <td className="max-w-[180px] truncate px-2 py-1.5 text-fg-muted" title={[s.client, s.application].filter(Boolean).join(' · ')}>
                      {s.application || s.client}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {s.state}
                      {s.idleInTransaction && (
                        <span className="ml-1.5" title={t('Holds its locks until somebody commits or rolls back')}>
                          <Badge tone="warning">{t('open transaction')}</Badge>
                        </span>
                      )}
                      {!!s.blockedBy?.length && (
                        <Badge tone="danger" className="ml-1.5">
                          {t('waits for {id}', { id: s.blockedBy.join(', ') })}
                        </Badge>
                      )}
                      {blocking.has(s.id) && (
                        <Badge tone="warning" className="ml-1.5">
                          {tp(blocking.get(s.id)!, { one: 'blocks {n} session', many: 'blocks {n} sessions' })}
                        </Badge>
                      )}
                    </td>
                    <td className={cn('px-2 py-1.5 whitespace-nowrap tabular-nums', slow && 'font-medium text-warning')}>
                      {s.durationMs !== undefined && s.durationMs >= 0 ? formatDuration(s.durationMs) : ''}
                    </td>
                    <td className="max-w-[520px] px-2 py-1.5">
                      <div className="line-clamp-3 font-mono text-[11.5px] break-all whitespace-pre-wrap text-fg-muted select-text" title={s.query}>
                        {s.query}
                      </div>
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap">
                      <div className="flex justify-end gap-0.5 opacity-60 group-hover:opacity-100">
                        {s.query && (
                          <IconButton label={t('Open in SQL editor')} onClick={() => newQuery(tab.connectionId, s.query!, t('Session {id}', { id: s.id }))}>
                            <TerminalSquare size={13} />
                          </IconButton>
                        )}
                        {canStop && !s.own && (
                          <>
                            <Button size="xs" variant="ghost" icon={<CircleStop size={12} />} onClick={() => void stop(s, 'cancel')}>
                              {t('Cancel query')}
                            </Button>
                            <IconButton label={t('End session')} onClick={() => void stop(s, 'terminate')}>
                              <Ban size={13} className="text-danger" />
                            </IconButton>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      </>
      )}
    </div>
  )
}

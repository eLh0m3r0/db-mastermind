import { useEffect, useMemo, useState } from 'react'
import { Check, Database, Search } from 'lucide-react'
import { sameServer } from '@dbmastermind/core/browser'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { cn, errorMessage } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { useUi } from '@/store/ui'
import { connectAndSelect } from '../sidebar/Sidebar'

/**
 * Another database on the same server. Each database is a connection of its own, so its read-only, color, commit
 * mode and AI permissions stay its own: picking one opens its connection (made on the first pick).
 */
export function DatabasePicker() {
  const t = useT()
  const modal = useUi((s) => s.modal)
  const setUi = useUi((s) => s.set)
  const open = modal?.kind === 'databases'
  const connectionId = open ? modal.connectionId : undefined
  const list = useConnections((s) => s.list)
  const source = list.find((c) => c.id === connectionId)
  const [databases, setDatabases] = useState<string[] | null>(null)
  const [error, setError] = useState<string>()
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState<string>()

  useEffect(() => {
    if (!connectionId) return
    setDatabases(null)
    setError(undefined)
    setFilter('')
    api.listDatabases(connectionId).then(setDatabases, (err) => setError(errorMessage(err)))
  }, [connectionId])

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (databases ?? []).filter((d) => !q || d.toLowerCase().includes(q))
  }, [databases, filter])

  /** Connections that already exist for a database of this server. */
  const existing = (database: string) => (source ? list.find((c) => c.id !== source.id && (c.database ?? '') === database && sameServer(c, source)) : undefined)

  const close = () => setUi({ modal: undefined })
  const pick = async (database: string) => {
    if (!source || busy) return
    setBusy(database)
    try {
      const id = await api.openDatabase(source.id, database)
      await useConnections.getState().load()
      close()
      await connectAndSelect(id)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <Modal open={open} onClose={close} title={t('Open another database')} width={440}>
      <div className="flex flex-col gap-3">
        <p className="text-[12px] text-fg-muted">
          {t('Each database opens as a connection of its own, with its own read-only, color, commit mode and AI permissions (copied from “{name}” the first time).', { name: source?.name ?? '' })}
        </p>
        <Input
          autoFocus
          inputSize="sm"
          placeholder={t('Search databases…')}
          value={filter}
          leading={<Search size={12} />}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && shown.length === 1) void pick(shown[0]!)
          }}
        />
        {error && <div className="rounded-md bg-danger-soft px-2.5 py-1.5 text-[12px] text-danger select-text">{error}</div>}
        <div className="max-h-[320px] min-h-[120px] overflow-auto rounded-md border border-line" role="listbox" aria-label={t('Databases')}>
          {databases === null && !error ? (
            <div className="flex h-[120px] items-center justify-center">
              <Spinner size={16} />
            </div>
          ) : shown.length === 0 ? (
            <div className="flex h-[120px] items-center justify-center text-[12px] text-fg-faint">{t('No database matches.')}</div>
          ) : (
            shown.map((database) => {
              const current = (source?.database ?? '') === database
              const other = existing(database)
              return (
                <button
                  key={database}
                  type="button"
                  role="option"
                  aria-selected={current}
                  data-database={database}
                  disabled={!!busy}
                  onClick={() => (current ? close() : void pick(database))}
                  className={cn('flex w-full items-center gap-2 border-b border-line px-2.5 py-1.5 text-left text-[12.5px] last:border-b-0 hover:bg-hover', current && 'bg-accent-soft')}
                >
                  {busy === database ? <Spinner size={13} /> : <Database size={13} className={cn('shrink-0', current ? 'text-accent' : 'text-fg-faint')} />}
                  <span className="min-w-0 flex-1 truncate font-medium">{database}</span>
                  {current ? (
                    <span className="flex items-center gap-1 text-[11px] text-accent">
                      <Check size={12} />
                      {t('this connection')}
                    </span>
                  ) : other ? (
                    <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-fg-faint">
                      {other.color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: other.color }} />}
                      <span className="truncate">{other.name}</span>
                    </span>
                  ) : (
                    <span className="text-[11px] text-fg-faint">{t('new connection')}</span>
                  )}
                </button>
              )
            })
          )}
        </div>
      </div>
    </Modal>
  )
}

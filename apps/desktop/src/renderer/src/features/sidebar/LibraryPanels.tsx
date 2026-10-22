import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookMarked, Copy, FileText, Search, Trash2, XCircle } from 'lucide-react'
import type { HistoryEntry, SavedQuery } from '@shared/api'
import { openMenu } from '@/components/ui/ContextMenu'
import { Input } from '@/components/ui/Input'
import { api } from '@/lib/api'
import { copyText, cn, formatDuration, fuzzyScore } from '@/lib/utils'
import { useWorkspace } from '@/store/workspace'
import { t, tp, useT } from '@/lib/i18n'

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return t('just now')
  if (diff < 3_600_000) return t('{n} min ago', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('{n} h ago', { n: Math.floor(diff / 3_600_000) })
  return new Date(iso).toLocaleDateString()
}

/** Puts SQL into the active query tab of this connection, or opens a new one. */
export function openSql(connectionId: string, sql: string, title?: string) {
  const ws = useWorkspace.getState()
  ws.newQuery(connectionId, sql, title)
}

export function HistoryPanel({ connectionId }: { connectionId: string }) {
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [search, setSearch] = useState('')
  const t = useT()
  const load = useCallback(() => void api.listHistory(connectionId, search, 300).then(setEntries), [connectionId, search])
  useEffect(() => {
    load()
    const timer = setInterval(load, 3000)
    return () => clearInterval(timer)
  }, [load])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 pb-1.5">
        <Input inputSize="sm" placeholder={t('Search history…')} value={search} onChange={(e) => setSearch(e.target.value)} leading={<Search size={12} />} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-2">
        {entries.map((h) => (
          <button
            key={h.id}
            type="button"
            className="group mb-0.5 flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-hover"
            onClick={() => openSql(connectionId, h.sql)}
            onContextMenu={(e) =>
              openMenu(e, [
                { label: t('Open in new tab'), icon: <FileText size={13} />, onClick: () => openSql(connectionId, h.sql) },
                { label: t('Copy SQL'), icon: <Copy size={13} />, onClick: () => void copyText(h.sql) },
              ])
            }
            title={h.sql}
          >
            <span className={cn('line-clamp-2 font-mono text-[11.5px] break-all', h.error ? 'text-danger' : 'text-fg')}>{h.sql}</span>
            <span className="flex items-center gap-1.5 text-[10.5px] text-fg-faint">
              {h.error && <XCircle size={10} className="text-danger" />}
              {relativeTime(h.executedAt)}
              {h.durationMs > 0 && <span>· {formatDuration(h.durationMs)}</span>}
              {h.rowCount !== undefined && h.rowCount !== null && <span>· {tp(h.rowCount, { one: '{n} row', many: '{n} rows' })}</span>}
            </span>
          </button>
        ))}
        {entries.length === 0 && <div className="p-4 text-center text-[12px] text-fg-faint">{search ? t('No matches') : t('Queries you run appear here.')}</div>}
      </div>
      {entries.length > 0 && (
        <button
          type="button"
          className="m-2 mt-0 h-7 rounded-md text-[12px] text-fg-muted hover:bg-hover hover:text-fg"
          onClick={() => {
            if (window.confirm(t('Clear query history for this connection?'))) void api.clearHistory(connectionId).then(load)
          }}
        >
          {t('Clear history')}
        </button>
      )}
    </div>
  )
}

export function SavedQueriesPanel({ connectionId }: { connectionId: string }) {
  const [queries, setQueries] = useState<SavedQuery[]>([])
  const [search, setSearch] = useState('')
  const openTab = useWorkspace((s) => s.open)
  const t = useT()
  const load = useCallback(() => void api.listSavedQueries().then(setQueries), [])
  useEffect(() => {
    load()
    const timer = setInterval(load, 4000)
    return () => clearInterval(timer)
  }, [load])
  const grouped = useMemo(() => {
    const q = search.trim()
    const visible = queries
      .filter((x) => !x.connectionId || x.connectionId === connectionId)
      .filter((x) => !q || fuzzyScore(`${x.name} ${x.folder ?? ''}`, q) >= 0 || x.sql.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name))
    const map = new Map<string, SavedQuery[]>()
    for (const x of visible) map.set(x.folder ?? '', [...(map.get(x.folder ?? '') ?? []), x])
    return [...map.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
  }, [queries, search, connectionId])

  const open = (q: SavedQuery) =>
    openTab({ kind: 'query', connectionId, title: q.name, sql: q.sql, savedQueryId: q.id, savedSql: q.sql }, { reuse: false })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 pb-1.5">
        <Input inputSize="sm" placeholder={t('Search saved queries…')} value={search} onChange={(e) => setSearch(e.target.value)} leading={<Search size={12} />} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-2">
        {grouped.map(([folder, items]) => (
          <div key={folder} className="mb-1">
            {folder && <div className="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-fg-faint uppercase">{folder}</div>}
            {items.map((q) => (
              <button
                key={q.id}
                type="button"
                className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] hover:bg-hover"
                onClick={() => open(q)}
                title={q.sql}
                onContextMenu={(e) =>
                  openMenu(e, [
                    { label: t('Open'), icon: <FileText size={13} />, onClick: () => open(q) },
                    { label: t('Copy SQL'), icon: <Copy size={13} />, onClick: () => void copyText(q.sql) },
                    'separator',
                    {
                      label: t('Delete'),
                      icon: <Trash2 size={13} />,
                      danger: true,
                      onClick: () => {
                        if (window.confirm(t('Delete saved query “{name}”?', { name: q.name }))) void api.deleteSavedQuery(q.id).then(load)
                      },
                    },
                  ])
                }
              >
                <BookMarked size={12} className="shrink-0 text-accent" />
                <span className="truncate">{q.name}</span>
              </button>
            ))}
          </div>
        ))}
        {grouped.length === 0 && (
          <div className="p-4 text-center text-[12px] text-fg-faint">{search ? t('No matches') : t('Save a query with ⌘S to keep it here.')}</div>
        )}
      </div>
    </div>
  )
}

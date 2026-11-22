import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookMarked, BookOpen, Copy, FileText, LayoutDashboard, Pencil, Search, Trash2, XCircle } from 'lucide-react'
import type { HistoryEntry, SavedQuery } from '@shared/api'
import { openMenu } from '@/components/ui/ContextMenu'
import { Input } from '@/components/ui/Input'
import { api, keys } from '@/lib/api'
import { copyText, cn, errorMessage, formatDuration, fuzzyScore } from '@/lib/utils'
import { toast } from '@/store/ui'
import { useWorkspace } from '@/store/workspace'
import { formatDate, t, tp, useT } from '@/lib/i18n'
import { confirmAction } from '@/components/ui/ConfirmDialog'
import { deleteDashboard, moveToKnowledge, openDashboard, renameDashboard, useDashboards } from '@/lib/dashboards'
import { useConnections } from '@/store/connections'

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return t('just now')
  if (diff < 3_600_000) return t('{n} min ago', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('{n} h ago', { n: Math.floor(diff / 3_600_000) })
  return formatDate(iso, 'date')
}

/** Puts SQL into the active query tab of this connection, or opens a new one. */
export function openSql(connectionId: string, sql: string, title?: string) {
  const ws = useWorkspace.getState()
  ws.newQuery(connectionId, sql, title)
}

const SOURCE_LABELS = { grid: 'grid', import: 'import', ai: 'AI', mcp: 'MCP', editor: 'editor' } as const

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
              {h.source && h.source !== 'editor' && <span className="rounded bg-muted px-1 text-[10px] font-medium text-fg-muted uppercase">{t(SOURCE_LABELS[h.source])}</span>}
              {relativeTime(h.executedAt)}
              {h.statements && <span>· {tp(h.statements, { one: '{n} statement', many: '{n} statements' })}</span>}
              {h.durationMs > 0 && <span>· {formatDuration(h.durationMs)}</span>}
              {h.rowCount !== undefined && h.rowCount !== null && <span>· {tp(h.rowCount, { one: '{n} row', many: '{n} rows' })}</span>}
            </span>
          </button>
        ))}
        {entries.length === 0 && <div className="p-4 text-center text-[12px] text-fg-faint">{search ? t('No matches') : t('Queries you run appear here.')}</div>}
      </div>
      {entries.length > 0 && (
        <div className="m-2 mt-0 flex gap-1">
          <button
            type="button"
            className="h-7 flex-1 rounded-md text-[12px] text-fg-muted hover:bg-hover hover:text-fg"
            title={t('Every statement run on this connection (editor, grid edits, imports, AI) as CSV')}
            onClick={() =>
              void api.exportHistory(connectionId).then(
                (path) => path && toast({ kind: 'success', message: t('History exported'), detail: path, action: { label: t('Show in folder'), run: () => void api.showItemInFolder(path) } }),
                (err: unknown) => toast({ kind: 'error', message: t('Export failed'), detail: errorMessage(err) }),
              )
            }
          >
            {t('Export…')}
          </button>
          <button
            type="button"
            className="h-7 flex-1 rounded-md text-[12px] text-fg-muted hover:bg-hover hover:text-fg"
            onClick={() => {
              void confirmAction({ title: t('Clear query history for this connection?'), confirmLabel: t('Clear history'), danger: true }).then((ok) => ok && api.clearHistory(connectionId).then(load))
            }}
          >
            {t('Clear history')}
          </button>
        </div>
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
  const allDashboards = useDashboards(connectionId)
  const hasKnowledge = useConnections((s) => !!s.list.find((c) => c.id === connectionId)?.knowledgeBasePath)
  const dashboards = useMemo(() => {
    const q = search.trim()
    return allDashboards.filter((d) => !q || fuzzyScore(d.name, q) >= 0 || d.tiles.some((x) => x.title.toLowerCase().includes(q.toLowerCase()))).sort((a, b) => a.name.localeCompare(b.name))
  }, [allDashboards, search])

  const open = (q: SavedQuery) =>
    openTab({ kind: 'query', connectionId, title: q.name, sql: q.sql, savedQueryId: q.id, savedSql: q.sql }, { reuse: false })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 pb-1.5">
        <Input inputSize="sm" placeholder={t('Search saved…')} value={search} onChange={(e) => setSearch(e.target.value)} leading={<Search size={12} />} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-2">
        {/* The connection's dashboards, only when it has some (pinned results; Add to dashboard above a result). */}
        {dashboards.length > 0 && (
          <div className="mb-1" data-testid="saved-dashboards">
            <div className="px-2 pt-1 pb-1 text-[11px] font-semibold tracking-wide text-fg-faint uppercase">{t('Dashboards')}</div>
            {dashboards.map((d) => (
              <button
                key={d.id}
                type="button"
                className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] hover:bg-hover"
                onClick={() => openDashboard(connectionId, d.id, d.name)}
                title={d.shared ? t('In the knowledge base: shared with everyone who uses it') : undefined}
                onContextMenu={(e) =>
                  openMenu(e, [
                    { label: t('Open'), icon: <LayoutDashboard size={13} />, onClick: () => openDashboard(connectionId, d.id, d.name) },
                    { label: t('Rename…'), icon: <Pencil size={13} />, onClick: () => void renameDashboard(d) },
                    ...(hasKnowledge && !d.shared ? [{ label: t('Move to the knowledge base'), icon: <BookOpen size={13} />, onClick: () => void moveToKnowledge(d) }] : []),
                    'separator',
                    { label: t('Delete'), icon: <Trash2 size={13} />, danger: true, onClick: () => void deleteDashboard(d) },
                  ])
                }
              >
                {d.shared ? <BookOpen size={12} className="shrink-0 text-accent" /> : <LayoutDashboard size={12} className="shrink-0 text-accent" />}
                <span className="truncate">{d.name}</span>
                <span className="ml-auto shrink-0 text-[10.5px] text-fg-faint">{tp(d.tiles.length, { one: '{n} tile', many: '{n} tiles' })}</span>
              </button>
            ))}
          </div>
        )}
        {dashboards.length > 0 && grouped.length > 0 && <div className="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-fg-faint uppercase">{t('Queries')}</div>}
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
                        void confirmAction({ title: t('Delete saved query “{name}”?', { name: q.name }), confirmLabel: t('Delete'), danger: true }).then((ok) => ok && api.deleteSavedQuery(q.id).then(load))
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
        {grouped.length === 0 && dashboards.length === 0 && (
          <div className="p-4 text-center text-[12px] text-fg-faint">{search ? t('No matches') : t('Save a query with {key} to keep it here.', { key: keys('⌘S') })}</div>
        )}
      </div>
    </div>
  )
}

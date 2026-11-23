import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookMarked, Copy, FileText, FolderOpen, HardDrive, LayoutDashboard, Pencil, Search, Share2, Trash2, XCircle } from 'lucide-react'
import type { Dashboard, HistoryEntry, SavedQuery } from '@shared/api'
import { openMenu } from '@/components/ui/ContextMenu'
import { Input } from '@/components/ui/Input'
import { api, keys } from '@/lib/api'
import { copyText, cn, errorMessage, formatDuration, fuzzyScore } from '@/lib/utils'
import { toast } from '@/store/ui'
import { useWorkspace } from '@/store/workspace'
import { formatDate, t, tp, useT } from '@/lib/i18n'
import { askText, confirmAction } from '@/components/ui/ConfirmDialog'
import { deleteDashboard, openDashboard, renameDashboard, shareDashboard, unshareDashboard, useDashboards } from '@/lib/dashboards'
import { useSettings } from '@/store/settings'
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

/** A saved query of the app-wide team folder ("Team/…"). */
const inTeamFolder = (q: SavedQuery) => q.folder === 'Team' || !!q.folder?.startsWith('Team/')
const folderName = (path: string | undefined) => path?.split(/[\\/]/).filter(Boolean).pop() ?? ''

/** Queries by folder (no folder last), each sorted by name. */
function byFolder(list: SavedQuery[], folderOf: (q: SavedQuery) => string): [string, SavedQuery[]][] {
  const map = new Map<string, SavedQuery[]>()
  for (const x of [...list].sort((a, b) => a.name.localeCompare(b.name))) map.set(folderOf(x), [...(map.get(folderOf(x)) ?? []), x])
  return [...map.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
}

/**
 * The connection's saved dashboards and queries in their two places: "This computer" (only you have them) and
 * "Team" (its knowledge base, and the team folder's queries). Headings only when something is shared.
 */
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
  const knowledgePath = useConnections((s) => s.list.find((c) => c.id === connectionId)?.knowledgeBasePath)
  const teamFolder = useSettings((s) => s.settings?.teamFolder)
  const allDashboards = useDashboards(connectionId)

  const matches = (text: string) => {
    const q = search.trim()
    return !q || fuzzyScore(text, q) >= 0 || text.toLowerCase().includes(q.toLowerCase())
  }
  const mine = queries.filter((x) => (!x.connectionId || x.connectionId === connectionId) && matches(`${x.name} ${x.folder ?? ''} ${x.sql}`))
  const local = {
    dashboards: allDashboards.filter((d) => !d.shared && matches(d.name)).sort((a, b) => a.name.localeCompare(b.name)),
    queries: byFolder(mine.filter((x) => !x.shared && !inTeamFolder(x)), (x) => x.folder ?? ''),
  }
  const team = {
    dashboards: allDashboards.filter((d) => d.shared && matches(d.name)).sort((a, b) => a.name.localeCompare(b.name)),
    queries: byFolder(mine.filter((x) => x.shared || inTeamFolder(x)), (x) => (inTeamFolder(x) ? (x.folder ?? '').replace(/^Team\/?/, '') : (x.folder ?? ''))),
  }
  const hasLocal = local.dashboards.length + local.queries.length > 0
  const hasTeam = team.dashboards.length + team.queries.length > 0
  const sources = [
    ...(knowledgePath && (team.dashboards.length || team.queries.some(([, l]) => l.some((x) => x.shared))) ? [knowledgePath] : []),
    ...(teamFolder && team.queries.some(([, l]) => l.some(inTeamFolder)) ? [teamFolder] : []),
  ]

  const open = (q: SavedQuery) => {
    if (q.problem) return toast({ kind: 'error', message: t('This file can’t be read'), detail: q.problem })
    openTab({ kind: 'query', connectionId, title: q.name, sql: q.sql, savedQueryId: q.id, savedSql: q.sql }, { reuse: false })
  }
  const share = async (q: SavedQuery) => {
    if (!(await confirmAction({ title: t('Share “{name}” with the team?', { name: q.name }), message: t('Everyone who uses this connection’s knowledge base will have it.'), confirmLabel: t('Share') }))) return
    await api.shareSavedQuery(q.id, connectionId).then(load, (err: unknown) => toast({ kind: 'error', message: t('Could not share the query'), detail: errorMessage(err) }))
  }
  const keepLocal = async (q: SavedQuery) => {
    if (!(await confirmAction({ title: t('Keep “{name}” on this computer only?', { name: q.name }), message: t('Your colleagues will no longer have it.'), confirmLabel: t('Keep on this computer only') }))) return
    // A team folder query leaves the team folder by losing its "Team" folder.
    const done = q.shared ? api.unshareSavedQuery(q.id) : api.saveQuery({ ...q, folder: undefined, connectionId: q.connectionId ?? connectionId })
    await done.then(load, (err: unknown) => toast({ kind: 'error', message: t('Could not move the query'), detail: errorMessage(err) }))
  }
  const rename = async (q: SavedQuery) => {
    const name = (await askText({ title: t('Rename query'), value: q.name, confirmLabel: t('Rename') }))?.trim()
    if (name && name !== q.name) await api.saveQuery({ ...q, name }).then(load, (err: unknown) => toast({ kind: 'error', message: t('Could not rename the query'), detail: errorMessage(err) }))
  }

  const dashboardRow = (d: Dashboard) => (
    <button
      key={d.id}
      type="button"
      className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] hover:bg-hover"
      onClick={() => openDashboard(connectionId, d.id, d.name)}
      title={d.problem}
      data-testid="saved-dashboard"
      onContextMenu={(e) =>
        openMenu(e, [
          { label: t('Open'), icon: <LayoutDashboard size={13} />, onClick: () => openDashboard(connectionId, d.id, d.name) },
          { label: t('Rename…'), icon: <Pencil size={13} />, onClick: () => void renameDashboard(d) },
          ...(!d.shared && knowledgePath ? [{ label: t('Share with the team'), icon: <Share2 size={13} />, onClick: () => void shareDashboard(d) }] : []),
          ...(d.shared ? [{ label: t('Keep on this computer only'), icon: <HardDrive size={13} />, onClick: () => void unshareDashboard(d) }] : []),
          'separator',
          { label: t('Delete'), icon: <Trash2 size={13} />, danger: true, onClick: () => void deleteDashboard(d) },
        ])
      }
    >
      <LayoutDashboard size={12} className="shrink-0 text-accent" />
      <span className="truncate">{d.name}</span>
      <span className="ml-auto shrink-0 text-[10.5px] text-fg-faint">{d.problem ? t('can’t be read') : tp(d.tiles.length, { one: '{n} tile', many: '{n} tiles' })}</span>
    </button>
  )
  const queryRow = (q: SavedQuery) => (
    <button
      key={q.id}
      type="button"
      className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] hover:bg-hover"
      onClick={() => open(q)}
      title={q.problem ?? q.sql.slice(0, 2000)}
      data-testid="saved-query"
      onContextMenu={(e) =>
        openMenu(e, [
          { label: t('Open'), icon: <FileText size={13} />, onClick: () => open(q) },
          { label: t('Copy SQL'), icon: <Copy size={13} />, onClick: () => void copyText(q.sql) },
          ...(q.problem ? [] : [{ label: t('Rename…'), icon: <Pencil size={13} />, onClick: () => void rename(q) }]),
          ...(!q.shared && !inTeamFolder(q) && knowledgePath ? [{ label: t('Share with the team'), icon: <Share2 size={13} />, onClick: () => void share(q) }] : []),
          ...((q.shared && !q.problem) || inTeamFolder(q) ? [{ label: t('Keep on this computer only'), icon: <HardDrive size={13} />, onClick: () => void keepLocal(q) }] : []),
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
      {q.problem && <span className="ml-auto shrink-0 text-[10.5px] text-danger">{t('can’t be read')}</span>}
    </button>
  )
  const group = (g: typeof local) => (
    <>
      {g.dashboards.map(dashboardRow)}
      {g.queries.map(([folder, items]) => (
        <div key={folder} className="mb-1">
          {folder && <div className="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-fg-faint uppercase">{folder}</div>}
          {items.map(queryRow)}
        </div>
      ))}
    </>
  )
  const heading = (text: string) => <div className="px-2 pt-2 pb-0.5 text-[11px] font-semibold tracking-wide text-fg-muted uppercase">{text}</div>

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 pb-1.5">
        <Input inputSize="sm" placeholder={t('Search saved…')} value={search} onChange={(e) => setSearch(e.target.value)} leading={<Search size={12} />} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-2">
        {/* Only local things: the plain lists, no heading (as calm as before anything was shared). */}
        {hasLocal && (
          <div data-testid="saved-local">
            {hasTeam && heading(t('This computer'))}
            {group(local)}
          </div>
        )}
        {hasTeam && (
          <div data-testid="saved-team">
            {heading(t('Team'))}
            {sources.map((path) => (
              <button
                key={path}
                type="button"
                className="block max-w-full truncate px-2 pb-1 text-left text-[11px] text-fg-faint hover:text-fg"
                title={path}
                onClick={(e) => openMenu(e.currentTarget, [{ label: t('Show in folder'), icon: <FolderOpen size={13} />, onClick: () => void api.showItemInFolder(path) }])}
              >
                {folderName(path)}
              </button>
            ))}
            {group(team)}
          </div>
        )}
        {!hasLocal && !hasTeam && (
          <div className="p-4 text-center text-[12px] text-fg-faint">{search ? t('No matches') : t('Save a query with {key} to keep it here.', { key: keys('⌘S') })}</div>
        )}
      </div>
    </div>
  )
}

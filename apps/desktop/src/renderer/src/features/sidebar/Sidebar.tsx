import { useMemo, useState } from 'react'
import {
  Activity,
  BookMarked,
  BookOpen,
  ChevronDown,
  Copy,
  Database,
  FileText,
  FolderTree,
  History,
  Home,
  Pencil,
  Plug,
  Plus,
  Power,
  Search,
  Share2,
  ShieldCheck,
  Trash2,
  Unplug,
} from 'lucide-react'
import { isFileDriver } from '@dbmastermind/core/browser'
import type { StoredConnection } from '@shared/api'
import { IconButton } from '@/components/ui/Button'
import { openMenu } from '@/components/ui/ContextMenu'
import { Input } from '@/components/ui/Input'
import { Spinner } from '@/components/ui/Spinner'
import { api, isMac } from '@/lib/api'
import { exportDataDictionary } from '@/lib/dictionary'
import { cn, errorMessage, fuzzyScore } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { toast, useUi } from '@/store/ui'
import { useActiveTab, useWorkspace } from '@/store/workspace'
import { DriverIcon, driverLabel } from '../connections/drivers'
import { HistoryPanel, SavedQueriesPanel } from './LibraryPanels'
import { SchemaTree } from './SchemaTree'
import { t, tp, useT } from '@/lib/i18n'

export function useCurrentConnectionId(): string | undefined {
  const tab = useActiveTab()
  const selected = useUi((s) => s.selectedConnectionId)
  return tab?.connectionId ?? selected
}

export async function connectAndSelect(id: string): Promise<boolean> {
  const ok = await useConnections.getState().connect(id)
  if (ok) {
    useUi.getState().set({ selectedConnectionId: id })
    const ws = useWorkspace.getState()
    // Jump to an existing tab of this connection, or start with a query tab.
    const existing = ws.tabs.find((t) => t.connectionId === id)
    if (existing) ws.activate(existing.id)
    else ws.newQuery(id)
  } else {
    const c = useConnections.getState().get(id)
    toast({ kind: 'error', message: c ? t('Could not connect to {name}', { name: c.name }) : t('Could not connect to the database'), detail: useConnections.getState().runtime[id]?.error })
  }
  return ok
}

export function connectionMenu(c: StoredConnection): Parameters<typeof openMenu>[1] {
  const { runtime, disconnect, duplicate, remove } = useConnections.getState()
  const connected = runtime[c.id]?.status === 'connected'
  return [
    connected
      ? { label: t('Disconnect'), icon: <Unplug size={13} />, onClick: () => void disconnect(c.id) }
      : { label: t('Connect'), icon: <Plug size={13} />, onClick: () => void connectAndSelect(c.id) },
    { label: t('Edit…'), icon: <Pencil size={13} />, onClick: () => useUi.getState().set({ modal: { kind: 'connection', connectionId: c.id } }) },
    { label: t('Duplicate'), icon: <Copy size={13} />, onClick: () => void duplicate(c.id) },
    { label: t('Data dictionary (HTML)…'), icon: <FileText size={13} />, onClick: () => void exportDataDictionary(c.id, 'html') },
    ...(isFileDriver(c.driver)
      ? []
      : [{ label: t('Users & roles'), icon: <ShieldCheck size={13} />, onClick: () => useWorkspace.getState().open({ kind: 'roles', connectionId: c.id, title: t('Users & roles') }) }]),
    { label: t('Share with colleagues (without password)…'), icon: <Share2 size={13} />, onClick: () => void shareConnections([c.id]) },
    'separator',
    {
      label: t('Delete'),
      icon: <Trash2 size={13} />,
      danger: true,
      onClick: () => {
        if (window.confirm(t('Delete connection “{name}”? Saved queries are kept.', { name: c.name }))) {
          useWorkspace.getState().closeForConnection(c.id)
          void remove(c.id)
        }
      },
    },
  ]
}

export function StatusDot({ id, className }: { id: string; className?: string }) {
  const status = useConnections((s) => s.runtime[id]?.status ?? 'disconnected')
  if (status === 'connecting') return <Spinner size={10} className={cn('text-fg-faint', className)} />
  return (
    <span
      className={cn(
        'inline-block h-[7px] w-[7px] shrink-0 rounded-full',
        status === 'connected' ? 'bg-success' : status === 'error' ? 'bg-danger' : 'bg-line-strong',
        className,
      )}
    />
  )
}

type Panel = 'explorer' | 'saved' | 'history'

export function Sidebar() {
  const connectionId = useCurrentConnectionId()
  const connection = useConnections((s) => s.list.find((c) => c.id === connectionId))
  const runtime = useConnections((s) => (connectionId ? s.runtime[connectionId] : undefined))
  const [panel, setPanel] = useState<Panel>('explorer')
  const t = useT()

  return (
    <div className="flex h-full min-h-0 flex-col bg-subtle">
      <div className={cn('drag-region flex h-[38px] shrink-0 items-center gap-1 pr-1.5', isMac ? 'pl-[78px]' : 'pl-2.5')}>
        {!isMac && <span className="text-[12px] font-semibold tracking-tight text-fg-muted">DB Mastermind</span>}
        <div className="flex-1" />
        <div className="no-drag flex items-center">
          <IconButton label={t('All connections')} onClick={() => {
              useUi.getState().set({ selectedConnectionId: undefined })
              useWorkspace.getState().activate('')
            }}>
            <Home size={14} />
          </IconButton>
          <IconButton label={t('New connection')} onClick={() => useUi.getState().set({ modal: { kind: 'connection' } })}>
            <Plus size={15} />
          </IconButton>
        </div>
      </div>
      {connection ? (
        <>
          <ConnectionHeader connection={connection} />
          <div className="flex gap-0.5 px-2 pb-1">
            {(
              [
                ['explorer', FolderTree, 'Explorer'],
                ['saved', BookMarked, 'Saved'],
                ['history', History, 'History'],
              ] as const
            ).map(([id, Icon, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setPanel(id)}
                className={cn(
                  'flex h-6 flex-1 items-center justify-center gap-1 rounded-md text-[11.5px] font-medium',
                  panel === id ? 'bg-active text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg',
                )}
              >
                <Icon size={12} /> {t(label)}
              </button>
            ))}
            <button
              type="button"
              title={t('Knowledge base')}
              onClick={() => useWorkspace.getState().open({ kind: 'knowledge', connectionId: connection.id, title: t('Knowledge base') })}
              className="flex h-6 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg"
            >
              <BookOpen size={12} />
            </button>
            {!isFileDriver(connection.driver) && (
              <button
                type="button"
                title={t('Server activity')}
                onClick={() => useWorkspace.getState().open({ kind: 'activity', connectionId: connection.id, title: t('Server activity') })}
                className="flex h-6 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg"
              >
                <Activity size={12} />
              </button>
            )}
          </div>
          {panel === 'explorer' &&
            (runtime?.status === 'connected' ? (
              <SchemaTree connection={connection} schema={runtime.schema} />
            ) : (
              <NotConnected connection={connection} />
            ))}
          {panel === 'saved' && <SavedQueriesPanel connectionId={connection.id} />}
          {panel === 'history' && <HistoryPanel connectionId={connection.id} />}
        </>
      ) : (
        <ConnectionList />
      )}
    </div>
  )
}

function NotConnected({ connection }: { connection: StoredConnection }) {
  const runtime = useConnections((s) => s.runtime[connection.id])
  const t = useT()
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
      {runtime?.status === 'error' && <div className="text-[12px] break-words text-danger select-text">{runtime.error}</div>}
      <button
        type="button"
        className="inline-flex h-8 items-center gap-2 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg hover:bg-accent-hover"
        onClick={() => void connectAndSelect(connection.id)}
        disabled={runtime?.status === 'connecting'}
      >
        {runtime?.status === 'connecting' ? <Spinner size={13} /> : <Power size={13} />} {t('Connect')}
      </button>
    </div>
  )
}

function ConnectionHeader({ connection }: { connection: StoredConnection }) {
  const list = useConnections((s) => s.list)
  const info = useConnections((s) => s.runtime[connection.id]?.serverInfo)
  return (
    <div className="px-2 pb-1.5">
      <button
        type="button"
        className="flex h-9 w-full items-center gap-2 rounded-md border border-line bg-bg px-2 text-left hover:border-line-strong"
        style={connection.color ? { boxShadow: `inset 3px 0 0 ${connection.color}` } : undefined}
        onClick={(e) =>
          openMenu(e.currentTarget, [
            ...list.map((c) => ({
              label: c.name,
              icon: <DriverIcon driver={c.driver} size={14} />,
              checked: c.id === connection.id,
              onClick: () => void connectAndSelect(c.id),
            })),
            'separator' as const,
            ...connectionMenu(connection),
          ])
        }
        title={info ? `${info.product} ${info.version}` : driverLabel(connection.driver)}
      >
        <DriverIcon driver={connection.driver} size={18} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] font-semibold">{connection.name}</span>
            {connection.environment === 'production' && <span className="rounded bg-danger px-1 text-[9.5px] font-bold text-white">PROD</span>}
            {connection.readOnly && <span className="rounded bg-muted px-1 text-[9.5px] font-semibold text-fg-muted">RO</span>}
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-fg-faint">
            <StatusDot id={connection.id} />
            <span className="truncate">{isFileDriver(connection.driver) ? connection.filePath || t('in-memory') : `${connection.user ? `${connection.user}@` : ''}${connection.host ?? ''}${connection.database ? `/${connection.database}` : ''}`}</span>
          </div>
        </div>
        <ChevronDown size={13} className="shrink-0 text-fg-faint" />
      </button>
    </div>
  )
}

function ConnectionList() {
  const list = useConnections((s) => s.list)
  const [filter, setFilter] = useState('')
  const t = useT()
  const groups = useMemo(() => {
    const q = filter.trim()
    const filtered = list
      .filter((c) => !q || fuzzyScore(`${c.name} ${c.host ?? ''} ${c.database ?? ''}`, q) >= 0)
      .sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '') || a.name.localeCompare(b.name))
    const map = new Map<string, StoredConnection[]>()
    for (const c of filtered) {
      const g = c.group ?? ''
      map.set(g, [...(map.get(g) ?? []), c])
    }
    return [...map.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
  }, [list, filter])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 pb-1.5">
        <Input inputSize="sm" placeholder={t('Search connections…')} value={filter} onChange={(e) => setFilter(e.target.value)} leading={<Search size={12} />} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-2">
        {groups.map(([group, items]) => (
          <div key={group} className="mb-1">
            {group && <div className="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-fg-faint uppercase">{group}</div>}
            {items.map((c) => (
              <button
                key={c.id}
                type="button"
                className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-hover"
                onClick={() => void connectAndSelect(c.id)}
                onContextMenu={(e) => openMenu(e, connectionMenu(c))}
              >
                <DriverIcon driver={c.driver} size={18} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 truncate text-[12.5px] font-medium">
                    {c.color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: c.color }} />}
                    {c.name}
                  </div>
                  <div className="truncate text-[11px] text-fg-faint">{isFileDriver(c.driver) ? c.filePath || t('in-memory') : `${c.host ?? ''}${c.database ? `/${c.database}` : ''}`}</div>
                </div>
                <StatusDot id={c.id} />
              </button>
            ))}
          </div>
        ))}
        {list.length === 0 && (
          <div className="flex flex-col items-center gap-2 p-6 text-center text-[12px] text-fg-faint">
            <Database size={22} />
            {t('No connections yet.')}
          </div>
        )}
      </div>
      <div className="flex gap-1 border-t border-line p-2">
        <button
          type="button"
          className="flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md bg-accent text-[12.5px] font-medium text-accent-fg hover:bg-accent-hover"
          onClick={() => useUi.getState().set({ modal: { kind: 'connection' } })}
        >
          <Plus size={14} /> {t('New connection')}
        </button>
        <IconButton
          label={t('Import connections')}
          size="md"
          onClick={(e) =>
            openMenu(e.currentTarget, [
              { label: t('From Beekeeper Studio'), onClick: () => void importFrom('beekeeper') },
              { label: t('From DBeaver'), onClick: () => void importFrom('dbeaver') },
              { label: t('From JSON file…'), onClick: () => void importFrom('file') },
              'separator',
              { label: t('Share all connections (without passwords)…'), icon: <Share2 size={13} />, onClick: () => void shareConnections() },
            ])
          }
        >
          <ChevronDown size={14} />
        </IconButton>
      </div>
    </div>
  )
}

export async function shareConnections(ids?: string[]) {
  try {
    const path = await api.exportConnections(ids)
    if (path)
      toast({
        kind: 'success',
        message: t('Connections exported'),
        detail: t('Passwords and keys are not included. Colleagues import the file via New connection ▾ → From JSON file.'),
        action: { label: t('Show in folder'), run: () => void api.showItemInFolder(path) },
      })
  } catch (err) {
    toast({ kind: 'error', message: t('Export failed'), detail: errorMessage(err) })
  }
}

export async function importFrom(source: 'beekeeper' | 'dbeaver' | 'file') {
  try {
    const n = await api.importConnections(source)
    await useConnections.getState().load()
    toast({
      kind: n ? 'success' : 'info',
      message: n ? tp(n, { one: 'Imported {n} connection', many: 'Imported {n} connections' }) : t('Nothing new to import'),
      detail: source === 'beekeeper' && n ? t('Beekeeper stores passwords encrypted, so enter them when you first connect.') : undefined,
    })
  } catch (err) {
    toast({ kind: 'error', message: t('Import failed'), detail: errorMessage(err) })
  }
}

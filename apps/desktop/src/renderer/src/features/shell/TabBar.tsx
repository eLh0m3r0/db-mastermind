import { useRef, useState } from 'react'
import { Activity, BookOpen, FileCode2, LayoutDashboard, Rows3, ShieldCheck, GitCompare, Layers, Network, PanelLeft, Plus, Sparkles, Table2, TerminalSquare, X, Columns2 } from 'lucide-react'
import { IconButton } from '@/components/ui/Button'
import { openMenu } from '@/components/ui/ContextMenu'
import { isMac, modKey } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { useUi } from '@/store/ui'
import { useWorkspace, type Tab } from '@/store/workspace'
import { useCurrentConnectionId } from '../sidebar/Sidebar'
import { useT } from '@/lib/i18n'

const ICONS = { query: TerminalSquare, table: Table2, structure: Layers, diagram: Network, knowledge: BookOpen, compare: GitCompare, activity: Activity, datacompare: Rows3, roles: ShieldCheck, model: FileCode2, dashboard: LayoutDashboard }

export function TabBar() {
  const tabs = useWorkspace((s) => s.tabs)
  const activeId = useWorkspace((s) => s.activeTabId)
  const { activate, close, closeOthers, move, newQuery, update, splitRight, unsplit } = useWorkspace()
  const split = useWorkspace((s) => s.split)
  const connections = useConnections((s) => s.list)
  const currentConnection = useCurrentConnectionId()
  const sidebarVisible = useUi((s) => s.sidebarVisible)
  const aiVisible = useUi((s) => s.aiPanelVisible)
  const setUi = useUi((s) => s.set)
  const dragId = useRef<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const t = useT()
  const multipleConnections = new Set(tabs.map((t) => t.connectionId)).size > 1

  const menu = (e: React.MouseEvent, tab: Tab) =>
    openMenu(e, [
      { label: t('Close'), shortcut: `${modKey}W`, onClick: () => close(tab.id) },
      { label: t('Close others'), onClick: () => closeOthers(tab.id) },
      'separator',
      { label: t('Open to the side'), icon: <Columns2 size={13} />, disabled: tabs.length < 2 || split?.right === tab.id, onClick: () => splitRight(tab.id) },
      ...(split ? [{ label: t('Close split view'), onClick: () => unsplit() }] : []),
      'separator',
      {
        label: t('Rename…'),
        onClick: () => {
          const title = window.prompt(t('Tab name'), tab.title)
          if (title?.trim()) update(tab.id, { title: title.trim() })
        },
      },
      ...(tab.kind === 'query'
        ? [{ label: t('Duplicate'), onClick: () => newQuery(tab.connectionId, tab.sql, t('{title} (copy)', { title: tab.title })) }]
        : []),
    ])

  return (
    <div className={cn('drag-region flex h-[38px] shrink-0 items-end border-b border-line bg-subtle', !sidebarVisible && isMac && 'pl-[78px]')}>
      {!sidebarVisible && (
        <IconButton label={`${t('Show sidebar')} (${modKey}B)`} className="no-drag mb-1.5 ml-1.5" onClick={() => setUi({ sidebarVisible: true })}>
          <PanelLeft size={14} />
        </IconButton>
      )}
      <div className="no-drag flex min-w-0 flex-1 items-end overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((tab) => {
          const Icon = ICONS[tab.kind]
          const conn = connections.find((c) => c.id === tab.connectionId)
          const active = tab.id === activeId
          const dirty = tab.kind === 'query' && tab.savedQueryId && tab.savedSql !== undefined && tab.sql !== tab.savedSql
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              draggable
              onDragStart={() => (dragId.current = tab.id)}
              onDragOver={(e) => {
                e.preventDefault()
                setDropTarget(tab.id)
              }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={() => {
                if (dragId.current) move(dragId.current, tab.id)
                dragId.current = null
                setDropTarget(null)
              }}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  close(tab.id)
                } else if (e.button === 0) activate(tab.id)
              }}
              onContextMenu={(e) => menu(e, tab)}
              title={`${tab.title}${conn ? ` · ${conn.name}` : ''}`}
              className={cn(
                'group relative flex h-[31px] max-w-[220px] min-w-[110px] shrink-0 cursor-default items-center gap-1.5 rounded-t-md border border-b-0 pr-1 pl-2.5 text-[12.5px]',
                active ? 'z-10 -mb-px h-[32px] border-line bg-bg text-fg' : 'border-transparent text-fg-muted hover:bg-hover hover:text-fg',
                dropTarget === tab.id && 'border-l-2 border-l-accent',
              )}
            >
              {conn?.color && <span className="absolute inset-x-2 top-0 h-[2px] rounded-b" style={{ background: conn.color }} />}
              <Icon size={13} className={cn('shrink-0', active ? 'text-accent' : 'text-fg-faint')} />
              <span className="min-w-0 flex-1 truncate">
                {tab.title}
                {multipleConnections && conn && <span className="ml-1 text-[11px] text-fg-faint">· {conn.name}</span>}
              </span>
              {split && (split.left === tab.id || split.right === tab.id) && (
                <span title={split.left === tab.id ? t('Left pane') : t('Right pane')}>
                  <Columns2 size={11} className={cn('shrink-0', active ? 'text-accent' : 'text-fg-faint')} />
                </span>
              )}
              {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-fg-muted group-hover:hidden" />}
              <button
                type="button"
                aria-label={t('Close tab')}
                className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-active hover:text-fg', !active && 'opacity-0 group-hover:opacity-100', dirty && 'hidden group-hover:flex')}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => close(tab.id)}
              >
                <X size={12} />
              </button>
            </div>
          )
        })}
        {currentConnection && (
          <IconButton label={`${t('New query')} (${modKey}T)`} className="mb-1 ml-1" onClick={() => newQuery(currentConnection)}>
            <Plus size={15} />
          </IconButton>
        )}
      </div>
      <div className="no-drag mb-1.5 flex items-center gap-0.5 px-1.5">
        <IconButton label={`${t('AI assistant')} (${modKey}J)`} active={aiVisible} onClick={() => setUi({ aiPanelVisible: !aiVisible })}>
          <Sparkles size={14} />
        </IconButton>
      </div>
    </div>
  )
}

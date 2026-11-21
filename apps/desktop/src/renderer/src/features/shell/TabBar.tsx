import { setSidebarShown, useSidebarShown } from './sidebar-shown'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Activity, BookOpen, Eye, FileCode2, LayoutDashboard, Rows3, ShieldCheck, GitCompare, Layers, Network, PanelLeft, Plus, Search, Sparkles, Table2, TerminalSquare, X, Columns2 } from 'lucide-react'
import { findTableOrPartition } from '@dbmastermind/core/browser'
import { runCommand } from '@/lib/commands'
import { IconButton } from '@/components/ui/Button'
import { openMenu } from '@/components/ui/ContextMenu'
import { askText } from '@/components/ui/ConfirmDialog'
import { isMac, keys } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { useUi } from '@/store/ui'
import { confirmCloseTabs, useUnsavedEdits, useWorkspace, type Tab } from '@/store/workspace'
import { shrinkTabWidths, tabsBeside } from '@/store/tab-order'
import { useSettings } from '@/store/settings'
import { useTransactions } from '@/store/transactions'
import { useCurrentConnectionId } from '../sidebar/Sidebar'
import { useT } from '@/lib/i18n'

/** How wide the fade over a cut-off end of the strip is (px). */
const FADE = 28

/**
 * Shrink mode's floor, measured on the render: at 12.5 px a tab with its icon and its connection's color dot needs
 * about 49 px of chrome, and the name reads from about 5 characters and the ellipsis ("custo…", "order…", "Dotaz…",
 * "objed…"). At 72 px only 1–3 characters were left ("Q…", "or…"), which reads as nothing. Below it the strip scrolls.
 */
export const TAB_FLOOR = 92

export const TAB_ICONS = { query: TerminalSquare, table: Table2, structure: Layers, diagram: Network, knowledge: BookOpen, compare: GitCompare, activity: Activity, datacompare: Rows3, roles: ShieldCheck, model: FileCode2, dashboard: LayoutDashboard, search: Search }

export function TabBar() {
  const isView = (tab: Extract<Tab, { kind: 'table' }>) => {
    const schema = runtime[tab.connectionId]?.schema
    const info = schema ? findTableOrPartition(schema, tab.table) : undefined
    return !!info && info.type !== 'table'
  }
  const tabs = useWorkspace((s) => s.tabs)
  const activeId = useWorkspace((s) => s.activeTabId)
  const { activate, close, closeOthers, closeTabs, move, newQuery, update, splitRight, unsplit } = useWorkspace()
  const split = useWorkspace((s) => s.split)
  const connections = useConnections((s) => s.list)
  const runtime = useConnections((s) => s.runtime)
  const currentConnection = useCurrentConnectionId()
  const sidebarVisible = useSidebarShown()
  const aiVisible = useUi((s) => s.aiPanelVisible)
  const setUi = useUi((s) => s.set)
  const unsaved = useUnsavedEdits((s) => s.ids)
  const dragId = useRef<string | null>(null)
  // Tabs keep their names (up to 220 px; squeezing them made every tab unreadable). With more tabs than fit, the
  // strip scrolls; "+" stays outside it, so it is never scrolled away or faded out. A side fades only while tabs are
  // hidden there, and the selected tab is kept clear of the fades.
  const strip = useRef<HTMLDivElement>(null)
  const [fade, setFade] = useState({ left: false, right: false })
  const measureFades = useCallback(() => {
    const el = strip.current
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    const next = { left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 }
    setFade((f) => (f.left === next.left && f.right === next.right ? f : next))
  }, [])
  const revealActive = useCallback(() => {
    const el = strip.current
    const tab = el?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    if (!el || !tab) return
    const left = tab.offsetLeft - el.offsetLeft
    const right = left + tab.offsetWidth
    const max = el.scrollWidth - el.clientWidth
    // Room for the fade on a side only where tabs stay hidden after scrolling.
    if (left - (el.scrollLeft > 0 ? FADE : 0) < el.scrollLeft) el.scrollLeft = Math.max(0, left - (left > 0 ? FADE : 0))
    else if (right + FADE > el.scrollLeft + el.clientWidth) el.scrollLeft = Math.min(max, right + (right < el.scrollWidth - 1 ? FADE : 0) - el.clientWidth)
    measureFades()
  }, [measureFades])
  useLayoutEffect(() => {
    revealActive()
  }, [activeId, tabs.length, split, revealActive])
  useEffect(() => {
    const el = strip.current
    if (!el) return
    // A tab that changes width (split mark, rename, transaction dot) or a resized window moves the selected one.
    const observer = new ResizeObserver(() => revealActive())
    observer.observe(el)
    for (const tab of el.querySelectorAll('[role="tab"]')) observer.observe(tab)
    return () => observer.disconnect()
  }, [tabs, revealActive])
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const t = useT()
  const multipleConnections = new Set(tabs.map((t) => t.connectionId)).size > 1
  const transactions = useTransactions()

  // Shrink mode (Settings → Appearance): the inactive tabs get narrower before the strip scrolls; the selected one
  // keeps its width. Natural widths are read from the rendered tabs (their names' full width), so they are exact in
  // every language and font.
  const shrink = useSettings((s) => s.settings?.tabOverflow === 'shrink')
  const bar = useRef<HTMLDivElement>(null)
  const plus = useRef<HTMLButtonElement>(null)
  const ai = useRef<HTMLDivElement>(null)
  const [widths, setWidths] = useState<Record<string, number> | null>(null)
  const layoutShrink = useCallback(() => {
    const el = strip.current
    if (!shrink || !el || !bar.current || !plus.current || !ai.current) return setWidths((w) => (w ? null : w))
    const tabEls = [...el.querySelectorAll<HTMLElement>('[role="tab"]')]
    const natural = tabEls.map((tab) => {
      const title = tab.querySelector<HTMLElement>('[data-tab-title]')!
      // The chrome (icon, dots, padding) plus the name's whole width; a narrowed tab's close button floats, so it is added.
      const chrome = tab.offsetWidth - title.clientWidth + (tab.dataset.narrow !== undefined ? 28 : 0)
      return Math.min(220, Math.max(110, Math.ceil(chrome + title.scrollWidth)))
    })
    const left = el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft)
    const plusBox = plus.current.getBoundingClientRect()
    const available = Math.floor(ai.current.getBoundingClientRect().left - 8 - (plusBox.width + 4) - left)
    const active = tabEls.findIndex((tab) => tab.getAttribute('aria-selected') === 'true')
    const shrunk = shrinkTabWidths(natural, active, available, TAB_FLOOR)
    const next = shrunk && Object.fromEntries(tabEls.map((tab, i) => [tab.dataset.tabId!, shrunk[i]!]).filter(([, w], i) => (w as number) < natural[i]!))
    setWidths((w) => (JSON.stringify(w) === JSON.stringify(next) ? w : next))
  }, [shrink])
  useLayoutEffect(() => {
    layoutShrink()
  }, [layoutShrink, tabs, activeId, split, transactions, unsaved, sidebarVisible, aiVisible, currentConnection])
  useEffect(() => {
    if (!bar.current) return
    const observer = new ResizeObserver(() => layoutShrink())
    observer.observe(bar.current)
    return () => observer.disconnect()
  }, [layoutShrink])

  const closeTab = (id: string) => void confirmCloseTabs([id]).then((ok) => ok && close(id))
  // The strip is one stop in the Tab order: arrows move between tabs, Delete closes the focused one.
  const onStripKey = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((tab) => tab.id === activeId)
    const go = (index: number) => {
      const tab = tabs[(index + tabs.length) % tabs.length]
      if (!tab) return
      e.preventDefault()
      activate(tab.id)
      requestAnimationFrame(() => strip.current?.querySelector<HTMLElement>(`[data-tab-id="${tab.id}"]`)?.focus())
    }
    if (e.key === 'ArrowRight') go(i + 1)
    else if (e.key === 'ArrowLeft') go(i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(tabs.length - 1)
    else if ((e.key === 'Delete' || e.key === 'Backspace') && activeId && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      closeTab(activeId)
    }
  }
  const fadeMask = fade.left || fade.right ? `linear-gradient(to right, ${fade.left ? `transparent, black ${FADE}px` : 'black'}, ${fade.right ? `black calc(100% - ${FADE}px), transparent` : 'black'})` : undefined
  const menu = (e: React.MouseEvent, tab: Tab) =>
    openMenu(e, [
      { label: t('Close'), shortcut: keys('⌘W'), onClick: () => closeTab(tab.id) },
      { label: t('Close others'), onClick: () => void confirmCloseTabs(tabs.filter((x) => x.id !== tab.id).map((x) => x.id)).then((ok) => ok && closeOthers(tab.id)) },
      // Every tab on that side, through the same questions as Close others (Cancel closes nothing).
      ...(['left', 'right'] as const).map((side) => {
        const ids = tabsBeside(
          tabs.map((x) => x.id),
          tab.id,
          side,
        )
        return {
          label: side === 'left' ? t('Close tabs to the left') : t('Close tabs to the right'),
          disabled: ids.length === 0,
          onClick: () => void confirmCloseTabs(ids).then((ok) => ok && closeTabs(ids, tab.id)),
        }
      }),
      'separator',
      { label: t('Open to the side'), icon: <Columns2 size={13} />, disabled: tabs.length < 2 || split?.right === tab.id, onClick: () => splitRight(tab.id) },
      ...(split ? [{ label: t('Close split view'), onClick: () => unsplit() }] : []),
      'separator',
      {
        label: t('Rename…'),
        onClick: async () => {
          const title = await askText({ title: t('Rename tab'), value: tab.title, confirmLabel: t('Rename') })
          if (title) update(tab.id, { title })
        },
      },
      ...(tab.kind === 'query'
        ? [{ label: t('Duplicate'), onClick: () => newQuery(tab.connectionId, tab.sql, t('{title} (copy)', { title: tab.title })) }]
        : []),
    ])

  return (
    <div ref={bar} className={cn('drag-region flex h-[38px] shrink-0 items-end border-b border-line bg-subtle', !sidebarVisible && isMac && 'pl-[78px]')}>
      {!sidebarVisible && (
        <IconButton label={`${t('Show sidebar')} (${keys('⌘B')})`} className="no-drag mb-1.5 ml-1.5" onClick={() => setSidebarShown(true)}>
          <PanelLeft size={14} />
        </IconButton>
      )}
      {/* The first tab keeps off the sidebar's border line. The strip takes only the room its tabs need, so "+" follows
          the last tab while they fit and stays at the strip's end when they don't; what is left drags the window. */}
      <div
        ref={strip}
        role="tablist"
        aria-label={t('Open tabs')}
        // A mouse wheel scrolls the strip sideways.
        onWheel={(e) => {
          if (strip.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) strip.current.scrollLeft += e.deltaY
        }}
        onScroll={measureFades}
        onKeyDown={onStripKey}
        data-fade={`${fade.left ? 'left' : ''}${fade.right ? 'right' : ''}` || undefined}
        style={{ maskImage: fadeMask, WebkitMaskImage: fadeMask }}
        className="no-drag flex min-w-0 shrink grow-0 basis-auto items-end overflow-x-auto pl-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab, i) => {
          const Icon = TAB_ICONS[tab.kind]
          const conn = connections.find((c) => c.id === tab.connectionId)
          const active = tab.id === activeId
          const dirty = (tab.kind === 'query' && (tab.savedQueryId || tab.path) && tab.savedSql !== undefined && tab.sql !== tab.savedSql) || unsaved.includes(tab.id)
          const Shown = tab.kind === 'table' && isView(tab) ? Eye : Icon
          // Narrowed by Shrink mode: the name gets the room, the close button floats over its end on hover or focus.
          const width = widths?.[tab.id]
          const narrow = width !== undefined
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              data-tab-id={tab.id}
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
                  closeTab(tab.id)
                } else if (e.button === 0) activate(tab.id)
              }}
              onContextMenu={(e) => menu(e, tab)}
              title={`${tab.title}${conn ? ` · ${conn.name}` : ''}`}
              data-narrow={narrow ? '' : undefined}
              style={narrow ? { width } : undefined}
              className={cn(
                'group relative flex h-[31px] max-w-[220px] shrink-0 cursor-default items-center gap-1.5 rounded-t-md border border-b-0 pl-2.5 text-[12.5px]',
                narrow ? 'min-w-0 pr-1.5' : 'min-w-[110px] pr-1',
                shrink && 'transition-[width] duration-150 ease-out motion-reduce:transition-none',
                active ? 'z-10 -mb-px h-[32px] border-line bg-bg text-fg' : 'border-transparent text-fg-muted hover:bg-hover hover:text-fg',
                dropTarget === tab.id && 'border-l-2 border-l-accent',
              )}
            >
              {/* A faint divider between inactive tabs shows where one ends (not next to the selected one, nor on hover). */}
              {!active && tabs[i + 1]?.id !== activeId && <span aria-hidden className="tab-divider absolute top-[9px] right-0 bottom-[9px] w-px group-hover:hidden" />}
              {/* The selected tab is marked with the accent, like every selection in the app. */}
              {active && <span className="absolute inset-x-2 top-0 h-[2px] rounded-b bg-accent" />}
              <Shown size={13} className={cn('shrink-0', active ? 'text-accent' : 'text-fg-faint')} />
              {/* The connection's own color (production in red…) stays visible, as a dot. */}
              {conn?.color && <span className="-ml-0.5 h-2 w-2 shrink-0 rounded-full ring-1 ring-black/10" style={{ background: conn.color }} title={conn.name} data-testid="tab-connection-color" />}
              <span className="min-w-0 flex-1 truncate" data-tab-title>
                {tab.title}
                {multipleConnections && conn && <span className="ml-1 text-[11px] text-fg-faint">· {conn.name}</span>}
              </span>
              {split && (split.left === tab.id || split.right === tab.id) && (
                <span title={split.left === tab.id ? t('Left pane') : t('Right pane')}>
                  <Columns2 size={11} className={cn('shrink-0', active ? 'text-accent' : 'text-fg-faint')} />
                </span>
              )}
              {transactions[tab.id] && (
                <span
                  className={cn('h-2 w-2 shrink-0 rounded-full', transactions[tab.id]!.state === 'failed' ? 'bg-danger' : 'bg-warning')}
                  title={transactions[tab.id]!.state === 'failed' ? t('Transaction failed: roll it back') : t('Open transaction: not committed yet')}
                  data-testid="tab-transaction"
                />
              )}
              {dirty && <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full bg-fg-muted', !narrow && 'group-hover:hidden')} title={t('Unsaved changes')} data-testid="tab-unsaved" />}
              <button
                type="button"
                tabIndex={-1}
                aria-label={t('Close tab')}
                title={`${t('Close tab')} (${keys('⌘W')})`}
                className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-active hover:text-fg focus-visible:opacity-100',
                  narrow
                    ? 'absolute top-1/2 right-0.5 -translate-y-1/2 bg-[var(--bg-subtle)] opacity-0 shadow-[-6px_0_6px_var(--bg-subtle)] group-hover:opacity-100 group-focus-visible:opacity-100'
                    : !active && 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
                  dirty && !narrow && 'hidden group-hover:flex',
                )}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => closeTab(tab.id)}
              >
                <X size={12} />
              </button>
            </div>
          )
        })}
      </div>
      {/* Always there, outside the scrolling strip: what ⌘T does (a query, or a connection first when there is none). */}
      <IconButton
        ref={plus}
        label={currentConnection ? `${t('New query')} (${keys('⌘T')})` : `${t('New connection')} (${keys('⌘T')})`}
        className="no-drag mb-1 ml-1"
        data-testid="new-tab"
        onClick={() => runCommand('new-query')}
      >
        <Plus size={15} />
      </IconButton>
      <div className="min-w-2 flex-1 self-stretch" />
      <div ref={ai} className="no-drag mb-1.5 flex items-center gap-0.5 px-1.5">
        <IconButton label={`${t('AI assistant')} (${keys('⌘J')})`} active={aiVisible} onClick={() => setUi({ aiPanelVisible: !aiVisible })}>
          <Sparkles size={14} />
        </IconButton>
      </div>
    </div>
  )
}

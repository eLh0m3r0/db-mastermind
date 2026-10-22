import { PasswordPrompt } from './features/connections/PasswordPrompt'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { CellViewer } from '@/components/grid/CellViewer'
import { ContextMenuHost } from '@/components/ui/ContextMenu'
import { Splitter } from '@/components/ui/Splitter'
import { Toasts } from '@/components/ui/Toasts'
import { bridge } from '@/lib/api'
import { QUERYABLE_FILE, queryFile } from '@/lib/files'
import { onCommand, runCommand } from '@/lib/commands'
import { t } from '@/lib/i18n'
import { installKeymap } from '@/lib/keymap'
import { useConnections } from '@/store/connections'
import { useSettings } from '@/store/settings'
import { askAi, toast, useUi } from '@/store/ui'
import { useWorkspace } from '@/store/workspace'
import { ActivityView } from './features/activity/ActivityView'
import { AiPanel } from './features/ai/AiPanel'
import { CompareView } from './features/compare/CompareView'
import { DataCompareView } from './features/compare/DataCompareView'
import { RolesView } from './features/roles/RolesView'
import { ModelView } from './features/model/ModelView'
import { DashboardView } from './features/dashboard/DashboardView'
import { ConnectionForm } from './features/connections/ConnectionForm'
import { DiagramView } from './features/diagram/DiagramView'
import { KnowledgeView } from './features/knowledge/KnowledgeView'
import { QueryView } from './features/query/QueryView'
import { SettingsModal } from './features/settings/SettingsModal'
import { CommandPalette } from './features/shell/CommandPalette'
import { HomeScreen } from './features/shell/HomeScreen'
import { StatusBar } from './features/shell/StatusBar'
import { TabBar } from './features/shell/TabBar'
import { Sidebar, useCurrentConnectionId } from './features/sidebar/Sidebar'
import { StructureView } from './features/structure/StructureView'
import { TableView } from './features/table/TableView'

function useGlobalCommands() {
  const currentConnection = useCurrentConnectionId()
  useEffect(
    () =>
      onCommand((command) => {
        const ui = useUi.getState()
        const ws = useWorkspace.getState()
        const connId = currentConnection
        switch (command) {
          case 'new-query':
            if (connId) ws.newQuery(connId)
            else ui.set({ modal: { kind: 'connection' } })
            break
          case 'new-connection':
            ui.set({ modal: { kind: 'connection' } })
            break
          case 'close-tab':
            if (ws.activeTabId) ws.close(ws.activeTabId)
            break
          case 'reopen-tab':
            ws.reopen()
            break
          case 'check-updates':
            void window.mastermind.api.checkForUpdatesNow().then((r) => {
              if (r.state === 'up-to-date') toast({ kind: 'success', message: t('DB Mastermind {version} is up to date', { version: r.version }) })
              else if (r.state === 'downloading') toast({ kind: 'info', message: t('Downloading DB Mastermind {version}…', { version: r.version }), detail: t('You will be asked to restart when it is ready.') })
              else if (r.state === 'available')
                toast({ kind: 'info', message: t('DB Mastermind {version} is available', { version: r.version }), action: { label: t('Download'), run: () => void window.mastermind.api.openExternal(r.url) } })
              else if (r.state === 'disabled') toast({ kind: 'info', message: t('Update checks are turned off by your organization') })
              else if (r.state === 'development') toast({ kind: 'info', message: t('Updates are checked in installed builds only') })
              else toast({ kind: 'error', message: t('Could not check for updates (offline?)') })
            })
            break
          case 'split-view':
            // Toggles: split the current tab off to the right, or go back to one pane.
            if (ws.split) ws.unsplit()
            else if (ws.activeTabId) ws.splitRight(ws.activeTabId)
            break
          case 'toggle-sidebar':
            ui.set({ sidebarVisible: !ui.sidebarVisible })
            break
          case 'toggle-ai':
            ui.set({ aiPanelVisible: !ui.aiPanelVisible })
            break
          case 'ask-ai': {
            // In a query tab, Cmd/Ctrl+I writes SQL inline; elsewhere it opens the assistant.
            const ws = useWorkspace.getState()
            if (ws.tabs.find((x) => x.id === ws.activeTabId)?.kind === 'query') runCommand('inline-ai')
            else askAi()
            break
          }
          case 'palette':
            ui.set({ palette: ui.palette ? undefined : 'commands' })
            break
          case 'quick-open':
            ui.set({ palette: ui.palette ? undefined : 'tables' })
            break
          case 'settings':
            ui.set({ modal: { kind: 'settings' } })
            break
          case 'refresh-schema':
            if (connId) void useConnections.getState().loadSchema(connId, true)
            break
          case 'disconnect':
            if (connId) {
              void useConnections.getState().disconnect(connId)
              ui.set({ selectedConnectionId: undefined })
            }
            break
          case 'history':
          case 'saved-queries':
            ui.set({ sidebarVisible: true })
            break
        }
      }),
    [currentConnection],
  )
}

/** Dropping a CSV / Parquet / JSON / Excel file anywhere opens it for SQL (other drops keep their default handling). */
function useFileDrop() {
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')
    const onDragOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      // Never let Electron navigate to the dropped file, nor the editor paste its contents.
      e.preventDefault()
      e.stopPropagation()
      const file = [...(e.dataTransfer?.files ?? [])].find((f) => QUERYABLE_FILE.test(f.name))
      if (file) void queryFile(bridge.pathForFile(file))
      else toast({ kind: 'info', message: t('Drop a CSV, Parquet, JSON or Excel file to query it with SQL') })
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop, true)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop, true)
    }
  }, [])
}

export function App() {
  const tabs = useWorkspace((s) => s.tabs)
  const activeId = useWorkspace((s) => s.activeTabId)
  const split = useWorkspace((s) => s.split)
  const activate = useWorkspace((s) => s.activate)
  const [splitRatio, setSplitRatio] = useState(0.5)
  const panesRef = useRef<HTMLDivElement>(null)
  const { sidebarVisible, sidebarWidth, aiPanelVisible, aiPanelWidth, set } = useUi()
  useGlobalCommands()
  useFileDrop()

  useEffect(() => {
    void useSettings.getState().load()
    void useConnections.getState().load()
    void useWorkspace.getState().restore()
    const off = bridge.on('update:available', (info) =>
      toast({
        kind: 'info',
        message: t('DB Mastermind {version} is available', { version: info.version }),
        action: { label: t('Download'), run: () => void window.mastermind.api.openExternal(info.url) },
      }),
    )
    const offTeam = bridge.on('team:changed', () => void useConnections.getState().load())
    const offReady = bridge.on('update:ready', (info) =>
      toast({
        kind: 'success',
        message: t('DB Mastermind {version} is ready', { version: info.version }),
        detail: t('It installs when you quit, or restart now.'),
        duration: 0,
        action: { label: t('Restart now'), run: () => void window.mastermind.api.installUpdate() },
      }),
    )
    const uninstall = installKeymap()
    return () => {
      offTeam()
      offReady()
      off()
      uninstall()
    }
  }, [])

  // Tabs of disconnected connections reconnect lazily when shown.
  const activeTab = tabs.find((t) => t.id === activeId)
  const runtime = useConnections((s) => (activeTab ? s.runtime[activeTab.connectionId] : undefined))
  useEffect(() => {
    if (activeTab && (!runtime || runtime.status === 'disconnected')) void useConnections.getState().connect(activeTab.connectionId)
  }, [activeTab, runtime])

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        {sidebarVisible && (
          <>
            <div style={{ width: sidebarWidth }} className="shrink-0 border-r border-line">
              <Sidebar />
            </div>
            <Splitter direction="horizontal" size={sidebarWidth} onResize={(w) => set({ sidebarWidth: w })} min={200} max={560} />
          </>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <TabBar />
          <div ref={panesRef} className="relative min-h-0 flex-1">
            {tabs.map((tab) => {
              // In a split both panes are visible; only the focused one gets keyboard shortcuts.
              const side = split?.left === tab.id ? 'left' : split?.right === tab.id ? 'right' : null
              const visible = split ? side !== null : tab.id === activeId
              const focused = tab.id === activeId
              return (
              <div
                key={tab.id}
                className={cn('absolute inset-y-0', split && focused && 'shadow-[inset_0_2px_0_var(--accent)]')}
                style={{
                  display: visible ? 'block' : 'none',
                  left: side === 'right' ? `calc(${splitRatio * 100}% + 3px)` : 0,
                  right: side === 'left' ? `calc(${(1 - splitRatio) * 100}% + 3px)` : 0,
                }}
                onMouseDownCapture={() => split && !focused && activate(tab.id)}
              >
                {tab.kind === 'query' && <QueryView tab={tab} active={focused} />}
                {tab.kind === 'table' && <TableView tab={tab} active={visible} focused={focused} />}
                {tab.kind === 'structure' && <StructureView tab={tab} />}
                {tab.kind === 'diagram' && visible && <DiagramView tab={tab} />}
                {tab.kind === 'knowledge' && <KnowledgeView tab={tab} active={visible} />}
                {tab.kind === 'compare' && <CompareView tab={tab} />}
                {tab.kind === 'activity' && <ActivityView tab={tab} />}
                {tab.kind === 'datacompare' && <DataCompareView tab={tab} />}
                {tab.kind === 'roles' && <RolesView tab={tab} />}
                {tab.kind === 'model' && <ModelView tab={tab} />}
                {tab.kind === 'dashboard' && <DashboardView tab={tab} />}
              </div>
              )
            })}
            {split && (
              <div
                className="absolute inset-y-0 z-10 w-[6px] cursor-col-resize border-x border-line bg-subtle hover:bg-accent-soft"
                style={{ left: `calc(${splitRatio * 100}% - 3px)` }}
                onPointerDown={(e) => {
                  const box = panesRef.current?.getBoundingClientRect()
                  if (!box) return
                  e.currentTarget.setPointerCapture(e.pointerId)
                  const move = (ev: PointerEvent) => setSplitRatio(Math.min(0.85, Math.max(0.15, (ev.clientX - box.left) / box.width)))
                  const up = () => {
                    window.removeEventListener('pointermove', move)
                    window.removeEventListener('pointerup', up)
                  }
                  window.addEventListener('pointermove', move)
                  window.addEventListener('pointerup', up)
                }}
                onDoubleClick={() => setSplitRatio(0.5)}
              />
            )}
            {!activeTab && <HomeScreen />}
          </div>
        </div>
        {aiPanelVisible && (
          <>
            <Splitter direction="horizontal" size={aiPanelWidth} onResize={(w) => set({ aiPanelWidth: w })} min={300} max={760} reverse />
            <div style={{ width: aiPanelWidth }} className="shrink-0">
              <AiPanel />
            </div>
          </>
        )}
      </div>
      <StatusBar />
      <ConnectionForm />
      <SettingsModal />
      <PasswordPrompt />
      <CommandPalette />
      <CellViewer />
      <ContextMenuHost />
      <Toasts />
    </div>
  )
}

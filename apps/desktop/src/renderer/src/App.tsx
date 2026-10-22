import { useEffect } from 'react'
import { CellViewer } from '@/components/grid/CellViewer'
import { ContextMenuHost } from '@/components/ui/ContextMenu'
import { Splitter } from '@/components/ui/Splitter'
import { Toasts } from '@/components/ui/Toasts'
import { bridge } from '@/lib/api'
import { onCommand } from '@/lib/commands'
import { t } from '@/lib/i18n'
import { installKeymap } from '@/lib/keymap'
import { useConnections } from '@/store/connections'
import { useSettings } from '@/store/settings'
import { toast, useUi } from '@/store/ui'
import { useWorkspace } from '@/store/workspace'
import { ActivityView } from './features/activity/ActivityView'
import { AiPanel } from './features/ai/AiPanel'
import { CompareView } from './features/compare/CompareView'
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
          case 'toggle-sidebar':
            ui.set({ sidebarVisible: !ui.sidebarVisible })
            break
          case 'toggle-ai':
            ui.set({ aiPanelVisible: !ui.aiPanelVisible })
            break
          case 'ask-ai':
            ui.set({ aiPanelVisible: true })
            window.dispatchEvent(new CustomEvent('ai:ask', { detail: {} }))
            break
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

export function App() {
  const tabs = useWorkspace((s) => s.tabs)
  const activeId = useWorkspace((s) => s.activeTabId)
  const { sidebarVisible, sidebarWidth, aiPanelVisible, aiPanelWidth, set } = useUi()
  useGlobalCommands()

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
    const uninstall = installKeymap()
    return () => {
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
          <div className="relative min-h-0 flex-1">
            {tabs.map((tab) => (
              <div key={tab.id} className="absolute inset-0" style={{ display: tab.id === activeId ? 'block' : 'none' }}>
                {tab.kind === 'query' && <QueryView tab={tab} active={tab.id === activeId} />}
                {tab.kind === 'table' && <TableView tab={tab} active={tab.id === activeId} />}
                {tab.kind === 'structure' && <StructureView tab={tab} />}
                {tab.kind === 'diagram' && tab.id === activeId && <DiagramView tab={tab} />}
                {tab.kind === 'knowledge' && <KnowledgeView tab={tab} active={tab.id === activeId} />}
                {tab.kind === 'compare' && <CompareView tab={tab} />}
                {tab.kind === 'activity' && <ActivityView tab={tab} />}
              </div>
            ))}
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
      <CommandPalette />
      <CellViewer />
      <ContextMenuHost />
      <Toasts />
    </div>
  )
}

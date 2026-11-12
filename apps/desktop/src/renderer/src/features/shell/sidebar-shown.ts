import { useUi } from '@/store/ui'
import { useWorkspace } from '@/store/workspace'

/**
 * Whether the connections sidebar is shown. Next to a model it is hidden unless asked for (the model has its own
 * objects on its left), and the choice is remembered apart from the one for databases.
 */
const onModel = (s: ReturnType<typeof useWorkspace.getState>) => s.tabs.find((t) => t.id === s.activeTabId)?.kind === 'model'

export function useSidebarShown(): boolean {
  const model = useWorkspace(onModel)
  return useUi((s) => (model ? s.sidebarInModels : s.sidebarVisible))
}

export function setSidebarShown(shown: boolean): void {
  useUi.getState().set(onModel(useWorkspace.getState()) ? { sidebarInModels: shown } : { sidebarVisible: shown })
}

export function toggleSidebar(): void {
  const ui = useUi.getState()
  setSidebarShown(!(onModel(useWorkspace.getState()) ? ui.sidebarInModels : ui.sidebarVisible))
}

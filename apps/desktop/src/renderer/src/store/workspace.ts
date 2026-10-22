import { create } from 'zustand'
import type { DesignTable, FilterNode, SortSpec, TableRef } from '@dbmastermind/core/browser'
import { api } from '@/lib/api'
import { debounce, uid } from '@/lib/utils'
import { t } from '@/lib/i18n'

interface BaseTab {
  id: string
  connectionId: string
  title: string
}

export interface QueryTab extends BaseTab {
  kind: 'query'
  sql: string
  savedQueryId?: string
  /** Text as last saved, to show the unsaved dot. */
  savedSql?: string
}

export interface TableTab extends BaseTab {
  kind: 'table'
  table: TableRef
  filter?: FilterNode
  sort?: SortSpec[]
}

export interface StructureTab extends BaseTab {
  kind: 'structure'
  table: TableRef
}

export interface DiagramTab extends BaseTab {
  kind: 'diagram'
  /** Tables to show ("schema.table" keys); all when undefined. */
  tables?: string[]
  /** Saved diagram this tab edits. */
  savedId?: string
  focus?: string
  /** Node positions the user dragged, by "schema.table". */
  positions?: Record<string, { x: number; y: number }>
  /** Open in design mode with this table selected (from the structure view). */
  startDesign?: string
  /** Schema designer drafts by node key ("schema.table" of the live table, or draft id for new tables). */
  design?: Record<string, DesignTable>
}

export interface KnowledgeTab extends BaseTab {
  kind: 'knowledge'
  file?: string
}

/** Schema compare: `connectionId` is the target that receives the migration. */
export interface CompareTab extends BaseTab {
  kind: 'compare'
  sourceId?: string
  sourceSchema?: string
  targetSchema?: string
}

/** Table data compare: `connectionId` is the target that receives the sync script. */
export interface DataCompareTab extends BaseTab {
  kind: 'datacompare'
  sourceId?: string
  sourceTable?: TableRef
  targetTable?: TableRef
  keyColumns?: string
}

/** Server activity: sessions and running queries. */
export interface ActivityTab extends BaseTab {
  kind: 'activity'
}

export type Tab = QueryTab | TableTab | StructureTab | DiagramTab | KnowledgeTab | CompareTab | ActivityTab | DataCompareTab
export type NewTab =
  | Omit<QueryTab, 'id'>
  | Omit<TableTab, 'id'>
  | Omit<StructureTab, 'id'>
  | Omit<DiagramTab, 'id'>
  | Omit<KnowledgeTab, 'id'>
  | Omit<CompareTab, 'id'>
  | Omit<ActivityTab, 'id'>
  | Omit<DataCompareTab, 'id'>

interface WorkspaceState {
  tabs: Tab[]
  activeTabId?: string
  closed: Tab[]
  restored: boolean
  restore(): Promise<void>
  open(tab: NewTab, options?: { reuse?: boolean }): string
  close(id: string): void
  closeOthers(id: string): void
  closeForConnection(connectionId: string): void
  reopen(): void
  activate(id: string): void
  update(id: string, patch: Partial<Tab>): void
  move(fromId: string, toId: string): void
  newQuery(connectionId: string, sql?: string, title?: string): string
}

const persist = debounce((tabs: Tab[], activeTabId?: string) => {
  void api.saveWorkspace({ tabs, activeTabId })
}, 400)

function sameTarget(a: Tab, b: NewTab): boolean {
  if (a.kind !== b.kind || a.connectionId !== b.connectionId) return false
  if ((a.kind === 'table' || a.kind === 'structure') && (b.kind === 'table' || b.kind === 'structure')) {
    return a.table.name === b.table.name && (a.table.schema ?? '') === (b.table.schema ?? '')
  }
  if (a.kind === 'diagram' && b.kind === 'diagram') return a.focus === b.focus && !a.tables && !b.tables
  if (a.kind === 'knowledge' && b.kind === 'knowledge') return true
  return false
}

export const useWorkspace = create<WorkspaceState>((set, get) => {
  const commit = (tabs: Tab[], activeTabId: string | undefined, extra: Partial<WorkspaceState> = {}) => {
    set({ tabs, activeTabId, ...extra })
    persist(tabs, activeTabId)
  }

  return {
    tabs: [],
    closed: [],
    restored: false,
    async restore() {
      const state = await api.loadWorkspace()
      const tabs = (state?.tabs as Tab[] | undefined) ?? []
      set({ tabs, activeTabId: state?.activeTabId ?? tabs[0]?.id, restored: true })
    },
    open(tab, options = { reuse: true }) {
      const { tabs } = get()
      if (options.reuse !== false) {
        const existing = tabs.find((t) => sameTarget(t, tab))
        if (existing) {
          // Re-opening a table with a new filter (e.g. FK navigation) updates it.
          const patched = tab.kind === 'table' && 'filter' in tab ? { ...existing, filter: tab.filter } : existing
          commit(
            tabs.map((t) => (t.id === existing.id ? (patched as Tab) : t)),
            existing.id,
          )
          return existing.id
        }
      }
      const id = uid('tab')
      const active = get().activeTabId
      const index = tabs.findIndex((t) => t.id === active)
      const next = [...tabs]
      next.splice(index === -1 ? tabs.length : index + 1, 0, { ...tab, id } as Tab)
      commit(next, id)
      return id
    },
    close(id) {
      const { tabs, activeTabId, closed } = get()
      const index = tabs.findIndex((t) => t.id === id)
      if (index === -1) return
      const tab = tabs[index]!
      const next = tabs.filter((t) => t.id !== id)
      let active = activeTabId
      if (activeTabId === id) active = (next[index] ?? next[index - 1])?.id
      if (tab.kind === 'query') void api.releaseSession(tab.connectionId, tab.id).catch(() => {})
      commit(next, active, { closed: [tab, ...closed].slice(0, 20) })
    },
    closeOthers(id) {
      const { tabs } = get()
      for (const t of tabs) if (t.id !== id && t.kind === 'query') void api.releaseSession(t.connectionId, t.id).catch(() => {})
      commit(
        tabs.filter((t) => t.id === id),
        id,
      )
    },
    closeForConnection(connectionId) {
      const { tabs, activeTabId } = get()
      const next = tabs.filter((t) => t.connectionId !== connectionId)
      commit(next, next.some((t) => t.id === activeTabId) ? activeTabId : next[0]?.id)
    },
    reopen() {
      const [tab, ...rest] = get().closed
      if (!tab) return
      commit([...get().tabs, tab], tab.id, { closed: rest })
    },
    activate(id) {
      commit(get().tabs, id)
    },
    update(id, patch) {
      commit(
        get().tabs.map((t) => (t.id === id ? ({ ...t, ...patch } as Tab) : t)),
        get().activeTabId,
      )
    },
    move(fromId, toId) {
      const tabs = [...get().tabs]
      const from = tabs.findIndex((t) => t.id === fromId)
      const to = tabs.findIndex((t) => t.id === toId)
      if (from === -1 || to === -1 || from === to) return
      const [tab] = tabs.splice(from, 1)
      tabs.splice(to, 0, tab!)
      commit(tabs, get().activeTabId)
    },
    newQuery(connectionId, sql = '', title) {
      const count = get().tabs.filter((t) => t.kind === 'query').length
      return get().open({ kind: 'query', connectionId, title: title ?? t('Query {n}', { n: count + 1 }), sql }, { reuse: false })
    },
  }
})

export function useActiveTab(): Tab | undefined {
  return useWorkspace((s) => s.tabs.find((t) => t.id === s.activeTabId))
}

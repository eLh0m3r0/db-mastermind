import { create } from 'zustand'
import type { ConnectionConfig, SchemaSnapshot, ServerInfo } from '@dbmastermind/core/browser'
import type { StoredConnection } from '@shared/api'
import { api } from '@/lib/api'
import { errorMessage } from '@/lib/utils'
import { askPassword, type PasswordAnswer } from '@/features/connections/PasswordPrompt'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

interface ConnectionRuntime {
  status: ConnectionStatus
  error?: string
  serverInfo?: ServerInfo
  schema?: SchemaSnapshot
  schemaLoading?: boolean
  schemaError?: string
}

interface ConnectionsState {
  list: StoredConnection[]
  runtime: Record<string, ConnectionRuntime>
  loaded: boolean
  load(): Promise<void>
  save(config: ConnectionConfig): Promise<StoredConnection>
  remove(id: string): Promise<void>
  togglePin(id: string, table: string): void
  setHiddenSchemas(id: string, schemas: string[]): void
  duplicate(id: string): Promise<StoredConnection>
  connect(id: string): Promise<boolean>
  disconnect(id: string): Promise<void>
  loadSchema(id: string, refresh?: boolean): Promise<SchemaSnapshot | undefined>
  get(id: string | undefined): StoredConnection | undefined
}

export const useConnections = create<ConnectionsState>((set, get) => {
  const patch = (id: string, value: Partial<ConnectionRuntime>) =>
    set((s) => ({
      runtime: { ...s.runtime, [id]: { status: 'disconnected', ...s.runtime[id], ...value } },
    }))

  return {
    list: [],
    runtime: {},
    loaded: false,
    async load() {
      set({ list: await api.listConnections(), loaded: true })
    },
    async save(config) {
      const saved = await api.saveConnection(config)
      await get().load()
      // Saving disconnects so the new settings apply.
      if (get().runtime[saved.id]?.status === 'connected') patch(saved.id, { status: 'disconnected', schema: undefined })
      return saved
    },
    togglePin(id, table) {
      const c = get().list.find((x) => x.id === id)
      if (!c) return
      const pins = c.pinnedTables ?? []
      const next = pins.includes(table) ? pins.filter((p) => p !== table) : [...pins, table]
      set((s) => ({ list: s.list.map((x) => (x.id === id ? { ...x, pinnedTables: next } : x)) }))
      void api.setExplorerPrefs(id, { pinnedTables: next })
    },
    setHiddenSchemas(id, schemas) {
      set((s) => ({ list: s.list.map((x) => (x.id === id ? { ...x, hiddenSchemas: schemas } : x)) }))
      void api.setExplorerPrefs(id, { hiddenSchemas: schemas })
    },
    async remove(id) {
      await api.deleteConnection(id)
      set((s) => {
        const runtime = { ...s.runtime }
        delete runtime[id]
        return { runtime }
      })
      await get().load()
    },
    async duplicate(id) {
      const copy = await api.duplicateConnection(id)
      await get().load()
      return copy
    },
    async connect(id) {
      const current = get().runtime[id]
      if (current?.status === 'connected') return true
      patch(id, { status: 'connecting', error: undefined })
      let password: PasswordAnswer | undefined
      for (;;) {
        try {
          const { serverInfo } = await api.connect(id, password)
          patch(id, { status: 'connected', serverInfo })
          void get().loadSchema(id)
          void get().load()
          return true
        } catch (err) {
          if ((err as { code?: string }).code !== 'PASSWORD_REQUIRED') {
            patch(id, { status: 'error', error: errorMessage(err) })
            return false
          }
          // No saved password (imported connections have none) or a rejected one: ask, as other clients do.
          const c = get().get(id)
          const tried = !!password || !!c?.password
          const answer = await askPassword(c?.name ?? id, c?.user, tried ? errorMessage(err) : undefined)
          if (!answer) {
            patch(id, { status: 'disconnected', error: undefined })
            return false
          }
          password = answer
        }
      }
    },
    async disconnect(id) {
      await api.disconnect(id)
      patch(id, { status: 'disconnected', schema: undefined, serverInfo: undefined })
    },
    async loadSchema(id, refresh = false) {
      const rt = get().runtime[id]
      if (rt?.schema && !refresh) return rt.schema
      patch(id, { schemaLoading: true, schemaError: undefined })
      try {
        const schema = await api.getSchema(id, refresh)
        patch(id, { schema, schemaLoading: false, status: 'connected' })
        return schema
      } catch (err) {
        patch(id, { schemaLoading: false, schemaError: errorMessage(err) })
        return undefined
      }
    },
    get(id) {
      return id ? get().list.find((c) => c.id === id) : undefined
    },
  }
})

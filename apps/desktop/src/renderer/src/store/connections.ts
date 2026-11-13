import { create } from 'zustand'
import { isUnreachableError, needsReconnect, type ConnectionConfig, type SchemaSnapshot, type ServerInfo } from '@dbmastermind/core/browser'
import type { StoredConnection } from '@shared/api'
import { api } from '@/lib/api'
import { errorMessage } from '@/lib/utils'
import { t } from '@/lib/i18n'
import { forgetTransactionsOf } from './transactions'
import { askPassword, type PasswordAnswer } from '@/features/connections/PasswordPrompt'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

interface ConnectionRuntime {
  status: ConnectionStatus
  error?: string
  serverInfo?: ServerInfo
  schema?: SchemaSnapshot
  schemaLoading?: boolean
  schemaError?: string
  /** The server was unreachable (VPN down, offline): the app keeps trying in the background. */
  retrying?: boolean
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
  /** False when the user kept an open transaction (Cancel). */
  disconnect(id: string): Promise<boolean>
  loadSchema(id: string, refresh?: boolean): Promise<SchemaSnapshot | undefined>
  get(id: string | undefined): StoredConnection | undefined
  /** Main opened the connection itself (a query ran after the network came back). */
  opened(id: string, serverInfo: ServerInfo): void
  /** Tries unreachable connections again now (the network came back, the window got focus). */
  retryNow(): void
}

/** Background reconnects back off up to a minute between attempts. */
const RETRY_DELAYS = [5_000, 10_000, 20_000, 30_000, 60_000]

export const useConnections = create<ConnectionsState>((set, get) => {
  const patch = (id: string, value: Partial<ConnectionRuntime>) =>
    set((s) => ({
      runtime: { ...s.runtime, [id]: { status: 'disconnected', ...s.runtime[id], ...value } },
    }))

  const retries = new Map<string, { timer?: ReturnType<typeof setTimeout>; attempt: number; inFlight: boolean }>()
  const stopRetry = (id: string) => {
    const r = retries.get(id)
    if (r?.timer) clearTimeout(r.timer)
    retries.delete(id)
  }
  const scheduleRetry = (id: string) => {
    const r = retries.get(id) ?? { attempt: 0, inFlight: false }
    if (r.timer) clearTimeout(r.timer)
    r.timer = setTimeout(() => void retry(id), RETRY_DELAYS[Math.min(r.attempt, RETRY_DELAYS.length - 1)])
    r.attempt++
    retries.set(id, r)
  }
  /** Quiet attempt: the sidebar keeps the error until it works; never asks for a password. */
  const retry = async (id: string) => {
    const r = retries.get(id)
    const rt = get().runtime[id]
    if (!r || r.inFlight) return
    if (rt?.status === 'connected') return stopRetry(id)
    if (rt?.status !== 'error' || !get().get(id)) return stopRetry(id)
    r.inFlight = true
    try {
      const { serverInfo } = await api.connect(id)
      stopRetry(id)
      get().opened(id, serverInfo)
    } catch (err) {
      r.inFlight = false
      if (retries.get(id) !== r) return
      if (isUnreachableError(err)) {
        patch(id, { error: errorMessage(err) })
        scheduleRetry(id)
      } else {
        stopRetry(id)
        patch(id, { error: errorMessage(err), retrying: false })
      }
    }
  }

  return {
    list: [],
    runtime: {},
    loaded: false,
    async load() {
      set({ list: await api.listConnections(), loaded: true })
    },
    async save(config) {
      const before = get().list.find((c) => c.id === config.id)
      // Host, user, TLS… need a new connection, which ends the open transactions of its query tabs.
      const reconnects = !!before && get().runtime[config.id]?.status === 'connected' && needsReconnect(before, config)
      if (reconnects) {
        const { settleConnectionTransactions } = await import('./workspace')
        if (!(await settleConnectionTransactions(config.id))) throw new Error(t('Not saved: the open transaction is still waiting for Commit or Roll back.'))
      }
      const saved = await api.saveConnection(config)
      await get().load()
      // Saving disconnects so the new settings apply.
      if (reconnects) {
        forgetTransactionsOf(saved.id)
        patch(saved.id, { status: 'disconnected', schema: undefined })
      }
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
      const { settleConnectionTransactions } = await import('./workspace')
      if (!(await settleConnectionTransactions(id))) return
      stopRetry(id)
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
      stopRetry(id)
      patch(id, { status: 'connecting', error: undefined, retrying: false })
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
            // A main-process query may have connected meanwhile (the 'connection:opened' event).
            if (get().runtime[id]?.status === 'connected') return true
            const unreachable = isUnreachableError(err)
            patch(id, { status: 'error', error: errorMessage(err), retrying: unreachable })
            if (unreachable) scheduleRetry(id)
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
      const { settleConnectionTransactions } = await import('./workspace')
      if (!(await settleConnectionTransactions(id))) return false
      stopRetry(id)
      await api.disconnect(id)
      forgetTransactionsOf(id)
      patch(id, { status: 'disconnected', schema: undefined, serverInfo: undefined })
      return true
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
    opened(id, serverInfo) {
      stopRetry(id)
      const rt = get().runtime[id]
      if (rt?.status === 'connected' && rt.schema) return
      patch(id, { status: 'connected', serverInfo, error: undefined, retrying: false })
      // A schema that failed to load while the server was away loads now.
      if (!rt?.schema) void get().loadSchema(id, !!rt?.schemaError)
    },
    retryNow() {
      for (const [id, r] of retries) {
        if (r.inFlight) continue
        if (r.timer) clearTimeout(r.timer)
        r.timer = undefined
        void retry(id)
      }
      // Connected, but the schema failed while the server was away.
      for (const [id, rt] of Object.entries(get().runtime)) {
        if (rt.status === 'connected' && !rt.schema && !rt.schemaLoading && rt.schemaError && isUnreachableError(rt.schemaError)) void get().loadSchema(id, true)
      }
    },
    get(id) {
      return id ? get().list.find((c) => c.id === id) : undefined
    },
  }
})

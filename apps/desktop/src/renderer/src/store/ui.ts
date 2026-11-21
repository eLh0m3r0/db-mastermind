import { create } from 'zustand'
import { useSettings } from './settings'

export type Modal =
  | { kind: 'connection'; connectionId?: string; draft?: Record<string, unknown>; /** An agent's proposal this form reviews: saving removes it. */ proposal?: string }
  | { kind: 'settings'; section?: string }
  | { kind: 'shortcuts' }
  | { kind: 'about' }
  | { kind: 'databases'; connectionId: string }
  | { kind: 'copy'; connectionId: string; tables?: { schema?: string; name: string }[] }
  | { kind: 'runMany'; connectionId: string; sql: string }

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error' | 'warning'
  message: string
  detail?: string
  action?: { label: string; run: () => void }
  /** Milliseconds on screen; 0 keeps it until dismissed (progress of a long task). */
  duration?: number
  /** The user closed it with ✕ (not by its action, not by timing out). */
  onDismiss?: () => void
  /** How many times the same notice came while it was showing (shown as ×n instead of a stack of copies). */
  count?: number
}

interface UiState {
  sidebarVisible: boolean
  /** The connections sidebar next to a model (a model has its own objects on its left: hidden unless asked for). */
  sidebarInModels: boolean
  sidebarWidth: number
  aiPanelVisible: boolean
  aiPanelWidth: number
  /** Connection shown in the sidebar when no tab is focused. */
  selectedConnectionId?: string
  modal?: Modal
  palette?: 'commands' | 'tables'
  /** The sidebar's panel (Query → History / Saved Queries switch it). */
  sidePanel?: 'explorer' | 'history' | 'saved'
  toasts: Toast[]
  /** Pending request for the AI panel; consumed once the panel is mounted. */
  aiRequest?: {
    prompt?: string
    send?: boolean
    /** A task of its own: starts a new chat instead of continuing the open one. */
    newChat?: boolean
    /** Sent to the model with the next message, not shown (instructions such as "reply with a ```dbml block"). */
    context?: string
    /** What the input asks for meanwhile. */
    placeholder?: string
    nonce: number
  }
  set(patch: Partial<Omit<UiState, 'set' | 'toast' | 'dismissToast'>>): void
  toast(toast: Omit<Toast, 'id'>): number
  dismissToast(id: number): void
}

let toastId = 0

function loadLayout(): Partial<UiState> {
  try {
    return JSON.parse(localStorage.getItem('layout') ?? '{}') as Partial<UiState>
  } catch {
    return {}
  }
}

export const useUi = create<UiState>((set, get) => ({
  sidebarVisible: true,
  sidebarInModels: false,
  sidebarWidth: 270,
  aiPanelVisible: false,
  aiPanelWidth: 380,
  toasts: [],
  ...loadLayout(),
  set(patch) {
    set(patch)
    const { sidebarVisible, sidebarInModels, sidebarWidth, aiPanelVisible, aiPanelWidth } = get()
    try {
      localStorage.setItem('layout', JSON.stringify({ sidebarVisible, sidebarInModels, sidebarWidth, aiPanelVisible, aiPanelWidth }))
    } catch {
      // Storage unavailable: layout just isn't remembered.
    }
  },
  toast(toast) {
    // The same notice again while it shows: one toast with a count, its time on screen starting over.
    const same = get().toasts.find((x) => x.kind === toast.kind && x.message === toast.message && x.detail === toast.detail && !x.action === !toast.action)
    const id = same?.id ?? ++toastId
    if (same) set((s) => ({ toasts: s.toasts.map((x) => (x.id === id ? { ...x, count: (x.count ?? 1) + 1 } : x)) }))
    else set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }))
    clearTimeout(toastTimers.get(id))
    if (toast.duration !== 0) toastTimers.set(id, setTimeout(() => get().dismissToast(id), toast.duration ?? (toast.kind === 'error' ? 9000 : 4500)))
    return id
  },
  dismissToast(id) {
    clearTimeout(toastTimers.get(id))
    toastTimers.delete(id)
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
}))

export const toast = (t: Omit<Toast, 'id'>) => useUi.getState().toast(t)
export const dismissToast = (id: number) => useUi.getState().dismissToast(id)

const toastTimers = new Map<number, ReturnType<typeof setTimeout>>()

let aiNonce = 0

/**
 * Opens the AI panel and focuses the input, optionally pre-filled with a prompt or sending it right away. With no AI
 * provider set up yet, every way in (Explain with AI, Design with AI, Fix with AI, ⌘I) opens the setup instead of
 * failing: the panel shows next to it, and the request waits there for the provider.
 */
export function askAi(request: { prompt?: string; send?: boolean; newChat?: boolean; context?: string; placeholder?: string } = {}) {
  const ready = !!useSettings.getState().settings?.ai.activeProvider
  useUi.getState().set({ aiPanelVisible: true, aiRequest: { ...request, send: ready && request.send, nonce: ++aiNonce } })
  if (!ready) useUi.getState().set({ modal: { kind: 'settings', section: 'ai' } })
}

import { create } from 'zustand'

export type Modal =
  | { kind: 'connection'; connectionId?: string; draft?: Record<string, unknown> }
  | { kind: 'settings'; section?: string }
  | { kind: 'shortcuts' }
  | { kind: 'about' }

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error' | 'warning'
  message: string
  detail?: string
  action?: { label: string; run: () => void }
}

interface UiState {
  sidebarVisible: boolean
  sidebarWidth: number
  aiPanelVisible: boolean
  aiPanelWidth: number
  /** Connection shown in the sidebar when no tab is focused. */
  selectedConnectionId?: string
  modal?: Modal
  palette?: 'commands' | 'tables'
  sidePanel?: 'history' | 'saved'
  toasts: Toast[]
  /** Pending request for the AI panel; consumed once the panel is mounted. */
  aiRequest?: { prompt?: string; send?: boolean; nonce: number }
  set(patch: Partial<Omit<UiState, 'set' | 'toast' | 'dismissToast'>>): void
  toast(toast: Omit<Toast, 'id'>): void
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
  sidebarWidth: 270,
  aiPanelVisible: false,
  aiPanelWidth: 380,
  toasts: [],
  ...loadLayout(),
  set(patch) {
    set(patch)
    const { sidebarVisible, sidebarWidth, aiPanelVisible, aiPanelWidth } = get()
    try {
      localStorage.setItem('layout', JSON.stringify({ sidebarVisible, sidebarWidth, aiPanelVisible, aiPanelWidth }))
    } catch {
      // Storage unavailable: layout just isn't remembered.
    }
  },
  toast(toast) {
    const id = ++toastId
    set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }))
    setTimeout(() => get().dismissToast(id), toast.kind === 'error' ? 9000 : 4500)
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
}))

export const toast = (t: Omit<Toast, 'id'>) => useUi.getState().toast(t)

let aiNonce = 0

/** Opens the AI panel and focuses the input, optionally pre-filled with a prompt or sending it right away. */
export function askAi(request: { prompt?: string; send?: boolean } = {}) {
  useUi.getState().set({ aiPanelVisible: true, aiRequest: { ...request, nonce: ++aiNonce } })
}

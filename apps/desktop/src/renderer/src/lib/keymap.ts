import { runCommand } from './commands'
import { useWorkspace } from '@/store/workspace'

/**
 * App shortcuts live here, not in native menu accelerators: one implementation for every platform,
 * and they work inside inputs and in tests. The menu only displays them (registerAccelerator: false).
 */
const KEYMAP: Record<string, string> = {
  'Mod+t': 'new-query',
  'Mod+Shift+n': 'new-connection',
  'Mod+w': 'close-tab',
  'Mod+Shift+t': 'reopen-tab',
  'Mod+s': 'save-query',
  'Mod+k': 'palette',
  'Mod+p': 'quick-open',
  'Mod+b': 'toggle-sidebar',
  'Mod+j': 'toggle-ai',
  F5: 'refresh-schema',
  'Mod+Enter': 'run-current',
  'Mod+Shift+Enter': 'run-all',
  'Mod+.': 'cancel-query',
  'Mod+Shift+f': 'format-sql',
  'Mod+i': 'ask-ai',
  'Mod+y': 'history',
  'Mod+,': 'settings',
  'Mod+\\': 'split-view',
}

function signature(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.metaKey || e.ctrlKey) parts.push('Mod')
  if (e.shiftKey) parts.push('Shift')
  if (e.altKey) parts.push('Alt')
  parts.push(e.key.length === 1 ? e.key.toLowerCase() : e.key)
  return parts.join('+')
}

export function installKeymap(): () => void {
  const onKey = (e: KeyboardEvent) => {
    // Editors and grids handle their own keys first and mark them handled.
    if (e.defaultPrevented) return
    const sig = signature(e)
    // Czech and other layouts type ě, š, č… on the digit row: match the physical key.
    const digit = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey ? /^Digit([1-9])$/.exec(e.code)?.[1] : /^Mod\+([1-9])$/.exec(sig)?.[1]
    if (digit) {
      const ws = useWorkspace.getState()
      const index = digit === '9' ? ws.tabs.length - 1 : Number(digit) - 1
      const tab = ws.tabs[index]
      if (tab) {
        e.preventDefault()
        ws.activate(tab.id)
      }
      return
    }
    if (e.ctrlKey && e.key === 'Tab') {
      const ws = useWorkspace.getState()
      const i = ws.tabs.findIndex((t) => t.id === ws.activeTabId)
      const next = ws.tabs[(i + (e.shiftKey ? -1 : 1) + ws.tabs.length) % ws.tabs.length]
      if (next) {
        e.preventDefault()
        ws.activate(next.id)
      }
      return
    }
    const command = KEYMAP[sig]
    if (!command) return
    e.preventDefault()
    runCommand(command)
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}

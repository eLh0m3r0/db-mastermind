import { dialog, type BrowserWindow } from 'electron'
import type { DatabaseService, TransactionState } from '@dbmastermind/core'
import * as connections from './connections'
import { getSettings } from './settings'

/** Sessions of query tabs per connection: what may hold an open transaction when the app quits. */
const editorSessions = new Map<string, Set<string>>()

export function trackEditorSession(connectionId: string, session: string): void {
  let set = editorSessions.get(connectionId)
  if (!set) editorSessions.set(connectionId, (set = new Set()))
  set.add(session)
}

export function forgetEditorSession(connectionId: string, session: string): void {
  editorSessions.get(connectionId)?.delete(session)
}

export function forgetEditorSessionsOf(connectionId: string): void {
  editorSessions.delete(connectionId)
}

export function hasEditorSessions(): boolean {
  return [...editorSessions.values()].some((s) => s.size > 0)
}

interface OpenTransaction {
  connectionId: string
  session: string
  state: TransactionState
}

/**
 * Open transactions of the tracked sessions, asked in parallel. A session that doesn't answer in time (busy with a
 * long statement) counts as open on a manual-commit connection: better asked once too often than rolled back unasked.
 */
export async function openTransactions(db: DatabaseService): Promise<OpenTransaction[]> {
  const checks: Promise<OpenTransaction | undefined>[] = []
  for (const [connectionId, sessions] of editorSessions) {
    if (!db.isOpen(connectionId)) continue
    const manual = !!db.config(connectionId).manualCommit
    for (const session of sessions) {
      checks.push(
        Promise.race([db.transactionState(connectionId, session).catch(() => undefined), new Promise<'unknown'>((r) => setTimeout(() => r('unknown'), 2000))]).then((state) =>
          state === 'open' || state === 'failed' ? { connectionId, session, state } : state === 'unknown' && manual ? { connectionId, session, state: 'open' as const } : undefined,
        ),
      )
    }
  }
  return (await Promise.all(checks)).filter((x): x is OpenTransaction => !!x)
}

const CS: Record<string, string> = {
  Commit: 'Potvrdit',
  'Roll Back': 'Vrátit zpět',
  Cancel: 'Zrušit',
  'Quit with uncommitted changes?': 'Ukončit s nepotvrzenými změnami?',
  'Query tabs have open transactions: {list}. Quitting would roll them back.':
    'Záložky dotazů mají otevřené transakce: {list}. Ukončení by je vrátilo zpět.',
  'A failed transaction can only be rolled back.': 'Transakci, která selhala, lze jen vrátit zpět.',
  'Could not commit': 'Potvrzení se nepodařilo',
  'The app stays open so nothing is lost.': 'Aplikace zůstane otevřená, aby se nic neztratilo.',
}
const m = (text: string) => (getSettings().language === 'cs' ? (CS[text] ?? text) : text)

/**
 * Before quitting: open transactions in query tabs are committed or rolled back as the user says, never lost
 * silently. Resolves false when the user stays (Cancel, or a commit failed).
 */
export async function settleTransactionsBeforeQuit(db: DatabaseService, window: BrowserWindow | null): Promise<boolean> {
  const open = await openTransactions(db)
  if (!open.length) return true
  const counts = new Map<string, number>()
  for (const tx of open) counts.set(tx.connectionId, (counts.get(tx.connectionId) ?? 0) + 1)
  const name = (id: string) => {
    try {
      return connections.getConnection(id).name
    } catch {
      return id
    }
  }
  const list = [...counts].map(([id, n]) => (n > 1 ? `${name(id)} (${n}×)` : name(id))).join(', ')
  const options = {
    type: 'warning' as const,
    buttons: [m('Commit'), m('Roll Back'), m('Cancel')],
    defaultId: 2,
    cancelId: 2,
    message: m('Quit with uncommitted changes?'),
    detail: m('Query tabs have open transactions: {list}. Quitting would roll them back.').replace('{list}', list) + (open.some((tx) => tx.state === 'failed') ? `\n${m('A failed transaction can only be rolled back.')}` : ''),
  }
  const { response } = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
  if (response === 2) return false
  for (const tx of open) {
    const action = response === 0 && tx.state === 'open' ? 'commit' : 'rollback'
    try {
      await db.endTransaction(tx.connectionId, tx.session, action)
    } catch (err) {
      if (action === 'rollback') continue
      dialog.showErrorBox(m('Could not commit'), `${name(tx.connectionId)}: ${(err as Error).message}\n\n${m('The app stays open so nothing is lost.')}`)
      return false
    }
  }
  return true
}

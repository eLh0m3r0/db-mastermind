import { create } from 'zustand'
import { classifyStatement, type StatementOutcome, type TransactionState } from '@dbmastermind/core/browser'
import { askChoice, confirmAction } from '@/components/ui/ConfirmDialog'
import { api } from '@/lib/api'
import { t, tp } from '@/lib/i18n'
import { errorMessage } from '@/lib/utils'
import { toast } from './ui'

/** A statement that ran inside the open transaction: what Commit makes permanent and Roll back undoes. */
export interface TransactionStep {
  sql: string
  /** Rows the statement changed, when the database says. */
  rows?: number
  /** A schema change (the explorer reloads after Commit / Roll back). */
  ddl?: boolean
  failed?: boolean
}

export interface TabTransaction {
  connectionId: string
  state: Exclude<TransactionState, 'none'>
  steps: TransactionStep[]
  /** When the app first saw it open (ms): an old one holds its locks the whole time. */
  since: number
  /** Commit / Roll back running. */
  ending?: boolean
}

/** Open transactions of query tabs, by tab id (the tab's session). Tabs without one have no entry. */
export const useTransactions = create<Record<string, TabTransaction>>(() => ({}))

const set = (tabId: string, tx: TabTransaction | undefined) =>
  useTransactions.setState((s) => {
    const next = { ...s }
    if (tx) next[tabId] = tx
    else delete next[tabId]
    return next
  }, true)

function stepsOf(outcomes: StatementOutcome[]): TransactionStep[] {
  return outcomes
    .filter((o) => o.sql.trim() && !['read', 'transaction'].includes(classifyStatement(o.sql)) && !/^\s*(SET|USE|SHOW|PRINT)\b/i.test(o.sql))
    .map((o) => {
      const rows = o.results?.reduce<number | undefined>((n, r) => (r.affectedRows === undefined ? n : (n ?? 0) + r.affectedRows), undefined)
      const ddl = classifyStatement(o.sql) === 'ddl'
      // DDL reports 0 rows: "schema" says more.
      return { sql: o.sql.trim(), rows: ddl ? undefined : rows, ddl: ddl || undefined, failed: !!o.error || undefined }
    })
}

/**
 * Asks the database for the tab's transaction after a run (or when the tab opens). `ran` are the statements that
 * just ran; they join the list when a transaction is open after them.
 */
export async function refreshTransaction(tabId: string, connectionId: string, ran: StatementOutcome[] = []): Promise<void> {
  const state = await api.transactionState(connectionId, tabId).catch(() => null)
  const current = useTransactions.getState()[tabId]
  if (!state || state === 'none') {
    if (current) set(tabId, undefined)
    return
  }
  // Statements that ran without errors before a BEGIN in the same run committed on their own: only what follows
  // the last BEGIN belongs to the transaction when it just started.
  let fresh = ran
  if (!current) {
    const lastBegin = ran.map((o) => /^\s*(BEGIN|START\s+TRANSACTION|SET\s+TRANSACTION)\b/i.test(o.sql)).lastIndexOf(true)
    fresh = lastBegin >= 0 ? ran.slice(lastBegin + 1) : ran
  }
  set(tabId, { connectionId, state, steps: [...(current?.steps ?? []), ...stepsOf(fresh)], since: current?.since ?? Date.now() })
}

/** Commit or Roll back from the tab; resolves true when the transaction ended. */
export async function endTransaction(tabId: string, action: 'commit' | 'rollback'): Promise<boolean> {
  const tx = useTransactions.getState()[tabId]
  if (!tx || tx.ending) return false
  set(tabId, { ...tx, ending: true })
  try {
    const state = await api.endTransaction(tx.connectionId, tabId, action)
    if (state === 'none') set(tabId, undefined)
    else set(tabId, { ...tx, state, ending: false })
    const changed = tx.steps.filter((s) => !s.failed).length
    toast({
      kind: 'success',
      message:
        action === 'commit'
          ? tp(changed, { one: 'Committed: {n} change saved', many: 'Committed: {n} changes saved' })
          : tp(changed, { one: 'Rolled back: {n} change undone', many: 'Rolled back: {n} changes undone' }),
    })
    if (tx.steps.some((s) => s.ddl)) {
      const { useConnections } = await import('./connections')
      void useConnections.getState().loadSchema(tx.connectionId, true)
    }
    return state === 'none'
  } catch (err) {
    set(tabId, { ...tx, ending: false })
    void refreshTransaction(tabId, tx.connectionId)
    toast({ kind: 'error', message: action === 'commit' ? t('Could not commit') : t('Could not roll back'), detail: errorMessage(err) })
    return false
  }
}

/** The connection went away (disconnect, reconnect with new settings): its transactions went with it. */
export function forgetTransactionsOf(connectionId: string): void {
  useTransactions.setState((s) => Object.fromEntries(Object.entries(s).filter(([, tx]) => tx.connectionId !== connectionId)), true)
}

/**
 * Before something would end open transactions (closing tabs, disconnecting, quitting): Commit, Roll back or stay.
 * `titles` names the tabs. Resolves true when it's fine to go on.
 */
export async function settleTransactions(tabIds: string[], titles: (tabId: string) => string): Promise<boolean> {
  const open = tabIds.filter((id) => useTransactions.getState()[id])
  if (!open.length) return true
  const txs = open.map((id) => useTransactions.getState()[id]!)
  const allFailed = txs.every((tx) => tx.state === 'failed')
  const changes = txs.reduce((n, tx) => n + tx.steps.filter((s) => !s.failed).length, 0)
  const title = open.length === 1 ? t('“{tab}” has an open transaction', { tab: titles(open[0]!) }) : t('{n} tabs have open transactions', { n: open.length })
  const items = open.length > 1 ? open.map((id) => titles(id)) : txs[0]!.steps.slice(-8).map((s) => s.sql.replace(/\s+/g, ' ').slice(0, 160))
  const choice = allFailed
    ? (await confirmAction({ title, message: t('The transaction failed and can only be rolled back.'), items, confirmLabel: t('Roll back') })) && 'secondary'
    : await askChoice({
        title,
        message: tp(changes, {
          one: '{n} change is not committed yet. Commit it, or roll it back?',
          many: '{n} changes are not committed yet. Commit them, or roll them back?',
        }),
        items,
        confirmLabel: t('Commit'),
        secondaryLabel: t('Roll back'),
      })
  if (!choice) return false
  for (const id of open) {
    const tx = useTransactions.getState()[id]
    if (!tx) continue
    const action = choice === 'confirm' && tx.state === 'open' ? 'commit' : 'rollback'
    if (!(await endTransaction(id, action))) return false
  }
  return true
}

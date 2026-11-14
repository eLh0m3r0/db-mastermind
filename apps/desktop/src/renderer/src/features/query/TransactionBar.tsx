import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, GitCommitHorizontal, Undo2 } from 'lucide-react'
import type { DriverId } from '@dbmastermind/core/browser'
import { Button } from '@/components/ui/Button'
import { tp, useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { keys } from '@/lib/api'
import { endTransaction, useTransactions } from '@/store/transactions'

/** After this long an open transaction is shown as probably forgotten. */
const STALE_MINUTES = 10

/** Databases that commit an open transaction on their own before a schema change. */
const DDL_COMMITS: DriverId[] = ['mysql', 'mariadb', 'oracle']

/**
 * The query tab's open transaction: what ran in it, Commit and Roll back. With manual commit and nothing open,
 * a quiet label says changes will wait.
 */
export function TransactionBar({ tabId, driver, manual, busy = false }: { tabId: string; driver: DriverId; manual: boolean; busy?: boolean }) {
  const t = useT()
  const tx = useTransactions((s) => s[tabId])
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!tx) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [tx])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  useEffect(() => {
    if (!tx) setOpen(false)
  }, [tx])

  if (!tx) {
    if (!manual) return null
    return (
      <span className="text-[11.5px] text-fg-faint" title={t('Changes made here wait for Commit or Roll back (set in the connection).')} data-testid="manual-commit">
        {t('Manual commit')}
      </span>
    )
  }

  const failed = tx.state === 'failed'
  const changes = tx.steps.filter((s) => !s.failed).length
  const minutes = Math.floor((now - tx.since) / 60_000)
  // Open this long, it has most likely been forgotten while it keeps others waiting on its locks.
  const stale = !failed && minutes >= STALE_MINUTES
  return (
    <div ref={box} className="relative flex items-center gap-1" data-testid="transaction-bar" data-state={tx.state}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={
          failed
            ? t('An error aborted the transaction: roll it back to go on.')
            : stale
              ? t('Open for {n} min: until Commit or Roll back it holds its locks, and other sessions changing the same rows wait.', { n: minutes })
              : t('What runs in this transaction waits for Commit or Roll back.')
        }
        className={cn(
          'flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12px] font-medium whitespace-nowrap',
          failed ? 'border-danger/40 bg-danger-soft text-danger' : stale ? 'border-warning bg-warning text-white' : 'border-warning/40 bg-warning-soft text-warning',
        )}
      >
        {failed ? <AlertTriangle size={13} /> : <GitCommitHorizontal size={14} className={cn(changes > 0 && '@max-[700px]:hidden')} />}
        <span className="@max-[700px]:hidden">
        {failed
          ? t('Transaction failed')
          : changes
            ? t('Transaction · {changes}', { changes: tp(changes, { one: '{n} change', many: '{n} changes' }) })
            : t('Transaction open')}
        </span>
        {/* Narrow toolbar: the count says enough next to the icon. */}
        {!failed && changes > 0 && <span className="hidden tabular-nums @max-[700px]:inline">{tp(changes, { one: '{n} change', many: '{n} changes' })}</span>}
        {!failed && minutes >= 1 && <span className="tabular-nums @max-[900px]:hidden">· {minutes < 60 ? t('{n} min', { n: minutes }) : t('{n} h', { n: Math.floor(minutes / 60) })}</span>}
        <ChevronDown size={12} className="opacity-70" />
      </button>
      {!failed && (
        <Button
          size="sm"
          variant="success"
          icon={<Check size={13} strokeWidth={2.5} />}
          loading={tx.ending}
          // While a statement runs, Commit would commit it too: wait for it.
          disabled={busy}
          onClick={() => void endTransaction(tabId, 'commit')}
          data-testid="tx-commit"
          title={`${t('Save the changes of this transaction')} (${keys('⌥⇧⌘↵')})`}
        >
          <span className="@max-[560px]:hidden">{t('Commit')}</span>
        </Button>
      )}
      <Button
        size="sm"
        variant={failed ? 'danger' : 'secondary'}
        icon={<Undo2 size={13} />}
        loading={failed && tx.ending}
        disabled={tx.ending || busy}
        onClick={() => void endTransaction(tabId, 'rollback')}
        data-testid="tx-rollback"
        title={`${t('Undo the changes of this transaction')} (${keys('⌥⇧⌘⌫')})`}
      >
        <span className="@max-[560px]:hidden">{t('Roll back')}</span>
      </Button>
      {open && (
        <div className="absolute top-full right-0 z-30 mt-1 w-[420px] max-w-[80vw] rounded-lg border border-line bg-elevated p-2 shadow-lg">
          <div className="px-1 pb-1.5 text-[11.5px] font-medium text-fg-muted">
            {failed ? t('An error aborted the transaction. Roll it back, then run the statements again.') : t('Not committed yet')}
          </div>
          {tx.steps.length === 0 ? (
            <div className="px-1 py-1 text-[12px] text-fg-faint">{t('Nothing has changed in it yet.')}</div>
          ) : (
            <ol className="max-h-64 overflow-auto font-mono text-[11.5px]">
              {tx.steps.map((s, i) => (
                <li key={i} className="flex items-baseline gap-2 rounded px-1 py-0.5 hover:bg-hover">
                  <span className="w-4 shrink-0 text-right text-fg-faint">{i + 1}</span>
                  <span className={cn('min-w-0 flex-1 truncate', s.failed && 'text-danger line-through')} title={s.sql}>
                    {s.sql.replace(/\s+/g, ' ')}
                  </span>
                  <span className="shrink-0 font-sans text-[11px] text-fg-faint">
                    {s.failed ? t('failed') : s.rows !== undefined ? tp(s.rows, { one: '{n} row', many: '{n} rows' }) : s.ddl ? t('schema') : ''}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {DDL_COMMITS.includes(driver) && !failed && (
            <div className="mt-1.5 border-t border-line px-1 pt-1.5 text-[11px] text-fg-faint">
              {t('CREATE, ALTER and DROP commit the open transaction here (the database does it on its own).')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

import { create } from 'zustand'
import { AlertTriangle } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { Button } from './Button'
import { Modal } from './Modal'

export interface ConfirmOptions {
  title: string
  /** Optional detail under the title: what exactly happens. */
  message?: string
  /** Statements or items the action touches, shown as a monospace list. */
  items?: string[]
  /** The button that does it, named after the action ("Delete", "Run", "Discard"), never "OK". */
  confirmLabel: string
  /** Destructive: red button and a warning icon. */
  danger?: boolean
  /** An extra warning line (e.g. a production connection). */
  warning?: string
}

interface Ask extends ConfirmOptions {
  resolve: (ok: boolean) => void
}

const useConfirm = create<{ ask?: Ask }>(() => ({}))

/** Asks before an action, in the app's own dialog (window.confirm only offers OK/Cancel). */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => useConfirm.setState({ ask: { ...options, resolve } }))
}

export function ConfirmDialog() {
  const t = useT()
  const ask = useConfirm((s) => s.ask)
  const finish = (ok: boolean) => {
    ask?.resolve(ok)
    useConfirm.setState({ ask: undefined })
  }
  return (
    <Modal
      open={!!ask}
      onClose={() => finish(false)}
      title={ask?.title}
      width={480}
      footer={
        <>
          <div className="flex-1" />
          {/* Destructive actions start on Cancel, so a stray Enter doesn't delete anything. */}
          <Button variant="ghost" onClick={() => finish(false)} data-autofocus={ask?.danger ? true : undefined}>
            {t('Cancel')}
          </Button>
          <Button variant={ask?.danger ? 'danger' : 'primary'} onClick={() => finish(true)} data-autofocus={ask?.danger ? undefined : true}>
            {ask?.confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5 text-[12.5px]">
        {ask?.warning && (
          <div className="flex items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-medium text-danger">
            <AlertTriangle size={14} className="shrink-0" />
            {ask.warning}
          </div>
        )}
        {ask?.message && <p className="text-fg-muted">{ask.message}</p>}
        {!!ask?.items?.length && (
          <pre className="max-h-48 overflow-auto rounded-md bg-subtle p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap select-text">
            {ask.items.join('\n')}
          </pre>
        )}
      </div>
    </Modal>
  )
}

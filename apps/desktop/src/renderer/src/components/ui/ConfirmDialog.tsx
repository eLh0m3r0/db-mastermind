import { useState } from 'react'
import { create } from 'zustand'
import { AlertTriangle } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { Button } from './Button'
import { Input, Textarea } from './Input'
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

export interface AskTextOptions {
  title: string
  message?: string
  /** Starting value, selected so typing replaces it. */
  value?: string
  placeholder?: string
  /** Several lines; Enter confirms and Shift+Enter starts a new line, as in the AI panel. */
  multiline?: boolean
  confirmLabel: string
}

interface Ask extends ConfirmOptions {
  resolve: (ok: boolean) => void
  text?: { value: string; placeholder?: string; multiline?: boolean; resolve: (value: string | null) => void }
}

const useConfirm = create<{ ask?: Ask }>(() => ({}))

/** Asks before an action, in the app's own dialog (window.confirm only offers OK/Cancel). */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => useConfirm.setState({ ask: { ...options, resolve } }))
}

/** Asks for a line of text (a name, a request). Electron has no window.prompt. Resolves with null when cancelled. */
export function askText(options: AskTextOptions): Promise<string | null> {
  const { value = '', placeholder, multiline, ...rest } = options
  return new Promise((resolve) =>
    useConfirm.setState({ ask: { ...rest, resolve: () => {}, text: { value, placeholder, multiline, resolve } } }),
  )
}

export function ConfirmDialog() {
  const t = useT()
  const ask = useConfirm((s) => s.ask)
  const [value, setValue] = useState('')
  // Set during render, not in an effect: the Modal focuses (and the field selects) the starting value on open.
  const [shown, setShown] = useState<Ask>()
  if (ask !== shown) {
    setShown(ask)
    if (ask?.text) setValue(ask.text.value)
  }
  const empty = !!ask?.text && !value.trim()
  const finish = (ok: boolean) => {
    if (ask?.text) {
      if (ok && empty) return
      ask.text.resolve(ok ? value.trim() : null)
    } else ask?.resolve(ok)
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
          <Button variant={ask?.danger ? 'danger' : 'primary'} onClick={() => finish(true)} disabled={empty} data-autofocus={ask?.danger || ask?.text ? undefined : true}>
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
        {ask?.text &&
          (ask.text.multiline ? (
            <Textarea
              rows={3}
              value={value}
              placeholder={ask.text.placeholder}
              onChange={(e) => setValue(e.target.value)}
              // The Modal focuses the field; the starting value is selected so typing replaces it.
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  finish(true)
                }
              }}
            />
          ) : (
            <Input
              value={value}
              placeholder={ask.text.placeholder}
              onChange={(e) => setValue(e.target.value)}
              // The Modal focuses the field; the starting value is selected so typing replaces it.
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  finish(true)
                }
              }}
            />
          ))}
        {ask?.text?.multiline && <p className="text-[11px] text-fg-faint">{t('Enter to send · Shift+Enter for a new line')}</p>}
        {!!ask?.items?.length && (
          <pre className="max-h-48 overflow-auto rounded-md bg-subtle p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap select-text">
            {ask.items.join('\n')}
          </pre>
        )}
      </div>
    </Modal>
  )
}

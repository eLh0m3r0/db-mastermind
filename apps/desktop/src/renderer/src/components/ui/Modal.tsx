import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { IconButton } from './Button'
import { t } from '@/lib/i18n'

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 560,
  className,
  bodyClassName,
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: number
  className?: string
  bodyClassName?: string
}) {
  const panel = useRef<HTMLDivElement>(null)
  // Callers pass a new onClose on every render; the effect below must run only when the modal opens, or each
  // keystroke in a field would move the focus back to the first one.
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => {
      // With dialogs stacked (a confirmation over a form), only the one on top reacts.
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal]')
      if (dialogs[dialogs.length - 1] !== panel.current) return
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeRef.current()
      }
      // Tab stays inside the dialog (it used to walk on into the sidebar behind it).
      if (e.key === 'Tab' && panel.current) {
        const items = [...panel.current.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
          (el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null,
        )
        if (!items.length) return
        const first = items[0]!
        const last = items[items.length - 1]!
        const inside = panel.current.contains(document.activeElement)
        if (!inside || (e.shiftKey && document.activeElement === first)) {
          e.preventDefault()
          ;(e.shiftKey ? last : first).focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    // Focus the first field for keyboard users.
    requestAnimationFrame(() => {
      const first = panel.current?.querySelector<HTMLElement>('input, textarea, select, button[data-autofocus]')
      first?.focus()
    })
    return () => {
      window.removeEventListener('keydown', onKey, true)
      previous?.focus?.()
    }
  }, [open])

  if (!open) return null
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 pt-[8vh] backdrop-blur-[1px] dark:bg-black/50"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal
        style={{ width }}
        className={cn('flex max-h-[84vh] max-w-full flex-col rounded-xl border border-line bg-elevated shadow-pop', className)}
      >
        {title && (
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-line pr-2 pl-4">
            <h2 className="text-[14px] font-semibold">{title}</h2>
            <IconButton label={t('Close')} onClick={onClose}>
              <X size={15} />
            </IconButton>
          </div>
        )}
        <div className={cn('min-h-0 flex-1 overflow-auto p-4', bodyClassName)}>{children}</div>
        {footer && <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

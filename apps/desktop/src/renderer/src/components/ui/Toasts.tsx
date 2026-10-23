import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { useUi } from '@/store/ui'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'

export function Toasts() {
  const toasts = useUi((s) => s.toasts)
  const dismiss = useUi((s) => s.dismissToast)
  const tr = useT()
  return (
    <div className="pointer-events-none fixed right-4 bottom-16 z-[70] flex w-[360px] flex-col gap-2">
      {toasts.map((t) => {
        const Icon = { info: Info, success: CheckCircle2, error: XCircle, warning: AlertTriangle }[t.kind]
        return (
          <div
            key={t.id}
            className="pointer-events-auto flex gap-2.5 rounded-lg border border-line bg-elevated p-3 shadow-pop"
            role="status"
          >
            <Icon
              size={16}
              className={cn(
                'mt-px shrink-0',
                t.kind === 'error' && 'text-danger',
                t.kind === 'success' && 'text-success',
                t.kind === 'warning' && 'text-warning',
                t.kind === 'info' && 'text-info',
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium break-words">{t.message}</div>
              {t.detail && <div className="mt-0.5 line-clamp-4 text-[12px] break-words text-fg-muted">{t.detail}</div>}
              {t.action && (
                <button
                  type="button"
                  className="mt-1.5 text-[12px] font-medium text-accent hover:underline"
                  onClick={() => {
                    t.action!.run()
                    dismiss(t.id)
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
            <button type="button" className="h-5 shrink-0 text-fg-faint hover:text-fg" onClick={() => dismiss(t.id)} aria-label={tr('Dismiss')}>
              <X size={14} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

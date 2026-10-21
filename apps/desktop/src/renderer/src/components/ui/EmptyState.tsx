import type { ReactNode } from 'react'

export function EmptyState({ icon, title, children, actions }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      {icon && <div className="mb-1 text-fg-faint">{icon}</div>}
      <div className="text-[14px] font-medium">{title}</div>
      {children && <div className="max-w-sm text-[12.5px] text-fg-muted">{children}</div>}
      {actions && <div className="mt-3 flex gap-2">{actions}</div>}
    </div>
  )
}

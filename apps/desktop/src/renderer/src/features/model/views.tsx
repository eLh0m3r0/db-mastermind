import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { DezignSqlObject } from '@dbmastermind/core/browser'

/** A view of a DeZign project with its code as the project keeps it. */
export type ModelView = DezignSqlObject & { id: string; code: string }

export const editableViews = (objects: DezignSqlObject[] | undefined): ModelView[] => (objects ?? []).filter((o): o is ModelView => o.kind === 'view' && !!o.id && o.code !== undefined)

/**
 * The project's views: their SQL is edited as DeZign keeps it (`%viewname%` stands for the view's own name) and
 * goes into the project and the DDL script. The model does not read the SQL: what it says is up to its author.
 */
export function ViewsModal({ open, views, onClose, onApply }: { open: boolean; views: ModelView[]; onClose: () => void; onApply: (codes: Record<string, string>) => void }) {
  const t = useT()
  const [codes, setCodes] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState('')
  const [shown, setShown] = useState(false)
  // Set during render when the dialog opens, so it starts from the views as they are now.
  if (open !== shown) {
    setShown(open)
    if (open) {
      setCodes(Object.fromEntries(views.map((v) => [v.id, v.code])))
      setSelected(views[0]?.id ?? '')
    }
  }
  const view = views.find((v) => v.id === selected)
  const name = (v: ModelView) => (v.schema ? `${v.schema}.${v.name}` : v.name)
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('Views')}
      width={760}
      footer={
        <>
          <div className="flex-1" />
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={views.some((v) => !codes[v.id]?.trim())} onClick={() => onApply(codes)} data-testid="views-apply">
            {t('Apply')}
          </Button>
        </>
      }
    >
      <p className="mb-2 text-[12px] text-fg-muted">{t('The SQL of the project’s views, as DeZign keeps it: %viewname% stands for the view’s name. It goes into the project and into the DDL script.')}</p>
      <div className="flex h-[50vh] gap-2">
        <div className="flex w-48 shrink-0 flex-col gap-0.5 overflow-auto">
          {views.map((v) => (
            <button key={v.id} type="button" className={cn('truncate rounded px-2 py-1 text-left font-mono text-[12px] hover:bg-subtle', v.id === selected && 'bg-subtle font-medium')} onClick={() => setSelected(v.id)} data-testid="views-item">
              {name(v)}
              {codes[v.id] !== v.code ? ' •' : ''}
            </button>
          ))}
        </div>
        {view && (
          <Textarea
            className="h-full min-w-0 flex-1 resize-none font-mono text-[12px]"
            spellCheck={false}
            value={codes[view.id] ?? ''}
            onChange={(e) => setCodes({ ...codes, [view.id]: e.target.value })}
            aria-label={name(view)}
            data-testid="views-code"
          />
        )}
      </div>
    </Modal>
  )
}

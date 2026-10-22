import { useMemo, useState } from 'react'
import { ChevronRight, Code2, X } from 'lucide-react'
import type { ExplainResult, PlanNode } from '@dbmastermind/core/browser'
import { IconButton } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Input'
import { useT } from '@/lib/i18n'
import { cn, formatCount } from '@/lib/utils'

interface Row {
  node: PlanNode
  depth: number
  path: string
  /** Cost of this node minus its children: where the work actually happens. */
  selfCost?: number
}

function flatten(node: PlanNode, depth = 0, path = '0'): Row[] {
  const childCost = node.children.reduce((sum, c) => sum + (c.cost ?? 0), 0)
  const selfCost = node.cost !== undefined ? Math.max(0, node.cost - childCost) : undefined
  return [{ node, depth, path, selfCost }, ...node.children.flatMap((c, i) => flatten(c, depth + 1, `${path}.${i}`))]
}

const SCAN = /seq scan|table scan|full|clustered index scan|^scan\b|all access/i

/** Execution plan as an indented operator tree, with the most expensive steps highlighted. */
export function PlanView({ plan, onClose }: { plan: ExplainResult; onClose: () => void }) {
  const t = useT()
  const [view, setView] = useState<'tree' | 'raw'>('tree')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const rows = useMemo(() => flatten(plan.root), [plan])
  const maxSelf = Math.max(1e-9, ...rows.map((r) => r.selfCost ?? 0))
  const total = plan.root.cost
  const visible = rows.filter((r) => ![...collapsed].some((c) => r.path.startsWith(`${c}.`)))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-subtle px-2 text-[12px]">
        <span className="font-semibold">{t('Execution plan')}</span>
        {total !== undefined && <span className="text-fg-faint">{t('total cost {cost}', { cost: formatCount(Math.round(total)) })}</span>}
        <div className="flex-1" />
        <Segmented
          size="xs"
          value={view}
          onChange={setView}
          options={[
            { value: 'tree', label: t('Tree') },
            { value: 'raw', label: plan.format.toUpperCase() },
          ]}
        />
        <IconButton label={t('Close')} onClick={onClose}>
          <X size={13} />
        </IconButton>
      </div>
      {view === 'raw' ? (
        <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[11.5px] whitespace-pre-wrap select-text">{plan.raw}</pre>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto py-1 text-[12px]">
          {visible.map(({ node, depth, path, selfCost }) => {
            const heavy = selfCost !== undefined && selfCost / maxSelf > 0.5 && rows.length > 2
            const scan = SCAN.test(node.operation)
            const hasChildren = node.children.length > 0
            return (
              <div key={path} className={cn('group flex items-center gap-2 px-2 py-1 hover:bg-hover', heavy && 'bg-warning-soft')}>
                <div style={{ width: depth * 16 }} className="shrink-0" />
                <button
                  type="button"
                  className={cn('flex h-4 w-4 shrink-0 items-center justify-center text-fg-faint', !hasChildren && 'invisible')}
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev)
                      if (next.has(path)) next.delete(path)
                      else next.add(path)
                      return next
                    })
                  }
                >
                  <ChevronRight size={12} className={cn('transition-transform', !collapsed.has(path) && 'rotate-90')} />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className={cn('font-medium', scan && 'text-warning')}>{node.operation}</span>
                    {node.object && <span className="truncate font-mono text-[11.5px] text-accent">{node.object}</span>}
                  </div>
                  {node.detail && <div className="truncate font-mono text-[11px] text-fg-faint" title={node.detail}>{node.detail}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-3 text-[11.5px] tabular-nums text-fg-muted">
                  {node.rows !== undefined && <span title={t('Estimated rows')}>{formatCount(Math.round(node.rows))} {t('rows')}</span>}
                  {node.actualMs !== undefined && <span title={t('Actual time')}>{node.actualMs.toFixed(1)} ms</span>}
                  {selfCost !== undefined && (
                    <span className="flex w-28 items-center gap-1.5" title={t('Share of the work done by this step')}>
                      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                        <span className={cn('block h-full rounded-full', heavy ? 'bg-warning' : 'bg-accent')} style={{ width: `${Math.max(2, (selfCost / maxSelf) * 100)}%` }} />
                      </span>
                      <span className="w-12 text-right">{formatCount(Math.round(selfCost))}</span>
                    </span>
                  )}
                </div>
              </div>
            )
          })}
          <div className="flex items-center gap-1.5 px-3 pt-2 text-[11px] text-fg-faint">
            <Code2 size={11} />
            {t('Highlighted steps do most of the work. Full scans of large tables are usually the first thing to index.')}
          </div>
        </div>
      )}
    </div>
  )
}

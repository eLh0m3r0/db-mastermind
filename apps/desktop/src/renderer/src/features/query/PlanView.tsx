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

/** Change from `before` to `now` in percent, signed ("−42 %"); empty when either is unknown. */
export function change(before: number | undefined, now: number | undefined): string {
  if (before === undefined || now === undefined || before === 0) return ''
  const pct = ((now - before) / before) * 100
  if (Math.abs(pct) < 0.5) return '±0 %'
  return `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)} %`
}

/**
 * Execution plan as an indented operator tree, with the most expensive steps highlighted; next to the tab's previous
 * plan on request (before / after an index).
 */
export function PlanView({ plan, previous, onClose }: { plan: ExplainResult; previous?: ExplainResult | null; onClose: () => void }) {
  const t = useT()
  const [view, setView] = useState<'tree' | 'raw'>('tree')
  const [comparing, setComparing] = useState(false)
  const total = plan.root.cost
  const time = plan.root.actualMs
  const compare = comparing && !!previous
  const before = previous?.root.cost

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-subtle px-2 text-[12px]">
        <span className="font-semibold">{t('Execution plan')}</span>
        {total !== undefined && <span className="text-fg-faint">{t('total cost {cost}', { cost: formatCount(Math.round(total)) })}</span>}
        {compare && previous && (
          <span className="text-fg-muted" data-testid="plan-change">
            {before !== undefined && t('before {cost}', { cost: formatCount(Math.round(before)) })}
            {change(before, total) && <b className={cn('ml-1.5', (total ?? 0) <= (before ?? 0) ? 'text-success' : 'text-warning')}>{change(before, total)}</b>}
            {time !== undefined && previous.root.actualMs !== undefined && (
              <span className="ml-2">
                {previous.root.actualMs.toFixed(1)} → {time.toFixed(1)} ms{' '}
                <b className={time <= previous.root.actualMs ? 'text-success' : 'text-warning'}>{change(previous.root.actualMs, time)}</b>
              </span>
            )}
          </span>
        )}
        <div className="flex-1" />
        {previous && view === 'tree' && (
          <button type="button" className="text-[12px] text-accent hover:underline" onClick={() => setComparing((c) => !c)} data-testid="plan-compare">
            {compare ? t('Hide previous plan') : t('Compare with previous')}
          </button>
        )}
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
      ) : compare && previous ? (
        <div className="grid min-h-0 flex-1 grid-cols-2">
          <div className="flex min-h-0 flex-col border-r border-line">
            <div className="shrink-0 border-b border-line px-3 py-1 text-[11.5px] font-semibold text-fg-muted">{t('Previous')}</div>
            <PlanTree plan={previous} />
          </div>
          <div className="flex min-h-0 flex-col">
            <div className="shrink-0 border-b border-line px-3 py-1 text-[11.5px] font-semibold text-fg-muted">{t('Now')}</div>
            <PlanTree plan={plan} />
          </div>
        </div>
      ) : (
        <PlanTree plan={plan} hint />
      )}
    </div>
  )
}

function PlanTree({ plan, hint }: { plan: ExplainResult; hint?: boolean }) {
  const t = useT()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const rows = useMemo(() => flatten(plan.root), [plan])
  const maxSelf = Math.max(1e-9, ...rows.map((r) => r.selfCost ?? 0))
  const visible = rows.filter((r) => ![...collapsed].some((c) => r.path.startsWith(`${c}.`)))
  return (
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
              {node.detail && (
                <div className="truncate font-mono text-[11px] text-fg-faint" title={node.detail}>
                  {node.detail}
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-3 text-[11.5px] tabular-nums text-fg-muted">
              {node.rows !== undefined && (
                <span title={t('Estimated rows')}>
                  {formatCount(Math.round(node.rows))} {t('rows')}
                </span>
              )}
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
      {hint && (
        <div className="flex items-center gap-1.5 px-3 pt-2 text-[11px] text-fg-faint">
          <Code2 size={11} />
          {t('Highlighted steps do most of the work. Full scans of large tables are usually the first thing to index.')}
        </div>
      )}
    </div>
  )
}

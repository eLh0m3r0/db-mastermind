import { useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Lightbulb } from 'lucide-react'
import type { ModelIssue, ModelIssueKind } from '@dbmastermind/core/browser'
import { tp, useT } from '@/lib/i18n'

const LABELS: Record<ModelIssueKind, string> = {
  no_primary_key: 'Table without a primary key',
  no_columns: 'Table without columns',
  fk_target_missing: 'Foreign key to a table or column that is not in the model',
  fk_target_not_unique: 'Foreign key to columns that are not unique',
  fk_type_mismatch: 'Foreign key with a different type than its target',
  duplicate_index: 'Index that repeats another',
  redundant_index: 'Index covered by a longer one',
  fk_without_index: 'Foreign key without an index',
  missing_relationship: 'Possible relationship (same name and type as a key)',
  naming: 'Name in a different style than the rest of the model',
}
const FIX: Partial<Record<ModelIssueKind, string>> = {
  duplicate_index: 'Remove',
  redundant_index: 'Remove',
  fk_without_index: 'Add index',
  missing_relationship: 'Add',
}
const SHOWN = 25

/** The counter in the model's toolbar: quiet for suggestions, a warning color when something is probably wrong. */
export function IssuesChip({ issues, open, onToggle }: { issues: ModelIssue[]; open: boolean; onToggle: () => void }) {
  const t = useT()
  const warnings = issues.filter((i) => i.severity === 'warning').length
  if (!issues.length) return null
  return (
    <button
      type="button"
      data-testid="model-issues"
      onClick={onToggle}
      title={t('Checks that run by themselves: keys, foreign keys, indexes, names, undeclared relationships')}
      className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] hover:bg-hover ${warnings ? 'text-warning' : 'text-fg-muted'} ${open ? 'bg-hover' : ''}`}
    >
      {warnings ? <AlertTriangle size={12} /> : <Lightbulb size={12} />}
      {warnings ? tp(warnings, { one: '{n} problem', many: '{n} problems' }) : tp(issues.length, { one: '{n} suggestion', many: '{n} suggestions' })}
    </button>
  )
}

/** Issues grouped by kind under the editor: click one to go to its table, fix one or all of a kind where that is safe. */
export function IssuesPanel({ issues, onJump, onFix }: { issues: ModelIssue[]; onJump: (issue: ModelIssue) => void; onFix: (issues: ModelIssue[]) => void }) {
  const t = useT()
  const [openKind, setOpenKind] = useState<ModelIssueKind | null>(null)
  const kinds = [...new Set(issues.map((i) => i.kind))].sort((a, b) => Number(issues.find((i) => i.kind === b)!.severity === 'warning') - Number(issues.find((i) => i.kind === a)!.severity === 'warning'))
  return (
    <div className="max-h-56 shrink-0 overflow-auto border-t border-line text-[12px]" data-testid="model-issues-panel">
      {kinds.map((kind) => {
        const list = issues.filter((i) => i.kind === kind)
        const warning = list[0]!.severity === 'warning'
        // A single kind is shown open: there is nothing else to choose from.
        const expanded = openKind === kind || kinds.length === 1
        return (
          <div key={kind} className="border-b border-line last:border-b-0">
            <div className="flex items-center gap-1.5 px-2 py-1">
              <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => setOpenKind(expanded ? null : kind)}>
                {expanded ? <ChevronDown size={12} className="shrink-0 text-fg-faint" /> : <ChevronRight size={12} className="shrink-0 text-fg-faint" />}
                {warning ? <AlertTriangle size={12} className="shrink-0 text-warning" /> : <Lightbulb size={12} className="shrink-0 text-fg-faint" />}
                <span className="truncate">{t(LABELS[kind])}</span>
                <span className="text-fg-faint">{list.length}</span>
              </button>
              {FIX[kind] && list.length > 1 && (
                <button type="button" className="shrink-0 rounded px-1.5 text-accent hover:bg-hover" onClick={() => onFix(list)}>
                  {t('{action} all', { action: t(FIX[kind]!) })}
                </button>
              )}
            </div>
            {expanded && (
              <div className="pb-1">
                {list.slice(0, SHOWN).map((issue, i) => (
                  <div key={i} className="flex items-center gap-1.5 py-0.5 pl-8 pr-2 hover:bg-hover">
                    <button type="button" className="min-w-0 flex-1 truncate text-left font-mono text-[11.5px]" onClick={() => onJump(issue)} title={issue.detail}>
                      {issue.table}
                      {issue.column ? `.${issue.column}` : ''}
                      {issue.detail && <span className="text-fg-faint"> → {issue.detail}</span>}
                    </button>
                    {FIX[kind] && issue.fixable && (
                      <button type="button" className="shrink-0 rounded px-1.5 text-accent hover:bg-hover" onClick={() => onFix([issue])}>
                        {t(FIX[kind]!)}
                      </button>
                    )}
                  </div>
                ))}
                {list.length > SHOWN && <div className="py-0.5 pl-8 text-fg-faint">{t('… and {n} more', { n: String(list.length - SHOWN) })}</div>}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

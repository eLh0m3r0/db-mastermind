import { useMemo } from 'react'
import { Braces, FolderPlus, Plus, Trash2, X } from 'lucide-react'
import {
  columnFamily,
  newFilterId,
  OPERATORS,
  type ColumnInfo,
  type FilterCondition,
  type FilterGroup,
  type FilterNode,
  type FilterOperator,
} from '@dbmastermind/core/browser'
import { Button, IconButton } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { cn } from '@/lib/utils'

export function newCondition(column: string, operator: FilterOperator = 'eq', value = ''): FilterCondition {
  return { kind: 'condition', id: newFilterId(), column, operator, value }
}

function updateNode(root: FilterGroup, id: string, fn: (node: FilterNode) => FilterNode | null): FilterGroup {
  const walk = (node: FilterNode): FilterNode | null => {
    if (node.id === id) return fn(node)
    if (node.kind !== 'group') return node
    return { ...node, children: node.children.map(walk).filter((n): n is FilterNode => n !== null) }
  }
  return (walk(root) as FilterGroup | null) ?? { ...root, children: [] }
}

interface Props {
  value: FilterGroup
  columns: ColumnInfo[]
  supportsRegex: boolean
  onChange: (value: FilterGroup) => void
  onApply: () => void
  onClear: () => void
}

export function FilterBuilder({ value, columns, supportsRegex, onChange, onApply, onClear }: Props) {
  const ctx = { columns, supportsRegex, onApply, root: value, onChange }
  return (
    <div className="flex flex-col gap-1.5 border-b border-line bg-subtle px-3 py-2">
      <GroupView group={value} depth={0} ctx={ctx} />
      <div className="flex items-center gap-2 pt-0.5">
        <Button size="xs" variant="primary" onClick={onApply}>
          Apply
        </Button>
        <Button size="xs" variant="ghost" onClick={onClear}>
          Clear all
        </Button>
        <span className="ml-auto text-[11px] text-fg-faint">Enter applies · shift-click a column header to sort by several columns</span>
      </div>
    </div>
  )
}

interface Ctx {
  columns: ColumnInfo[]
  supportsRegex: boolean
  onApply: () => void
  root: FilterGroup
  onChange: (value: FilterGroup) => void
}

function GroupView({ group, depth, ctx }: { group: FilterGroup; depth: number; ctx: Ctx }) {
  const set = (fn: (node: FilterNode) => FilterNode | null, id = group.id) => ctx.onChange(updateNode(ctx.root, id, fn))
  const firstColumn = ctx.columns[0]?.name ?? ''
  const add = (node: FilterNode) => set((g) => ({ ...(g as FilterGroup), children: [...(g as FilterGroup).children, node] }))

  return (
    <div className={cn('flex flex-col gap-1.5', depth > 0 && 'rounded-md border border-dashed border-line-strong bg-bg/50 p-2')}>
      {group.children.length === 0 && depth === 0 && (
        <div className="text-[12px] text-fg-faint">No conditions. Add one below.</div>
      )}
      {group.children.map((child, i) => (
        <div key={child.id} className="flex items-start gap-1.5">
          <div className="flex h-7 w-[52px] shrink-0 items-center justify-end">
            {i === 0 ? (
              <span className="pr-1 text-[11.5px] text-fg-faint">{depth === 0 ? 'where' : ''}</span>
            ) : i === 1 ? (
              <button
                type="button"
                className="h-6 rounded px-1.5 text-[11px] font-semibold text-accent uppercase hover:bg-accent-soft"
                title="Switch between AND / OR"
                onClick={() => set((g) => ({ ...(g as FilterGroup), combinator: (g as FilterGroup).combinator === 'and' ? 'or' : 'and' }))}
              >
                {group.combinator}
              </button>
            ) : (
              <span className="pr-1.5 text-[11px] font-semibold text-fg-faint uppercase">{group.combinator}</span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            {child.kind === 'group' ? (
              <div className="flex items-start gap-1">
                <div className="min-w-0 flex-1">
                  <GroupView group={child} depth={depth + 1} ctx={ctx} />
                </div>
                <IconButton label="Remove group" onClick={() => set(() => null, child.id)}>
                  <X size={13} />
                </IconButton>
              </div>
            ) : child.kind === 'raw' ? (
              <div className="flex items-center gap-1.5">
                <EnabledToggle node={child} onToggle={(enabled) => set((n) => ({ ...n, enabled }), child.id)} />
                <Input
                  inputSize="sm"
                  className="flex-1 font-mono text-[12px]"
                  placeholder="raw SQL condition, e.g. total > discount * 2"
                  value={child.sql}
                  onChange={(e) => set((n) => ({ ...n, sql: e.target.value }) as FilterNode, child.id)}
                  onKeyDown={(e) => e.key === 'Enter' && ctx.onApply()}
                />
                <IconButton label="Remove condition" onClick={() => set(() => null, child.id)}>
                  <Trash2 size={13} />
                </IconButton>
              </div>
            ) : (
              <ConditionRow
                condition={child}
                ctx={ctx}
                onChange={(next) => set(() => next, child.id)}
                onRemove={() => set(() => null, child.id)}
              />
            )}
          </div>
        </div>
      ))}
      <div className="flex gap-1 pl-[58px]">
        <Button size="xs" variant="ghost" icon={<Plus size={12} />} onClick={() => add(newCondition(firstColumn))}>
          Condition
        </Button>
        <Button
          size="xs"
          variant="ghost"
          icon={<FolderPlus size={12} />}
          onClick={() => add({ kind: 'group', id: newFilterId(), combinator: group.combinator === 'and' ? 'or' : 'and', children: [newCondition(firstColumn)] })}
        >
          Group
        </Button>
        <Button size="xs" variant="ghost" icon={<Braces size={12} />} onClick={() => add({ kind: 'raw', id: newFilterId(), sql: '' })}>
          Raw SQL
        </Button>
      </div>
    </div>
  )
}

function EnabledToggle({ node, onToggle }: { node: FilterNode; onToggle: (enabled: boolean) => void }) {
  return (
    <input
      type="checkbox"
      title="Enable / disable this condition"
      className="h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
      checked={node.enabled !== false}
      onChange={(e) => onToggle(e.target.checked)}
    />
  )
}

function ConditionRow({
  condition,
  ctx,
  onChange,
  onRemove,
}: {
  condition: FilterCondition
  ctx: Ctx
  onChange: (c: FilterCondition) => void
  onRemove: () => void
}) {
  const column = ctx.columns.find((c) => c.name === condition.column)
  const family = column ? columnFamily(column.dataType) : 'other'
  const operators = useMemo(
    () => OPERATORS.filter((o) => o.families.includes(family) && (ctx.supportsRegex || !o.id.includes('regex'))),
    [family, ctx.supportsRegex],
  )
  const meta = OPERATORS.find((o) => o.id === condition.operator)
  const inputType = family === 'date' && /^date$/i.test(column?.dataType ?? '') ? 'date' : 'text'
  const onKey = (e: React.KeyboardEvent) => e.key === 'Enter' && ctx.onApply()

  return (
    <div className={cn('flex items-center gap-1.5', condition.enabled === false && 'opacity-50')}>
      <EnabledToggle node={condition} onToggle={(enabled) => onChange({ ...condition, enabled })} />
      <Select
        inputSize="sm"
        className="w-[180px] shrink-0"
        value={condition.column}
        onChange={(e) => {
          const nextCol = ctx.columns.find((c) => c.name === e.target.value)
          const nextFamily = nextCol ? columnFamily(nextCol.dataType) : 'other'
          const keep = OPERATORS.find((o) => o.id === condition.operator)?.families.includes(nextFamily)
          onChange({ ...condition, column: e.target.value, operator: keep ? condition.operator : 'eq' })
        }}
      >
        {ctx.columns.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
      </Select>
      <Select
        inputSize="sm"
        className="w-[150px] shrink-0"
        value={condition.operator}
        onChange={(e) => onChange({ ...condition, operator: e.target.value as FilterOperator })}
      >
        {operators.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </Select>
      {meta?.arity === 1 && (
        <Input
          inputSize="sm"
          className="min-w-[120px] flex-1 font-mono text-[12px]"
          type={condition.operator === 'last_n_days' ? 'number' : inputType}
          placeholder={condition.operator === 'last_n_days' ? 'days' : 'value'}
          value={condition.value ?? ''}
          onChange={(e) => onChange({ ...condition, value: e.target.value })}
          onKeyDown={onKey}
        />
      )}
      {meta?.arity === 2 && (
        <>
          <Input
            inputSize="sm"
            className="min-w-[90px] flex-1 font-mono text-[12px]"
            type={inputType}
            placeholder="from"
            value={condition.value ?? ''}
            onChange={(e) => onChange({ ...condition, value: e.target.value })}
            onKeyDown={onKey}
          />
          <span className="text-[11.5px] text-fg-faint">and</span>
          <Input
            inputSize="sm"
            className="min-w-[90px] flex-1 font-mono text-[12px]"
            type={inputType}
            placeholder="to"
            value={condition.value2 ?? ''}
            onChange={(e) => onChange({ ...condition, value2: e.target.value })}
            onKeyDown={onKey}
          />
        </>
      )}
      {meta?.arity === 'list' && (
        <Input
          inputSize="sm"
          className="min-w-[120px] flex-1 font-mono text-[12px]"
          placeholder="comma or newline separated values"
          value={(condition.values ?? []).join(',')}
          onChange={(e) =>
            onChange({
              ...condition,
              values: e.target.value.split(/,|\n/),
            })
          }
          onKeyDown={onKey}
        />
      )}
      {meta?.arity === 0 && <div className="flex-1" />}
      <IconButton label="Remove condition" onClick={onRemove}>
        <Trash2 size={13} />
      </IconButton>
    </div>
  )
}

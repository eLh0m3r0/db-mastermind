import { useState } from 'react'
import { ArrowRight, Plus, X } from 'lucide-react'
import type { DesignTable, TableInfo } from '@dbmastermind/core/browser'
import { Button, IconButton } from '@/components/ui/Button'
import { Checkbox, Input, Select } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

const ACTIONS = ['NO ACTION', 'CASCADE', 'SET NULL', 'RESTRICT', 'SET DEFAULT']
type Cardinality = '' | 'one-or-more' | 'zero-or-one' | 'exactly-one'
const CARDINALITIES: [Cardinality, string][] = [
  ['', 'zero or more'],
  ['one-or-more', 'one or more'],
  ['zero-or-one', 'zero or one'],
  ['exactly-one', 'exactly one'],
]

/** The child's end of a relationship line, as the diagram draws it. */
function ChildEnd({ cardinality, x, y }: { cardinality: Cardinality; x: number; y: number }) {
  const stroke = 'var(--text-muted)'
  const many = cardinality === '' || cardinality === 'one-or-more'
  return (
    <g fill="none" stroke={stroke} strokeWidth="1.3">
      {many ? <path d={`M${x - 12} ${y} L${x} ${y - 7} M${x - 12} ${y} L${x} ${y + 7} M${x - 12} ${y} L${x} ${y}`} /> : <path d={`M${x - 6} ${y - 7} L${x - 6} ${y + 7}`} />}
      {cardinality === '' || cardinality === 'zero-or-one' ? <circle cx={x - 19} cy={y} r="3.5" fill="var(--bg)" /> : <path d={`M${x - 18} ${y - 7} L${x - 18} ${y + 7}`} />}
    </g>
  )
}

/**
 * A relationship of a model edited as in DeZign's relationship dialog: its name, the table it points at and the
 * columns, its cardinality, whether it identifies the child (its key is part of the child's key) and whether a
 * parent is mandatory (the key's columns NOT NULL), and what happens on delete and update. Nothing changes until OK.
 */
export function RelationshipDialog({
  child: given,
  foreignKey,
  allTables,
  onApply,
  onClose,
}: {
  child: DesignTable
  /** The foreign key's id in the child's draft. */
  foreignKey: string
  allTables: TableInfo[]
  onApply: (child: DesignTable) => void
  onClose: () => void
}) {
  const tr = useT()
  const [child, setChild] = useState(given)
  const fk = child.foreignKeys.find((f) => f.id === foreignKey)
  if (!fk) return null
  const tables = allTables.filter((t) => t.type === 'table' || t.type === 'foreign_table')
  const key = (t: { schema?: string | null; name: string }) => `${t.schema ?? ''}.${t.name}`
  const parent = tables.find((t) => t.name === fk.refTable && (t.schema ?? '') === (fk.refSchema ?? child.schema ?? '')) ?? tables.find((t) => t.name === fk.refTable)
  const update = (patch: Partial<typeof fk>) => setChild((c) => ({ ...c, foreignKeys: c.foreignKeys.map((f) => (f.id === fk.id ? { ...f, ...patch } : f)) }))
  const identifying = fk.columns.length > 0 && fk.columns.every((c) => child.primaryKey.includes(c))
  const mandatory = fk.columns.length > 0 && fk.columns.every((c) => child.columns.find((x) => x.name === c)?.nullable === false)
  const setIdentifying = (on: boolean) =>
    setChild((c) => ({
      ...c,
      primaryKey: on ? [...c.primaryKey, ...fk.columns.filter((x) => !c.primaryKey.includes(x))] : c.primaryKey.filter((x) => !fk.columns.includes(x)),
      // A key's columns are never empty.
      columns: on ? c.columns.map((x) => (fk.columns.includes(x.name) ? { ...x, nullable: false } : x)) : c.columns,
    }))
  const setMandatory = (on: boolean) => setChild((c) => ({ ...c, columns: c.columns.map((x) => (fk.columns.includes(x.name) ? { ...x, nullable: !on } : x)) }))
  const cardinality = (fk.cardinality ?? '') as Cardinality

  return (
    <Modal
      open
      onClose={onClose}
      title={tr('Relationship {from} → {to}', { from: child.name, to: fk.refTable })}
      width={640}
      footer={
        <>
          <div className="flex-1" />
          <Button onClick={onClose}>{tr('Cancel')}</Button>
          <Button variant="primary" disabled={!fk.refTable || fk.columns.some((c) => !c) || fk.refColumns.some((c) => !c)} onClick={() => onApply(child)} data-testid="relationship-dialog-ok">
            OK
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[12.5px]">
        <div className="flex items-end gap-2">
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-[11.5px] font-medium text-fg-muted">{tr('Name')}</span>
            <Input inputSize="sm" className="font-mono" placeholder={tr('Name (optional)')} value={fk.name ?? ''} onChange={(e) => update({ name: e.target.value || undefined })} data-testid="relationship-name" />
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-[11.5px] font-medium text-fg-muted">{tr('Parent table')}</span>
            <Select
              inputSize="sm"
              value={parent ? key(parent) : `${fk.refSchema ?? ''}.${fk.refTable}`}
              onChange={(e) => {
                const t = tables.find((x) => key(x) === e.target.value)
                if (!t) return
                const keys = t.primaryKey.length ? t.primaryKey : [t.columns[0]?.name ?? '']
                update({ refTable: t.name, refSchema: t.schema, refColumns: keys, columns: keys.map((k, i) => fk.columns[i] ?? child.columns.find((c) => c.name === k)?.name ?? '') })
              }}
            >
              {tables.map((t) => (
                <option key={key(t)} value={key(t)}>
                  {t.schema ? `${t.schema}.${t.name}` : t.name}
                </option>
              ))}
            </Select>
          </label>
        </div>

        <div className="rounded-md border border-line p-2">
          <div className="mb-1 flex items-center justify-between text-[11px] font-semibold tracking-wide text-fg-faint uppercase">
            <span>{tr('Columns')}</span>
            <Button size="xs" variant="ghost" icon={<Plus size={11} />} onClick={() => update({ columns: [...fk.columns, ''], refColumns: [...fk.refColumns, parent?.columns.find((c) => !fk.refColumns.includes(c.name))?.name ?? ''] })}>
              {tr('Add')}
            </Button>
          </div>
          {fk.columns.map((column, i) => (
            <div key={i} className="mb-1 flex items-center gap-1.5">
              <Select inputSize="sm" className="min-w-0 flex-1" value={column} onChange={(e) => update({ columns: fk.columns.map((c, k) => (k === i ? e.target.value : c)) })}>
                {!column && <option value="">—</option>}
                {child.columns.map((c) => (
                  <option key={c.id}>{c.name}</option>
                ))}
              </Select>
              <span className="text-fg-faint">{child.name}</span>
              <ArrowRight size={12} className="shrink-0 text-fg-faint" />
              <span className="text-fg-faint">{fk.refTable}</span>
              <Select inputSize="sm" className="min-w-0 flex-1" value={fk.refColumns[i] ?? ''} onChange={(e) => update({ refColumns: fk.columns.map((_, k) => (k === i ? e.target.value : (fk.refColumns[k] ?? ''))) })}>
                {!fk.refColumns[i] && <option value="">—</option>}
                {(parent?.columns ?? []).map((c) => (
                  <option key={c.name}>{c.name}</option>
                ))}
              </Select>
              {fk.columns.length > 1 && (
                <IconButton label={tr('Remove this pair of columns')} onClick={() => update({ columns: fk.columns.filter((_, k) => k !== i), refColumns: fk.refColumns.filter((_, k) => k !== i) })}>
                  <X size={12} />
                </IconButton>
              )}
            </div>
          ))}
        </div>

        <div className="rounded-md border border-line p-2">
          <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-fg-faint uppercase">{tr('Cardinality')}</div>
          <div className="grid grid-cols-4 gap-1.5" role="radiogroup" data-testid="relationship-cardinality">
            {CARDINALITIES.map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={cardinality === value}
                onClick={() => update({ cardinality: (value || undefined) as typeof fk.cardinality })}
                className={cn('flex flex-col items-center gap-1 rounded-md border px-1 py-1.5 text-[11.5px]', cardinality === value ? 'border-accent bg-accent-soft' : 'border-line hover:bg-subtle')}
                data-testid={`cardinality-${value || 'zero-or-more'}`}
              >
                <svg width="64" height="18" viewBox="0 0 64 18" aria-hidden>
                  <path d="M2 9 L60 9" stroke="var(--text-muted)" strokeWidth="1.3" />
                  <ChildEnd cardinality={value} x={62} y={9} />
                </svg>
                {tr(label)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-start gap-6">
          <div className="flex flex-col gap-1.5">
            <Checkbox checked={identifying} onChange={setIdentifying} label={<span title={tr("The parent's key is part of this table's primary key (drawn solid)")}>{tr('Identifying')}</span>} />
            <Checkbox checked={mandatory} onChange={setMandatory} label={<span title={tr('Every row needs a parent: the key columns are NOT NULL')}>{tr('Mandatory parent')}</span>} />
            <Checkbox
              checked={!!fk.subtype}
              onChange={(on) => {
                // A subtype shares its supertype's key: the relationship is identifying and mandatory.
                if (on) {
                  setIdentifying(true)
                  setMandatory(true)
                }
                update({ subtype: on || undefined })
              }}
              label={<span title={tr('This table is a kind of the parent table (DeZign: a subtype in the supertype’s cluster)')}>{tr('Subtype')}</span>}
            />
          </div>
          <div className="grid flex-1 grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5">
            <span className="text-fg-muted">{tr('on delete')}</span>
            <Select inputSize="sm" value={fk.onDelete ?? 'NO ACTION'} onChange={(e) => update({ onDelete: e.target.value })} data-testid="relationship-on-delete">
              {ACTIONS.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </Select>
            <span className="text-fg-muted">{tr('on update')}</span>
            <Select inputSize="sm" value={fk.onUpdate ?? 'NO ACTION'} onChange={(e) => update({ onUpdate: e.target.value })}>
              {ACTIONS.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </Select>
          </div>
        </div>

        {/* As the diagram will draw it: the parent, the line (solid when identifying) and the child's end. */}
        <svg viewBox="0 0 560 70" className="h-[70px] w-full rounded-md bg-subtle" aria-hidden>
          <rect x="20" y="15" width="150" height="40" rx="6" fill="var(--bg)" stroke="var(--border-strong)" />
          <text x="95" y="40" textAnchor="middle" fontSize="13" fontWeight="600" fill="var(--text)">
            {fk.refTable}
          </text>
          <rect x="390" y="15" width="150" height="40" rx="6" fill="var(--bg)" stroke="var(--border-strong)" />
          <text x="465" y="40" textAnchor="middle" fontSize="13" fontWeight="600" fill="var(--text)">
            {child.name}
          </text>
          <path d="M170 35 L390 35" stroke="var(--text-muted)" strokeWidth="1.3" strokeDasharray={identifying ? undefined : '6 4'} />
          <path d={mandatory ? 'M180 28 L180 42 M186 28 L186 42' : 'M186 28 L186 42'} stroke="var(--text-muted)" strokeWidth="1.3" />
          {!mandatory && <circle cx="179" cy="35" r="3.5" fill="var(--bg)" stroke="var(--text-muted)" strokeWidth="1.3" />}
          <ChildEnd cardinality={cardinality} x={390} y={35} />
        </svg>
      </div>
    </Modal>
  )
}

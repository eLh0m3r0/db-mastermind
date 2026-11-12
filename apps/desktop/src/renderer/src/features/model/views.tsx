import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { withDezignSql, type DezignSqlObject } from '@dbmastermind/core/browser'
import { Button } from '@/components/ui/Button'
import { Checkbox, Input, Select, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/** A view of a DeZign project with its code as the project keeps it. */
export type ModelView = DezignSqlObject & { id: string; code: string }

export const editableViews = (objects: DezignSqlObject[] | undefined): ModelView[] =>
  (objects ?? []).filter((o): o is ModelView => o.kind === 'view' && !!o.id && o.code !== undefined)

/** What of a project's SQL objects can be edited here: views, triggers and procedures with code, sequences. */
export const editableObjects = (objects: DezignSqlObject[] | undefined) =>
  (objects ?? []).filter((o) => (o.kind === 'sequence' ? !!o.id : !!o.id && o.code !== undefined))

const KINDS = [
  ['view', 'Views'],
  ['trigger', 'Triggers'],
  ['procedure', 'Procedures'],
  ['sequence', 'Sequences'],
] as const

const keyOf = (o: DezignSqlObject, i: number) => o.id ?? `new:${i}`

/**
 * The project's views, triggers, procedures and sequences (DeZign's dialogs for them): code is edited as DeZign keeps
 * it (`%viewname%`, `%triggername%`, `%table%` stand for the names), a sequence by its settings. New triggers and
 * sequences are added here, triggers, procedures and sequences removed. All of it goes into the project and the DDL.
 */
export function ViewsModal({
  open,
  objects,
  tables,
  start,
  onClose,
  onApply,
}: {
  open: boolean
  objects: DezignSqlObject[]
  /** Tables a new trigger can belong to. */
  tables: { schema?: string; name: string }[]
  /** The object shown first (its id). */
  start?: string
  onClose: () => void
  onApply: (objects: DezignSqlObject[]) => void
}) {
  const t = useT()
  const [list, setList] = useState<DezignSqlObject[]>([])
  const [selected, setSelected] = useState('')
  const [shown, setShown] = useState(false)
  // Set during render when the dialog opens, so it starts from the objects as they are now.
  if (open !== shown) {
    setShown(open)
    if (open) {
      setList(objects)
      const editable = editableObjects(objects)
      setSelected(start && editable.some((o) => o.id === start) ? start : (editable[0]?.id ?? ''))
    }
  }
  const editable = list
    .map((o, i) => ({ o, key: keyOf(o, i), i }))
    .filter(
      ({ o }) => (o.kind === 'sequence' ? true : o.code !== undefined) && (o.id || !objects.includes(o)),
    )
  const current = editable.find((x) => x.key === selected)
  const update = (i: number, patch: Partial<DezignSqlObject>) =>
    setList((l) => l.map((o, k) => (k === i ? withDezignSql({ ...o, ...patch }) : o)))
  const name = (o: DezignSqlObject) =>
    o.kind === 'trigger'
      ? `${o.table ? `${o.table}.` : ''}${o.name}`
      : o.schema
        ? `${o.schema}.${o.name}`
        : o.name
  const original = (o: DezignSqlObject) => objects.find((x) => x.id && x.id === o.id)
  const changed = (o: DezignSqlObject) => !original(o) || JSON.stringify(original(o)) !== JSON.stringify(o)
  const add = (kind: 'trigger' | 'sequence') => {
    const table = tables[0]
    const count = list.filter((o) => o.kind === kind).length + 1
    const o: DezignSqlObject =
      kind === 'trigger'
        ? withDezignSql({
            kind,
            name: `trg_${table?.name ?? 'table'}_${count}`,
            schema: table?.schema,
            table: table?.name,
            code: 'CREATE TRIGGER %triggername%\n  BEFORE INSERT OR UPDATE ON %table%\n  FOR EACH ROW\n  EXECUTE FUNCTION ',
            sql: '',
          })
        : withDezignSql({
            kind,
            name: `seq_${count}`,
            schema: tables[0]?.schema,
            sequence: { increment: '1', start: '1' },
            sql: '',
          })
    setList((l) => [...l, o])
    setSelected(`new:${list.length}`)
  }
  const remove = (i: number) => {
    setList((l) => l.filter((_, k) => k !== i))
    setSelected('')
  }
  const invalid = editable.some(({ o }) => !o.name.trim() || (o.kind !== 'sequence' && !o.code?.trim()))
  const field = (
    label: string,
    value: string | undefined,
    onChange: (v: string) => void,
    testId?: string,
  ) => (
    <label className="flex flex-col gap-1">
      <span className="text-[11.5px] font-medium text-fg-muted">{label}</span>
      <Input
        inputSize="sm"
        className="font-mono text-[12px]"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
      />
    </label>
  )
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('Views and code')}
      width={860}
      footer={
        <>
          <div className="flex-1" />
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button
            variant="primary"
            disabled={invalid}
            onClick={() => onApply(list)}
            data-testid="views-apply"
          >
            {t('Apply')}
          </Button>
        </>
      }
    >
      <p className="mb-2 text-[12px] text-fg-muted">
        {t(
          'The project’s SQL objects as DeZign keeps them: %viewname%, %triggername% and %table% stand for the names. They go into the project and into the DDL script.',
        )}
      </p>
      <div className="flex h-[52vh] gap-2">
        <div className="flex w-56 shrink-0 flex-col gap-0.5 overflow-auto">
          {KINDS.map(([kind, title]) => {
            const items = editable.filter(({ o }) => o.kind === kind)
            if (!items.length && kind !== 'trigger' && kind !== 'sequence') return null
            return (
              <div key={kind} className="mb-1.5">
                <div className="flex items-center px-1 text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
                  <span className="flex-1">{t(title)}</span>
                  {(kind === 'trigger' ? tables.length > 0 : kind === 'sequence') && (
                    <button
                      type="button"
                      className="rounded p-0.5 hover:bg-subtle"
                      title={kind === 'trigger' ? t('New trigger') : t('New sequence')}
                      onClick={() => add(kind as 'trigger' | 'sequence')}
                      data-testid={`objects-add-${kind}`}
                    >
                      <Plus size={12} />
                    </button>
                  )}
                </div>
                {items.map(({ o, key }) => (
                  <button
                    key={key}
                    type="button"
                    className={cn(
                      'w-full truncate rounded px-2 py-1 text-left font-mono text-[12px] hover:bg-subtle',
                      key === selected && 'bg-subtle font-medium',
                    )}
                    onClick={() => setSelected(key)}
                    data-testid={kind === 'view' ? 'views-item' : `objects-item-${kind}`}
                  >
                    {name(o)}
                    {changed(o) ? ' •' : ''}
                  </button>
                ))}
              </div>
            )
          })}
        </div>
        {current && (
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {current.o.kind !== 'view' && (
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  {field(t('Name'), current.o.name, (v) => update(current.i, { name: v }), 'objects-name')}
                </div>
                {current.o.kind === 'trigger' && !current.o.id && (
                  <label className="flex flex-col gap-1">
                    <span className="text-[11.5px] font-medium text-fg-muted">{t('Table')}</span>
                    <Select
                      inputSize="sm"
                      className="w-56"
                      value={`${current.o.schema ?? ''}.${current.o.table ?? ''}`}
                      onChange={(e) => {
                        const table = tables.find((x) => `${x.schema ?? ''}.${x.name}` === e.target.value)
                        if (table) update(current.i, { schema: table.schema, table: table.name })
                      }}
                      data-testid="objects-table"
                    >
                      {tables.map((x) => (
                        <option key={`${x.schema ?? ''}.${x.name}`} value={`${x.schema ?? ''}.${x.name}`}>
                          {x.schema ? `${x.schema}.${x.name}` : x.name}
                        </option>
                      ))}
                    </Select>
                  </label>
                )}
                {current.o.kind === 'sequence' && (
                  <div className="w-40">
                    {field(t('Schema'), current.o.schema, (v) =>
                      update(current.i, { schema: v.trim() || undefined }),
                    )}
                  </div>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 size={12} />}
                  onClick={() => remove(current.i)}
                  data-testid="objects-remove"
                >
                  {t('Remove')}
                </Button>
              </div>
            )}
            {current.o.kind === 'sequence' ? (
              <div className="grid grid-cols-3 gap-2">
                {field(
                  t('Increment by'),
                  current.o.sequence?.increment,
                  (v) => update(current.i, { sequence: { ...current.o.sequence, increment: v } }),
                  'objects-increment',
                )}
                {field(
                  t('Start with'),
                  current.o.sequence?.start,
                  (v) => update(current.i, { sequence: { ...current.o.sequence, start: v } }),
                  'objects-start',
                )}
                {field(t('Cache'), current.o.sequence?.cache, (v) =>
                  update(current.i, { sequence: { ...current.o.sequence, cache: v } }),
                )}
                {field(t('Minimum'), current.o.sequence?.min, (v) =>
                  update(current.i, { sequence: { ...current.o.sequence, min: v } }),
                )}
                {field(t('Maximum'), current.o.sequence?.max, (v) =>
                  update(current.i, { sequence: { ...current.o.sequence, max: v } }),
                )}
                <div className="flex items-end pb-1">
                  <Checkbox
                    checked={!!current.o.sequence?.cycle}
                    onChange={(v) => update(current.i, { sequence: { ...current.o.sequence, cycle: v } })}
                    label={<span className="text-[12px]">{t('Cycle')}</span>}
                  />
                </div>
                <pre
                  className="col-span-3 mt-2 overflow-auto rounded-md border border-line bg-subtle p-2 font-mono text-[12px] whitespace-pre-wrap"
                  data-testid="objects-sql"
                >
                  {current.o.sql}
                </pre>
              </div>
            ) : (
              <Textarea
                className="min-h-0 flex-1 resize-none font-mono text-[12px]"
                spellCheck={false}
                value={current.o.code ?? ''}
                onChange={(e) => update(current.i, { code: e.target.value })}
                aria-label={name(current.o)}
                data-testid={current.o.kind === 'view' ? 'views-code' : 'objects-code'}
              />
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

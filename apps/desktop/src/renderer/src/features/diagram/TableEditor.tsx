import { useEffect, useRef } from 'react'
import { ArrowDown, ArrowRight, ArrowUp, KeyRound, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import {
  COMMON_TYPES,
  designId,
  type DesignTable,
  type DriverId,
  type TableInfo,
} from '@dbmastermind/core/browser'
import { Button, IconButton } from '@/components/ui/Button'
import { Checkbox, Input, Select, Textarea } from '@/components/ui/Input'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'

const FK_ACTIONS = ['NO ACTION', 'CASCADE', 'SET NULL', 'RESTRICT', 'SET DEFAULT']
/** How many child rows one parent row has (DeZign's relationship cardinality); none: zero or more. */
const CARDINALITIES = [
  ['', 'zero or more'],
  ['one-or-more', 'one or more'],
  ['zero-or-one', 'zero or one'],
  ['exactly-one', 'exactly one'],
] as const
/** Collations are written only for the databases DeZign writes them for (SQL Server, MySQL). */
const COLLATING: DriverId[] = ['mssql', 'mysql', 'mariadb']

/** Side panel that edits one draft table in the schema designer. */
export function TableEditor({
  table,
  driver,
  allTables: everything,
  model,
  domains: projectDomains,
  onChange,
  onRevert,
  onClose,
  focusForeignKey,
  only,
}: {
  table: DesignTable
  driver: DriverId
  allTables: TableInfo[]
  /** A model, not a live database: nothing is in the way of what an ALTER could not do (auto-increment on a column that exists). */
  model?: boolean
  /** The project's domains (also the ones no column follows yet). */
  domains?: { name: string; dataType: string }[]
  onChange: (table: DesignTable) => void
  onRevert?: () => void
  onClose: () => void
  /** A relationship clicked on the diagram: its foreign key is shown and highlighted. */
  focusForeignKey?: string
  /** Inside the table dialog: just these sections, without the panel's frame. */
  only?: ('foreignKeys' | 'indexes' | 'checks')[]
}) {
  const tr = useT()
  // Foreign keys can only point at tables, not views.
  const allTables = everything.filter((t) => t.type === 'table' || t.type === 'foreign_table')
  // A new table starts with its name selected, so typing names it.
  const nameInput = useRef<HTMLInputElement>(null)
  const isNew = !table.originalName
  useEffect(() => {
    if (isNew) nameInput.current?.select()
  }, [table.id, isNew])
  const focused = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focusForeignKey) focused.current?.scrollIntoView({ block: 'center' })
  }, [focusForeignKey, table.id])
  // Schemas the model already has, offered when a table moves to another one.
  const schemas = [...new Set(everything.map((t) => t.schema).filter((x): x is string => !!x))].sort()
  const set = (patch: Partial<DesignTable>) => onChange({ ...table, ...patch })
  const setColumn = (id: string, patch: Partial<DesignTable['columns'][number]>) => {
    const old = table.columns.find((c) => c.id === id)!
    // A column given its own type no longer follows the named type (domain) it had.
    if (patch.dataType !== undefined && patch.dataType !== old.dataType && old.domain && !('domain' in patch))
      patch = { ...patch, domain: undefined }
    const columns = table.columns.map((c) => (c.id === id ? { ...c, ...patch } : c))
    // Keep keys pointing at renamed columns.
    const rename = (name: string) => (patch.name && name === old.name ? patch.name : name)
    set({
      columns,
      primaryKey: table.primaryKey.map(rename),
      foreignKeys: table.foreignKeys.map((f) => ({ ...f, columns: f.columns.map(rename) })),
      indexes: table.indexes.map((i) => ({ ...i, columns: i.columns.map(rename) })),
    })
  }
  const togglePk = (name: string, on: boolean) =>
    set({ primaryKey: on ? [...table.primaryKey, name] : table.primaryKey.filter((c) => c !== name) })
  const moveColumn = (id: string, by: -1 | 1) => {
    const from = table.columns.findIndex((c) => c.id === id)
    const to = from + by
    if (from === -1 || to < 0 || to >= table.columns.length) return
    const columns = [...table.columns]
    columns.splice(to, 0, ...columns.splice(from, 1))
    set({ columns })
  }
  // The named types (domains) the model's columns follow, with the type each stands for.
  const domains = [
    ...new Map([
      ...everything.flatMap((t) =>
        t.columns.filter((c) => c.domain).map((c) => [c.domain!, c.dataType] as const),
      ),
      ...(projectDomains ?? []).map((d) => [d.name, d.dataType] as const),
    ]).entries(),
  ].sort(([a], [b]) => a.localeCompare(b))
  const types = COMMON_TYPES[driver]
  const textType = types.find((t) => /char|text/i.test(t)) ?? types[0] ?? 'text'
  // Tables are told apart by schema too: "All schemas" can show shop.customers next to xt.customers.
  const tableKey = (schema: string | null | undefined, name: string) => `${schema ?? ''}.${name}`
  const refTable = (schema: string | null | undefined, name: string) =>
    allTables.find((t) => t.name === name && (t.schema ?? '') === (schema ?? '')) ??
    allTables.find((t) => t.name === name)
  const ambiguous = new Set(
    allTables.filter((t, i) => allTables.some((x, j) => j !== i && x.name === t.name)).map((t) => t.name),
  )
  const show = (section: 'details' | 'columns' | 'foreignKeys' | 'indexes' | 'checks') =>
    !only || (only as string[]).includes(section)

  const sections = (
    <>
      {show('details') && (
        <>
          <div className="mb-3 flex gap-2">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-[11.5px] font-medium text-fg-muted">{tr('Name')}</span>
              <Input
                ref={nameInput}
                inputSize="sm"
                value={table.name}
                onChange={(e) => set({ name: e.target.value })}
              />
            </label>
            {(table.schema || model) && (
              <label className="flex w-32 flex-col gap-1">
                <span className="text-[11.5px] font-medium text-fg-muted">{tr('Schema')}</span>
                {/* In a model the table moves to another schema; in a live database that would be a new table. */}
                <Input
                  inputSize="sm"
                  value={table.schema ?? ''}
                  disabled={!model}
                  list="dbm-schemas"
                  onChange={(e) => set({ schema: e.target.value.trim() || undefined })}
                  data-testid="table-schema"
                />
                <datalist id="dbm-schemas">
                  {schemas.map((x) => (
                    <option key={x} value={x} />
                  ))}
                </datalist>
              </label>
            )}
          </div>
          <label className="mb-2 flex flex-col gap-1">
            <span className="text-[11.5px] font-medium text-fg-muted">{tr('Comment')}</span>
            <Textarea
              rows={2}
              className="resize-y text-[12px]"
              value={table.comment ?? ''}
              onChange={(e) => set({ comment: e.target.value || null })}
              placeholder={tr('What is stored here')}
              data-testid="table-comment"
            />
          </label>
          {model && (
            <label className="mb-4 flex flex-col gap-1">
              <span
                className="text-[11.5px] font-medium text-fg-muted"
                title={tr('Notes kept with the model (DeZign: Notes); never in a script')}
              >
                {tr('Notes')}
              </span>
              <Textarea
                rows={2}
                className="resize-y text-[12px]"
                value={table.remarks ?? ''}
                onChange={(e) => set({ remarks: e.target.value || undefined })}
                data-testid="table-remarks"
              />
            </label>
          )}
        </>
      )}
      {show('columns') && (
        <Section
          title={tr('Columns')}
          onAdd={() =>
            set({
              columns: [
                ...table.columns,
                {
                  id: designId('c'),
                  name: `column_${table.columns.length + 1}`,
                  dataType: textType,
                  nullable: true,
                },
              ],
            })
          }
        >
          <div className="flex flex-col gap-1">
            {table.columns.map((c) => (
              <div key={c.id} className="rounded-md border border-line bg-bg p-1.5">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    title={
                      table.primaryKey.includes(c.name)
                        ? tr('Remove from primary key')
                        : tr('Add to primary key')
                    }
                    onClick={() => togglePk(c.name, !table.primaryKey.includes(c.name))}
                    className={cn(
                      'flex h-6 w-6 shrink-0 items-center justify-center rounded',
                      table.primaryKey.includes(c.name) ? 'text-warning' : 'text-fg-faint hover:text-fg',
                    )}
                  >
                    <KeyRound size={12} />
                  </button>
                  <Input
                    inputSize="sm"
                    className="h-6 flex-1 font-mono text-[12px]"
                    value={c.name}
                    onChange={(e) => setColumn(c.id, { name: e.target.value })}
                  />
                  <Input
                    inputSize="sm"
                    className="h-6 w-[130px] font-mono text-[12px]"
                    list="dbm-types"
                    value={c.dataType}
                    onChange={(e) => setColumn(c.id, { dataType: e.target.value })}
                  />
                  <IconButton label={tr('Move up')} onClick={() => moveColumn(c.id, -1)}>
                    <ArrowUp size={12} />
                  </IconButton>
                  <IconButton label={tr('Move down')} onClick={() => moveColumn(c.id, 1)}>
                    <ArrowDown size={12} />
                  </IconButton>
                  <IconButton
                    label={tr('Delete column')}
                    onClick={() =>
                      set({
                        columns: table.columns.filter((x) => x.id !== c.id),
                        primaryKey: table.primaryKey.filter((x) => x !== c.name),
                        foreignKeys: table.foreignKeys.filter((f) => !f.columns.includes(c.name)),
                        indexes: table.indexes.filter((i) => !i.columns.includes(c.name)),
                      })
                    }
                  >
                    <Trash2 size={12} />
                  </IconButton>
                </div>
                <div className="mt-1 flex items-center gap-3 pl-7">
                  <Checkbox
                    checked={!c.nullable}
                    onChange={(v) => setColumn(c.id, { nullable: !v })}
                    label={<span className="text-[11.5px]">NOT NULL</span>}
                  />
                  {(model || !c.originalName) &&
                    (driver !== 'sqlite' || table.primaryKey.includes(c.name)) && (
                      <Checkbox
                        checked={!!c.identity}
                        onChange={(v) => setColumn(c.id, { identity: v })}
                        label={<span className="text-[11.5px]">{tr('auto-increment')}</span>}
                      />
                    )}
                  <Input
                    inputSize="sm"
                    className="h-6 flex-1 font-mono text-[11px]"
                    placeholder={tr('default')}
                    value={c.defaultValue ?? ''}
                    onChange={(e) => setColumn(c.id, { defaultValue: e.target.value || null })}
                  />
                </div>
                <div className="mt-1 flex items-center gap-1.5 pl-7">
                  <Input
                    inputSize="sm"
                    className="h-6 flex-1 text-[11.5px]"
                    placeholder={tr('Comment')}
                    value={c.comment ?? ''}
                    onChange={(e) => setColumn(c.id, { comment: e.target.value || null })}
                    data-testid={`column-comment-${c.name}`}
                  />
                  {(domains.length > 0 || c.domain) && (
                    <Select
                      inputSize="sm"
                      className="h-6 w-[130px] text-[11px]"
                      title={tr('The named type (domain) the column follows')}
                      value={c.domain ?? ''}
                      onChange={(e) => {
                        const picked = domains.find(([name]) => name === e.target.value)
                        setColumn(
                          c.id,
                          picked ? { domain: picked[0], dataType: picked[1] } : { domain: undefined },
                        )
                      }}
                    >
                      <option value="">{tr('own type')}</option>
                      {c.domain && !domains.some(([name]) => name === c.domain) && (
                        <option value={c.domain}>{c.domain}</option>
                      )}
                      {domains.map(([name]) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </Select>
                  )}
                </div>
                {model && (
                  <div className="mt-1 flex items-center gap-1.5 pl-7">
                    <Input
                      inputSize="sm"
                      className="h-6 flex-1 text-[11.5px]"
                      placeholder={tr('Notes')}
                      title={tr('Notes kept with the model (DeZign: Notes); never in a script')}
                      value={c.remarks ?? ''}
                      onChange={(e) => setColumn(c.id, { remarks: e.target.value || undefined })}
                      data-testid={`column-remarks-${c.name}`}
                    />
                    {(COLLATING.includes(driver) || c.collation) && (
                      <Input
                        inputSize="sm"
                        className="h-6 w-[130px] font-mono text-[11px]"
                        placeholder={tr('collation')}
                        value={c.collation ?? ''}
                        onChange={(e) => setColumn(c.id, { collation: e.target.value.trim() || undefined })}
                        data-testid={`column-collation-${c.name}`}
                      />
                    )}
                  </div>
                )}
                {!model && c.originalName && c.originalName !== c.name && (
                  <div className="mt-1 pl-7 text-[10.5px] text-fg-faint">
                    {tr('renamed from {name}', { name: c.originalName })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {show('foreignKeys') && (
        <Section
          title={tr('Foreign keys')}
          onAdd={() => {
            const target = allTables.find((t) => t.name !== table.name) ?? allTables[0]
            set({
              foreignKeys: [
                ...table.foreignKeys,
                {
                  id: designId('f'),
                  columns: [table.columns[0]?.name ?? ''],
                  refSchema: target?.schema,
                  refTable: target?.name ?? '',
                  refColumns: [target?.primaryKey[0] ?? target?.columns[0]?.name ?? ''],
                },
              ],
            })
          }}
        >
          {table.foreignKeys.length === 0 && (
            <div className="text-[11.5px] text-fg-faint">
              {tr("Drag from a column to another table's column in the diagram, or add one here.")}
            </div>
          )}
          {table.foreignKeys.map((fk) => {
            const target = refTable(fk.refSchema, fk.refTable)
            const update = (patch: Partial<typeof fk>) =>
              set({ foreignKeys: table.foreignKeys.map((f) => (f.id === fk.id ? { ...f, ...patch } : f)) })
            const isFocused =
              !!focusForeignKey &&
              (fk.name === focusForeignKey ||
                fk.originalName === focusForeignKey ||
                fk.id === focusForeignKey)
            // One pair per column of the key: this table's column → the other table's column.
            const pairs = fk.columns.map((c, i) => [c, fk.refColumns[i] ?? ''] as const)
            const setPair = (i: number, column: string, ref: string) =>
              update({
                columns: fk.columns.map((c, k) => (k === i ? column : c)),
                refColumns: fk.columns.map((_, k) => (k === i ? ref : (fk.refColumns[k] ?? ''))),
              })
            return (
              <div
                key={fk.id}
                ref={isFocused ? focused : undefined}
                className={cn(
                  'mb-1 flex flex-col gap-1 rounded-md border bg-bg p-1.5',
                  isFocused ? 'border-accent ring-1 ring-accent' : 'border-line',
                )}
                data-testid={`fk-${fk.name ?? fk.id}`}
              >
                <div className="flex items-center gap-1">
                  <Input
                    inputSize="sm"
                    className="h-6 min-w-0 flex-1 font-mono text-[11.5px]"
                    placeholder={tr('Name (optional)')}
                    value={fk.name ?? ''}
                    onChange={(e) => update({ name: e.target.value || undefined })}
                  />
                  <ArrowRight size={12} className="shrink-0 text-fg-faint" />
                  <Select
                    inputSize="sm"
                    className="h-6 min-w-0 flex-1 text-[12px]"
                    title={fk.refSchema ? `${fk.refSchema}.${fk.refTable}` : fk.refTable}
                    value={
                      target ? tableKey(target.schema, target.name) : tableKey(fk.refSchema, fk.refTable)
                    }
                    onChange={(e) => {
                      const t = allTables.find((x) => tableKey(x.schema, x.name) === e.target.value)
                      // The other table's key, column for column (a key of several columns gets a pair for each).
                      if (t) {
                        const keys = t.primaryKey.length ? t.primaryKey : [t.columns[0]?.name ?? '']
                        update({
                          refTable: t.name,
                          refSchema: t.schema,
                          refColumns: keys,
                          columns: keys.map(
                            (k, i) =>
                              fk.columns[i] ??
                              table.columns.find((c) => c.name === k)?.name ??
                              table.columns[0]?.name ??
                              '',
                          ),
                        })
                      }
                    }}
                  >
                    {allTables.map((t) => (
                      <option key={tableKey(t.schema, t.name)} value={tableKey(t.schema, t.name)}>
                        {ambiguous.has(t.name) && t.schema ? `${t.schema}.${t.name}` : t.name}
                      </option>
                    ))}
                  </Select>
                  <IconButton
                    label={tr('Delete foreign key')}
                    onClick={() => set({ foreignKeys: table.foreignKeys.filter((f) => f.id !== fk.id) })}
                  >
                    <Trash2 size={12} />
                  </IconButton>
                </div>
                {pairs.map(([column, ref], i) => (
                  <div key={i} className="flex items-center gap-1 pl-1">
                    <Select
                      inputSize="sm"
                      className="h-5 min-w-0 flex-1 text-[11px]"
                      title={column}
                      value={column}
                      onChange={(e) => setPair(i, e.target.value, ref)}
                      data-testid={`fk-column-${i}`}
                    >
                      {table.columns.map((c) => (
                        <option key={c.id}>{c.name}</option>
                      ))}
                    </Select>
                    <ArrowRight size={11} className="shrink-0 text-fg-faint" />
                    <Select
                      inputSize="sm"
                      className="h-5 min-w-0 flex-1 text-[11px]"
                      title={ref}
                      value={ref}
                      onChange={(e) => setPair(i, column, e.target.value)}
                      data-testid={`fk-ref-column-${i}`}
                    >
                      {!(target?.columns ?? []).some((c) => c.name === ref) && (
                        <option value={ref}>{ref}</option>
                      )}
                      {(target?.columns ?? []).map((c) => (
                        <option key={c.name}>{c.name}</option>
                      ))}
                    </Select>
                    {pairs.length > 1 ? (
                      <IconButton
                        label={tr('Remove this pair of columns')}
                        onClick={() =>
                          update({
                            columns: fk.columns.filter((_, k) => k !== i),
                            refColumns: fk.refColumns.filter((_, k) => k !== i),
                          })
                        }
                      >
                        <X size={11} />
                      </IconButton>
                    ) : (
                      <span className="w-6" />
                    )}
                  </div>
                ))}
                <div className="flex items-center gap-1.5 pl-1 text-[11px] text-fg-muted">
                  <Button
                    size="xs"
                    variant="ghost"
                    icon={<Plus size={10} />}
                    onClick={() =>
                      update({
                        columns: [...fk.columns, table.columns[0]?.name ?? ''],
                        refColumns: [
                          ...fk.refColumns,
                          target?.columns.find((c) => !fk.refColumns.includes(c.name))?.name ?? '',
                        ],
                      })
                    }
                    data-testid="fk-add-pair"
                  >
                    {tr('Column')}
                  </Button>
                  <div className="flex-1" />
                  {tr('on delete')}
                  <Select
                    inputSize="sm"
                    className="h-5 w-28 text-[11px]"
                    value={fk.onDelete ?? 'NO ACTION'}
                    onChange={(e) => update({ onDelete: e.target.value })}
                  >
                    {FK_ACTIONS.map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </Select>
                </div>
                <div className="flex items-center gap-1.5 pl-1 text-[11px] text-fg-muted">
                  {model && (
                    <>
                      <span
                        title={tr(
                          'How many rows of this table one row of the other table has (drawn at this end of the line)',
                        )}
                      >
                        {tr('rows here')}
                      </span>
                      <Select
                        inputSize="sm"
                        className="h-5 min-w-0 flex-1 text-[11px]"
                        value={fk.cardinality ?? ''}
                        onChange={(e) =>
                          update({ cardinality: (e.target.value || undefined) as typeof fk.cardinality })
                        }
                        data-testid="fk-cardinality"
                      >
                        {CARDINALITIES.map(([value, label]) => (
                          <option key={value} value={value}>
                            {tr(label)}
                          </option>
                        ))}
                      </Select>
                    </>
                  )}
                  <div className="flex-1" />
                  {tr('on update')}
                  <Select
                    inputSize="sm"
                    className="h-5 w-28 text-[11px]"
                    value={fk.onUpdate ?? 'NO ACTION'}
                    onChange={(e) => update({ onUpdate: e.target.value })}
                  >
                    {FK_ACTIONS.map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </Select>
                </div>
              </div>
            )
          })}
        </Section>
      )}

      {show('indexes') && (
        <Section
          title={tr('Indexes')}
          onAdd={() =>
            set({
              indexes: [
                ...table.indexes,
                { id: designId('i'), columns: [table.columns[0]?.name ?? ''], unique: false },
              ],
            })
          }
        >
          {table.indexes.map((ix) => {
            const update = (patch: Partial<typeof ix>) =>
              set({ indexes: table.indexes.map((i) => (i.id === ix.id ? { ...i, ...patch } : i)) })
            return (
              <div
                key={ix.id}
                className="mb-1 flex items-center gap-1 rounded-md border border-line bg-bg p-1.5"
              >
                <Input
                  inputSize="sm"
                  className="h-6 w-[130px] font-mono text-[11.5px]"
                  placeholder={tr('Name (optional)')}
                  value={ix.name ?? ''}
                  onChange={(e) => update({ name: e.target.value || undefined })}
                />
                <Input
                  inputSize="sm"
                  className="h-6 flex-1 font-mono text-[12px]"
                  value={ix.columns.join(', ')}
                  onChange={(e) => update({ columns: e.target.value.split(',').map((x) => x.trim()) })}
                  title={tr('Columns, comma separated')}
                />
                <Checkbox
                  checked={ix.unique}
                  onChange={(unique) => update({ unique })}
                  label={<span className="text-[11.5px]">{tr('unique')}</span>}
                />
                <IconButton
                  label={tr('Delete index')}
                  onClick={() => set({ indexes: table.indexes.filter((i) => i.id !== ix.id) })}
                >
                  <Trash2 size={12} />
                </IconButton>
              </div>
            )
          })}
        </Section>
      )}

      {show('checks') && (
        <Section
          title={tr('Checks')}
          onAdd={() => set({ checks: [...(table.checks ?? []), { expression: '' }] })}
        >
          {(table.checks ?? []).map((check, i) => {
            const update = (patch: Partial<typeof check>) =>
              set({ checks: (table.checks ?? []).map((c, k) => (k === i ? { ...c, ...patch } : c)) })
            return (
              <div key={i} className="mb-1 flex flex-col gap-1 rounded-md border border-line bg-bg p-1.5">
                <div className="flex items-center gap-1">
                  <Input
                    inputSize="sm"
                    className="h-6 flex-1 font-mono text-[11.5px]"
                    placeholder={tr('Name (optional)')}
                    value={check.name ?? ''}
                    onChange={(e) => update({ name: e.target.value || undefined })}
                  />
                  <IconButton
                    label={tr('Delete check')}
                    onClick={() => set({ checks: (table.checks ?? []).filter((_, k) => k !== i) })}
                  >
                    <Trash2 size={12} />
                  </IconButton>
                </div>
                <Input
                  inputSize="sm"
                  className="h-6 font-mono text-[12px]"
                  placeholder={tr('Condition, e.g. price >= 0')}
                  value={check.expression}
                  onChange={(e) => update({ expression: e.target.value })}
                  data-testid={`check-condition-${i}`}
                />
              </div>
            )
          })}
        </Section>
      )}
    </>
  )
  if (only) return sections

  return (
    <div className="flex w-[420px] shrink-0 flex-col border-l border-line bg-subtle">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line pr-1.5 pl-3">
        <span className="text-[12.5px] font-semibold">
          {table.originalName ? tr('Edit table') : tr('New table')}
        </span>
        {table.dropped && (
          <span className="rounded bg-danger px-1.5 text-[10px] font-bold text-white">
            {tr('WILL BE DROPPED')}
          </span>
        )}
        <div className="flex-1" />
        {onRevert && (
          <IconButton label={tr('Revert changes to this table')} onClick={onRevert}>
            <RotateCcw size={13} />
          </IconButton>
        )}
        <IconButton label={tr('Close')} onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
      <datalist id="dbm-types">
        {types.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <div
        className={cn('min-h-0 flex-1 overflow-auto p-3', table.dropped && 'pointer-events-none opacity-50')}
      >
        {sections}
      </div>
      <div className="border-t border-line p-2">
        {table.dropped ? (
          <Button className="w-full" onClick={() => set({ dropped: false })}>
            {tr('Keep this table')}
          </Button>
        ) : (
          <Button
            className="w-full"
            variant="ghost"
            icon={<Trash2 size={13} />}
            onClick={() => set({ dropped: true })}
          >
            {table.originalName ? tr('Drop table') : tr('Remove new table')}
          </Button>
        )}
      </div>
    </div>
  )
}

function Section({
  title,
  onAdd,
  children,
}: {
  title: string
  onAdd: () => void
  children: React.ReactNode
}) {
  const tr = useT()
  return (
    <div className="mb-4">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold tracking-wide text-fg-faint uppercase">{title}</span>
        <Button size="xs" variant="ghost" icon={<Plus size={11} />} onClick={onAdd}>
          {tr('Add')}
        </Button>
      </div>
      {children}
    </div>
  )
}

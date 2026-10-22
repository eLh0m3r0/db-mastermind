import { ArrowRight, KeyRound, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { COMMON_TYPES, designId, type DesignTable, type DriverId, type TableInfo } from '@dbmastermind/core/browser'
import { Button, IconButton } from '@/components/ui/Button'
import { Checkbox, Input, Select } from '@/components/ui/Input'
import { cn } from '@/lib/utils'

const FK_ACTIONS = ['NO ACTION', 'CASCADE', 'SET NULL', 'RESTRICT', 'SET DEFAULT']

/** Side panel that edits one draft table in the schema designer. */
export function TableEditor({
  table,
  driver,
  allTables,
  onChange,
  onRevert,
  onClose,
}: {
  table: DesignTable
  driver: DriverId
  allTables: TableInfo[]
  onChange: (table: DesignTable) => void
  onRevert?: () => void
  onClose: () => void
}) {
  const set = (patch: Partial<DesignTable>) => onChange({ ...table, ...patch })
  const setColumn = (id: string, patch: Partial<DesignTable['columns'][number]>) => {
    const old = table.columns.find((c) => c.id === id)!
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
  const types = COMMON_TYPES[driver]
  const textType = types.find((t) => /char|text/i.test(t)) ?? types[0] ?? 'text'
  const refTable = (name: string) => allTables.find((t) => t.name === name)

  return (
    <div className="flex w-[420px] shrink-0 flex-col border-l border-line bg-subtle">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line pr-1.5 pl-3">
        <span className="text-[12.5px] font-semibold">{table.originalName ? 'Edit table' : 'New table'}</span>
        {table.dropped && <span className="rounded bg-danger px-1.5 text-[10px] font-bold text-white">WILL BE DROPPED</span>}
        <div className="flex-1" />
        {onRevert && (
          <IconButton label="Revert changes to this table" onClick={onRevert}>
            <RotateCcw size={13} />
          </IconButton>
        )}
        <IconButton label="Close" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
      <datalist id="dbm-types">
        {types.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <div className={cn('min-h-0 flex-1 overflow-auto p-3', table.dropped && 'pointer-events-none opacity-50')}>
        <div className="mb-3 flex gap-2">
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-[11.5px] font-medium text-fg-muted">Name</span>
            <Input inputSize="sm" value={table.name} onChange={(e) => set({ name: e.target.value })} />
          </label>
          {table.schema && (
            <label className="flex w-28 flex-col gap-1">
              <span className="text-[11.5px] font-medium text-fg-muted">Schema</span>
              <Input inputSize="sm" value={table.schema} disabled />
            </label>
          )}
        </div>
        <label className="mb-4 flex flex-col gap-1">
          <span className="text-[11.5px] font-medium text-fg-muted">Comment</span>
          <Input inputSize="sm" value={table.comment ?? ''} onChange={(e) => set({ comment: e.target.value || null })} placeholder="What is stored here" />
        </label>

        <Section title="Columns" onAdd={() => set({ columns: [...table.columns, { id: designId('c'), name: `column_${table.columns.length + 1}`, dataType: textType, nullable: true }] })}>
          <div className="flex flex-col gap-1">
            {table.columns.map((c) => (
              <div key={c.id} className="rounded-md border border-line bg-bg p-1.5">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    title={table.primaryKey.includes(c.name) ? 'Remove from primary key' : 'Add to primary key'}
                    onClick={() => togglePk(c.name, !table.primaryKey.includes(c.name))}
                    className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded', table.primaryKey.includes(c.name) ? 'text-warning' : 'text-fg-faint hover:text-fg')}
                  >
                    <KeyRound size={12} />
                  </button>
                  <Input inputSize="sm" className="h-6 flex-1 font-mono text-[12px]" value={c.name} onChange={(e) => setColumn(c.id, { name: e.target.value })} />
                  <Input inputSize="sm" className="h-6 w-[130px] font-mono text-[12px]" list="dbm-types" value={c.dataType} onChange={(e) => setColumn(c.id, { dataType: e.target.value })} />
                  <IconButton
                    label="Delete column"
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
                  <Checkbox checked={!c.nullable} onChange={(v) => setColumn(c.id, { nullable: !v })} label={<span className="text-[11.5px]">NOT NULL</span>} />
                  {!c.originalName && (driver !== 'sqlite' || table.primaryKey.includes(c.name)) && (
                    <Checkbox checked={!!c.identity} onChange={(v) => setColumn(c.id, { identity: v })} label={<span className="text-[11.5px]">auto-increment</span>} />
                  )}
                  <Input
                    inputSize="sm"
                    className="h-6 flex-1 font-mono text-[11px]"
                    placeholder="default"
                    value={c.defaultValue ?? ''}
                    onChange={(e) => setColumn(c.id, { defaultValue: e.target.value || null })}
                  />
                </div>
                {c.originalName && c.originalName !== c.name && <div className="mt-1 pl-7 text-[10.5px] text-fg-faint">renamed from {c.originalName}</div>}
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="Foreign keys"
          onAdd={() => {
            const target = allTables.find((t) => t.name !== table.name) ?? allTables[0]
            set({
              foreignKeys: [
                ...table.foreignKeys,
                { id: designId('f'), columns: [table.columns[0]?.name ?? ''], refSchema: target?.schema, refTable: target?.name ?? '', refColumns: [target?.primaryKey[0] ?? target?.columns[0]?.name ?? ''] },
              ],
            })
          }}
        >
          {table.foreignKeys.length === 0 && <div className="text-[11.5px] text-fg-faint">Drag from a column to another table's column in the diagram, or add one here.</div>}
          {table.foreignKeys.map((fk) => {
            const target = refTable(fk.refTable)
            const update = (patch: Partial<typeof fk>) => set({ foreignKeys: table.foreignKeys.map((f) => (f.id === fk.id ? { ...f, ...patch } : f)) })
            return (
              <div key={fk.id} className="mb-1 flex flex-col gap-1 rounded-md border border-line bg-bg p-1.5">
                <div className="flex items-center gap-1">
                  <Select inputSize="sm" className="h-6 flex-1 text-[12px]" value={fk.columns[0]} onChange={(e) => update({ columns: [e.target.value] })}>
                    {table.columns.map((c) => (
                      <option key={c.id}>{c.name}</option>
                    ))}
                  </Select>
                  <ArrowRight size={12} className="shrink-0 text-fg-faint" />
                  <Select
                    inputSize="sm"
                    className="h-6 flex-1 text-[12px]"
                    value={fk.refTable}
                    onChange={(e) => {
                      const t = refTable(e.target.value)
                      update({ refTable: e.target.value, refSchema: t?.schema, refColumns: [t?.primaryKey[0] ?? t?.columns[0]?.name ?? ''] })
                    }}
                  >
                    {allTables.map((t) => (
                      <option key={`${t.schema}.${t.name}`}>{t.name}</option>
                    ))}
                  </Select>
                  <Select inputSize="sm" className="h-6 w-24 text-[12px]" value={fk.refColumns[0]} onChange={(e) => update({ refColumns: [e.target.value] })}>
                    {(target?.columns ?? []).map((c) => (
                      <option key={c.name}>{c.name}</option>
                    ))}
                  </Select>
                  <IconButton label="Delete foreign key" onClick={() => set({ foreignKeys: table.foreignKeys.filter((f) => f.id !== fk.id) })}>
                    <Trash2 size={12} />
                  </IconButton>
                </div>
                <div className="flex items-center gap-1.5 pl-1 text-[11px] text-fg-muted">
                  on delete
                  <Select inputSize="sm" className="h-5 w-28 text-[11px]" value={fk.onDelete ?? 'NO ACTION'} onChange={(e) => update({ onDelete: e.target.value })}>
                    {FK_ACTIONS.map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </Select>
                  {fk.columns.length > 1 && <span>({fk.columns.join(', ')} → {fk.refColumns.join(', ')})</span>}
                </div>
              </div>
            )
          })}
        </Section>

        <Section title="Indexes" onAdd={() => set({ indexes: [...table.indexes, { id: designId('i'), columns: [table.columns[0]?.name ?? ''], unique: false }] })}>
          {table.indexes.map((ix) => {
            const update = (patch: Partial<typeof ix>) => set({ indexes: table.indexes.map((i) => (i.id === ix.id ? { ...i, ...patch } : i)) })
            return (
              <div key={ix.id} className="mb-1 flex items-center gap-1 rounded-md border border-line bg-bg p-1.5">
                <Input
                  inputSize="sm"
                  className="h-6 flex-1 font-mono text-[12px]"
                  value={ix.columns.join(', ')}
                  onChange={(e) => update({ columns: e.target.value.split(',').map((x) => x.trim()) })}
                  title="Columns, comma separated"
                />
                <Checkbox checked={ix.unique} onChange={(unique) => update({ unique })} label={<span className="text-[11.5px]">unique</span>} />
                <IconButton label="Delete index" onClick={() => set({ indexes: table.indexes.filter((i) => i.id !== ix.id) })}>
                  <Trash2 size={12} />
                </IconButton>
              </div>
            )
          })}
        </Section>
      </div>
      <div className="border-t border-line p-2">
        {table.dropped ? (
          <Button className="w-full" onClick={() => set({ dropped: false })}>
            Keep this table
          </Button>
        ) : (
          <Button className="w-full" variant="ghost" icon={<Trash2 size={13} />} onClick={() => set({ dropped: true })}>
            {table.originalName ? 'Drop table' : 'Remove new table'}
          </Button>
        )}
      </div>
    </div>
  )
}

function Section({ title, onAdd, children }: { title: string; onAdd: () => void; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold tracking-wide text-fg-faint uppercase">{title}</span>
        <Button size="xs" variant="ghost" icon={<Plus size={11} />} onClick={onAdd}>
          Add
        </Button>
      </div>
      {children}
    </div>
  )
}

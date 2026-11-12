import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, KeyRound, Package, Plus, Trash2 } from 'lucide-react'
import { attributePackages, COMMON_TYPES, createScript, designId, designToTableInfo, getDialect, leavesPackage, packageColumnsFor, type DesignTable, type DezignLabel, type DezignUserProperty, type DriverId, type TableInfo } from '@dbmastermind/core/browser'
import { Button, IconButton } from '@/components/ui/Button'
import { Checkbox, Input, Segmented, Select, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { LabelsPicker } from './LabelsPicker'
import { PropertiesEditor } from './PropertiesEditor'
import { TableEditor } from './TableEditor'

type Tab = 'columns' | 'keys' | 'relationships' | 'description' | 'properties' | 'sql'

/**
 * A table of a model edited as in DeZign's entity dialog: its columns in a grid (one row each, the selected one's
 * details below), its keys and indexes, relationships, description and the SQL it makes. Nothing changes until OK.
 */
export function TableDialog({
  table: given,
  driver,
  allTables,
  domains,
  userProperties = [],
  labels = [],
  onApply,
  onClose,
}: {
  table: DesignTable
  driver: DriverId
  allTables: TableInfo[]
  domains?: { name: string; dataType: string }[]
  /** The custom properties the project defines (DeZign's user defined properties). */
  userProperties?: DezignUserProperty[]
  /** The labels the project defines (DeZign's labels). */
  labels?: DezignLabel[]
  onApply: (table: DesignTable) => void
  onClose: () => void
}) {
  const tr = useT()
  const [table, setTable] = useState(given)
  const [tab, setTab] = useState<Tab>('columns')
  const [current, setCurrent] = useState(given.columns[0]?.id)
  const set = (patch: Partial<DesignTable>) => setTable((t) => ({ ...t, ...patch }))
  const types = COMMON_TYPES[driver]
  const textType = types.find((t) => /char|text/i.test(t)) ?? types[0] ?? 'text'
  // The named types the model's columns follow, and the project's own.
  const domainTypes = useMemo(
    () => [...new Map([...allTables.flatMap((t) => t.columns.filter((c) => c.domain).map((c) => [c.domain!, c.dataType] as const)), ...(domains ?? []).map((d) => [d.name, d.dataType] as const)]).entries()].sort(([a], [b]) => a.localeCompare(b)),
    [allTables, domains],
  )
  const setColumn = (id: string, patch: Partial<DesignTable['columns'][number]>) =>
    setTable((t) => {
      const old = t.columns.find((c) => c.id === id)!
      // A column given its own type no longer follows the domain it had.
      if (patch.dataType !== undefined && patch.dataType !== old.dataType && old.domain && !('domain' in patch)) patch = { ...patch, domain: undefined }
      // So does one whose name or definition changed its attribute package (the package decides them).
      if (leavesPackage(old, patch)) patch = { ...patch, package: undefined }
      const rename = (name: string) => (patch.name && name === old.name ? patch.name : name)
      return {
        ...t,
        columns: t.columns.map((c) => (c.id === id ? { ...c, ...patch } : c)),
        primaryKey: t.primaryKey.map(rename),
        foreignKeys: t.foreignKeys.map((f) => ({ ...f, columns: f.columns.map(rename) })),
        indexes: t.indexes.map((i) => ({ ...i, columns: i.columns.map(rename) })),
      }
    })
  const togglePk = (name: string) => set({ primaryKey: table.primaryKey.includes(name) ? table.primaryKey.filter((c) => c !== name) : [...table.primaryKey, name] })
  const move = (id: string, by: -1 | 1) => {
    const from = table.columns.findIndex((c) => c.id === id)
    const to = from + by
    if (from === -1 || to < 0 || to >= table.columns.length) return
    const columns = [...table.columns]
    columns.splice(to, 0, ...columns.splice(from, 1))
    set({ columns })
  }
  const remove = (id: string) => {
    const c = table.columns.find((x) => x.id === id)!
    set({
      columns: table.columns.filter((x) => x.id !== id),
      primaryKey: table.primaryKey.filter((x) => x !== c.name),
      foreignKeys: table.foreignKeys.filter((f) => !f.columns.includes(c.name)),
      indexes: table.indexes.filter((i) => !i.columns.includes(c.name)),
    })
    if (current === id) setCurrent(table.columns.find((x) => x.id !== id)?.id)
  }
  const add = () => {
    const id = designId('c')
    set({ columns: [...table.columns, { id, name: `column_${table.columns.length + 1}`, dataType: textType, nullable: true }] })
    setCurrent(id)
  }
  // The attribute packages the model's columns come from (DeZign): a package is put into a table whole.
  const packages = useMemo(() => attributePackages(allTables), [allTables])
  const addPackage = (name: string) => {
    const pkg = packages.find((p) => p.name === name)
    if (!pkg) return
    const added = packageColumnsFor(table, pkg).map((c) => ({ id: designId('c'), name: c.name, dataType: c.dataType, nullable: c.nullable, defaultValue: c.defaultValue ?? null, identity: c.isIdentity, comment: c.comment ?? null, ...(c.domain ? { domain: c.domain } : {}), ...(c.collation ? { collation: c.collation } : {}), ...(c.remarks ? { remarks: c.remarks } : {}), package: pkg.name }))
    if (!added.length) return
    set({ columns: [...table.columns, ...added] })
    setCurrent(added[0]!.id)
  }
  const selected = table.columns.find((c) => c.id === current)
  const fkColumns = new Set(table.foreignKeys.flatMap((f) => f.columns))
  const sql = useMemo(() => {
    try {
      return createScript([designToTableInfo(table)], getDialect(driver))
    } catch (err) {
      return `-- ${err instanceof Error ? err.message : String(err)}`
    }
  }, [table, driver])
  const cell = 'h-6 border-transparent bg-transparent px-1 font-mono text-[12px] hover:border-line focus:border-accent'

  return (
    <Modal
      open
      onClose={onClose}
      title={`${tr('Table')} ${table.schema ? `${table.schema}.` : ''}${table.name}`}
      width={960}
      footer={
        <>
          <div className="flex-1" />
          <Button onClick={onClose}>{tr('Cancel')}</Button>
          <Button variant="primary" disabled={!table.name.trim() || table.columns.some((c) => !c.name.trim() || !c.dataType.trim())} onClick={() => onApply(table)} data-testid="table-dialog-ok">
            OK
          </Button>
        </>
      }
    >
      <div className="mb-3 flex items-end gap-2">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-[11.5px] font-medium text-fg-muted">{tr('Name')}</span>
          <Input inputSize="sm" value={table.name} onChange={(e) => set({ name: e.target.value })} data-testid="table-dialog-name" />
        </label>
        <label className="flex w-40 flex-col gap-1">
          <span className="text-[11.5px] font-medium text-fg-muted">{tr('Schema')}</span>
          <Input inputSize="sm" value={table.schema ?? ''} onChange={(e) => set({ schema: e.target.value.trim() || undefined })} />
        </label>
      </div>
      <div className="mb-2">
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: 'columns', label: `${tr('Columns')} (${table.columns.length})` },
            { value: 'keys', label: `${tr('Indexes')} · ${tr('Checks')}` },
            { value: 'relationships', label: `${tr('Foreign keys')} (${table.foreignKeys.length})` },
            { value: 'description', label: tr('Description') },
            ...(userProperties.some((d) => d.objectTypes.some((x) => /^entity$/i.test(x))) ? [{ value: 'properties' as const, label: tr('Properties') }] : []),
            { value: 'sql', label: 'SQL' },
          ]}
        />
      </div>
      <div className="h-[52vh] min-h-[320px] overflow-auto">
        {tab === 'columns' && (
          <div className="flex h-full flex-col gap-2">
            <div className="min-h-0 flex-1 overflow-auto rounded-md border border-line">
              <table className="w-full border-collapse text-[12px]" data-testid="table-dialog-grid">
                <thead className="sticky top-0 z-10 bg-subtle text-left text-[11px] text-fg-muted">
                  <tr>
                    <th className="w-9 px-1 py-1 font-medium">{tr('Key')}</th>
                    <th className="px-1 font-medium">{tr('Name')}</th>
                    <th className="w-44 px-1 font-medium">{tr('Data type')}</th>
                    <th className="w-14 px-1 text-center font-medium">NOT NULL</th>
                    <th className="w-12 px-1 text-center font-medium" title={tr('auto-increment')}>
                      {tr('Auto')}
                    </th>
                    <th className="w-32 px-1 font-medium">{tr('Default')}</th>
                    {domainTypes.length > 0 && <th className="w-32 px-1 font-medium">{tr('Domain')}</th>}
                    <th className="px-1 font-medium">{tr('Comment')}</th>
                    <th className="w-[76px]" />
                  </tr>
                </thead>
                <tbody>
                  {table.columns.map((c) => (
                    <tr key={c.id} className={cn('border-t border-line', c.id === current && 'bg-accent-soft')} onFocusCapture={() => setCurrent(c.id)} onClick={() => setCurrent(c.id)}>
                      <td className="px-1">
                        <button type="button" onClick={() => togglePk(c.name)} title={table.primaryKey.includes(c.name) ? tr('Remove from primary key') : tr('Add to primary key')} className={cn('flex h-6 items-center gap-0.5 rounded px-0.5 text-[10px] font-semibold', table.primaryKey.includes(c.name) ? 'text-warning' : 'text-fg-faint hover:text-fg')}>
                          <KeyRound size={11} />
                          {table.primaryKey.includes(c.name) && fkColumns.has(c.name) ? 'PF' : table.primaryKey.includes(c.name) ? 'PK' : fkColumns.has(c.name) ? 'FK' : ''}
                        </button>
                      </td>
                      <td className="px-0.5">
                        <div className="flex items-center">
                          <Input inputSize="sm" className={cn(cell, 'w-full')} value={c.name} onChange={(e) => setColumn(c.id, { name: e.target.value })} data-testid={`grid-name-${c.name}`} />
                          {c.package && (
                            <span className="ml-0.5 flex shrink-0 items-center gap-0.5 rounded bg-subtle px-1 text-[10.5px] text-fg-muted" title={tr('From the attribute package {name}', { name: c.package })} data-testid={`grid-package-${c.name}`}>
                              <Package size={10} />
                              {c.package}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-0.5">
                        <Input inputSize="sm" className={cn(cell, 'w-full')} list="dbm-dialog-types" value={c.dataType} onChange={(e) => setColumn(c.id, { dataType: e.target.value })} data-testid={`grid-type-${c.name}`} />
                      </td>
                      <td className="text-center">
                        <Checkbox checked={!c.nullable} onChange={(v) => setColumn(c.id, { nullable: !v })} label={<span className="sr-only">NOT NULL</span>} />
                      </td>
                      <td className="text-center">
                        <Checkbox checked={!!c.identity} onChange={(v) => setColumn(c.id, { identity: v })} label={<span className="sr-only">{tr('auto-increment')}</span>} />
                      </td>
                      <td className="px-0.5">
                        <Input inputSize="sm" className={cn(cell, 'w-full')} value={c.defaultValue ?? ''} onChange={(e) => setColumn(c.id, { defaultValue: e.target.value || null })} />
                      </td>
                      {domainTypes.length > 0 && (
                        <td className="px-0.5">
                          <Select
                            inputSize="sm"
                            className="h-6 w-full text-[11.5px]"
                            value={c.domain ?? ''}
                            onChange={(e) => {
                              const picked = domainTypes.find(([name]) => name === e.target.value)
                              setColumn(c.id, picked ? { domain: picked[0], dataType: picked[1] } : { domain: undefined })
                            }}
                          >
                            <option value="">{tr('own type')}</option>
                            {domainTypes.map(([name]) => (
                              <option key={name}>{name}</option>
                            ))}
                          </Select>
                        </td>
                      )}
                      <td className="px-0.5">
                        <Input inputSize="sm" className={cn(cell, 'w-full font-sans')} value={c.comment ?? ''} onChange={(e) => setColumn(c.id, { comment: e.target.value || null })} />
                      </td>
                      <td className="whitespace-nowrap px-0.5">
                        <IconButton label={tr('Move up')} onClick={() => move(c.id, -1)}>
                          <ArrowUp size={12} />
                        </IconButton>
                        <IconButton label={tr('Move down')} onClick={() => move(c.id, 1)}>
                          <ArrowDown size={12} />
                        </IconButton>
                        <IconButton label={tr('Delete column')} onClick={() => remove(c.id)}>
                          <Trash2 size={12} />
                        </IconButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <datalist id="dbm-dialog-types">
                {types.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </div>
            <div className="flex items-start gap-3">
              <div className="flex flex-col gap-1.5">
                <Button size="sm" icon={<Plus size={12} />} onClick={add} data-testid="table-dialog-add-column">
                  {tr('Add column')}
                </Button>
                {packages.length > 0 && (
                  <Select inputSize="sm" className="h-7 w-40 text-[12px]" value="" onChange={(e) => addPackage(e.target.value)} title={tr('Put the columns of an attribute package into the table, as DeZign does')} data-testid="table-dialog-add-package">
                    <option value="">{tr('Add a package…')}</option>
                    {packages.map((p) => (
                      <option key={p.name} value={p.name} disabled={!packageColumnsFor(table, p).length}>
                        {p.name} ({p.columns.map((c) => c.name).join(', ')})
                      </option>
                    ))}
                  </Select>
                )}
              </div>
              {selected && (
                // What the grid has no room for, of the selected column (DeZign: the properties under the grid).
                <div className="flex flex-1 items-start gap-2 rounded-md border border-line bg-subtle p-2">
                  <div className="flex flex-col gap-1 pt-1">
                    <span className="font-mono text-[12px] font-semibold">{selected.name}</span>
                    {selected.package && (
                      // DeZign keeps a package's columns as the package says; editing one makes it the table's own.
                      <span className="flex max-w-48 flex-col gap-1 text-[11px] text-fg-muted">
                        {tr('From the attribute package {name}: a changed name or definition makes it the table’s own.', { name: selected.package })}
                        <Button size="sm" variant="ghost" className="self-start" onClick={() => setColumn(selected.id, { package: undefined })} data-testid="table-dialog-leave-package">
                          {tr('Make it the table’s own')}
                        </Button>
                      </span>
                    )}
                  </div>
                  <label className="flex flex-1 flex-col gap-0.5">
                    <span className="text-[11px] text-fg-muted" title={tr('Notes kept with the model (DeZign: Notes); never in a script')}>
                      {tr('Notes')}
                    </span>
                    <Textarea rows={2} className="resize-y text-[12px]" value={selected.remarks ?? ''} onChange={(e) => setColumn(selected.id, { remarks: e.target.value || undefined })} />
                  </label>
                  <label className="flex w-44 flex-col gap-0.5">
                    <span className="text-[11px] text-fg-muted">{tr('To do')}</span>
                    <Textarea rows={2} className="resize-y text-[12px]" value={selected.todo ?? ''} onChange={(e) => setColumn(selected.id, { todo: e.target.value || undefined })} data-testid="column-todo" />
                  </label>
                  {labels.length > 0 && (
                    <label className="flex w-56 shrink-0 flex-col gap-0.5">
                      <span className="text-[11px] text-fg-muted">{tr('Labels')}</span>
                      <LabelsPicker labels={labels} value={selected.labels} onChange={(l) => setColumn(selected.id, { labels: l })} testId="column-labels" />
                    </label>
                  )}
                  {userProperties.some((d) => d.objectTypes.some((x) => /^attribute$/i.test(x))) && (
                    <div className="w-72 shrink-0">
                      <PropertiesEditor definitions={userProperties} objectType="Attribute" values={selected.properties} onChange={(properties) => setColumn(selected.id, { properties })} compact />
                    </div>
                  )}
                  <label className="flex w-44 flex-col gap-0.5">
                    <span className="text-[11px] text-fg-muted">{tr('collation')}</span>
                    <Input inputSize="sm" className="font-mono text-[12px]" value={selected.collation ?? ''} onChange={(e) => setColumn(selected.id, { collation: e.target.value.trim() || undefined })} />
                  </label>
                </div>
              )}
            </div>
          </div>
        )}
        {tab === 'keys' && <TableEditor table={table} driver={driver} allTables={allTables} model domains={domains} onChange={setTable} onClose={onClose} only={['indexes', 'checks']} />}
        {tab === 'relationships' && <TableEditor table={table} driver={driver} allTables={allTables} model domains={domains} onChange={setTable} onClose={onClose} only={['foreignKeys']} />}
        {tab === 'description' && (
          <div className="flex flex-col gap-3">
            {labels.length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="text-[11.5px] font-medium text-fg-muted">{tr('Labels')}</span>
                <LabelsPicker labels={labels} value={table.labels} onChange={(l) => set({ labels: l })} testId="table-labels" />
              </div>
            )}
            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] font-medium text-fg-muted">{tr('Comment')}</span>
              <Textarea rows={6} className="text-[12.5px]" value={table.comment ?? ''} onChange={(e) => set({ comment: e.target.value || null })} placeholder={tr('What is stored here')} data-testid="table-dialog-comment" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] font-medium text-fg-muted" title={tr('Notes kept with the model (DeZign: Notes); never in a script')}>
                {tr('Notes')}
              </span>
              <Textarea rows={6} className="text-[12.5px]" value={table.remarks ?? ''} onChange={(e) => set({ remarks: e.target.value || undefined })} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] font-medium text-fg-muted" title={tr('What is still to be done (DeZign: To do); listed in the object browser')}>
                {tr('To do')}
              </span>
              <Textarea rows={3} className="text-[12.5px]" value={table.todo ?? ''} onChange={(e) => set({ todo: e.target.value || undefined })} data-testid="table-todo" />
            </label>
          </div>
        )}
        {tab === 'properties' && (
          <div className="max-w-xl pt-1">
            <PropertiesEditor definitions={userProperties} objectType="Entity" values={table.properties} onChange={(properties) => set({ properties })} />
          </div>
        )}
        {tab === 'sql' && <pre className="h-full overflow-auto rounded-md border border-line bg-subtle p-3 font-mono text-[12px] whitespace-pre" data-testid="table-dialog-sql">{sql}</pre>}
      </div>
    </Modal>
  )
}

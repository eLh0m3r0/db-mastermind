import { useMemo, useState } from 'react'
import { ArrowRight, GitCompare, Minus, Pencil, Plus } from 'lucide-react'
import { compareSchemas, generateMigration, getDialect, migrationScript, parseDbml, type SchemaChange, type SchemaSnapshot } from '@dbmastermind/core/browser'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Checkbox, Select } from '@/components/ui/Input'
import { useT } from '@/lib/i18n'
import { cn, errorMessage } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { toast } from '@/store/ui'
import { useWorkspace, type CompareTab } from '@/store/workspace'
import { DriverIcon } from '../connections/drivers'

function changeTable(c: SchemaChange): string {
  return c.kind === 'create_table' ? c.table.name : c.table.name
}

function describe(c: SchemaChange, t: ReturnType<typeof useT>): { icon: 'add' | 'drop' | 'edit'; text: string } {
  switch (c.kind) {
    case 'create_table':
      return { icon: 'add', text: t('Create table') }
    case 'drop_table':
      return { icon: 'drop', text: t('Drop table') }
    case 'add_column':
      return { icon: 'add', text: `${t('Add column')} ${c.column.name} ${c.column.dataType}` }
    case 'drop_column':
      return { icon: 'drop', text: `${t('Drop column')} ${c.column}` }
    case 'rename_column':
      return { icon: 'edit', text: `${t('Rename column')} ${c.column} → ${c.newName}` }
    case 'alter_column':
      return { icon: 'edit', text: `${t('Change column')} ${c.column}: ${c.before.dataType}${c.before.nullable ? '' : ' NOT NULL'} → ${c.after.dataType}${c.after.nullable ? '' : ' NOT NULL'}` }
    case 'add_foreign_key':
      return { icon: 'add', text: `${t('Add foreign key')} (${c.fk.columns.join(', ')}) → ${c.fk.refTable}` }
    case 'drop_foreign_key':
      return { icon: 'drop', text: `${t('Drop foreign key')} ${c.name}` }
    case 'add_index':
      return { icon: 'add', text: `${t('Add index')} (${c.index.columns.join(', ')})${c.index.unique ? ' UNIQUE' : ''}` }
    case 'drop_index':
      return { icon: 'drop', text: `${t('Drop index')} ${c.name}` }
    case 'set_primary_key':
      return { icon: 'edit', text: `${t('Primary key')} (${c.before.join(', ')}) → (${c.columns.join(', ')})` }
    case 'rename_table':
      return { icon: 'edit', text: `${t('Rename table')} → ${c.newName}` }
    case 'set_table_comment':
      return { icon: 'edit', text: t('Change table comment') }
  }
}

/** Compares two schemas (e.g. dev → prod) and generates the migration for the target. */
export function CompareView({ tab }: { tab: CompareTab }) {
  const t = useT()
  const connections = useConnections((s) => s.list)
  const loadSchema = useConnections((s) => s.loadSchema)
  const connect = useConnections((s) => s.connect)
  const updateTab = useWorkspace((s) => s.update)
  const newQuery = useWorkspace((s) => s.newQuery)
  const [snapshots, setSnapshots] = useState<{ source: SchemaSnapshot; target: SchemaSnapshot } | null>(null)
  const [busy, setBusy] = useState(false)
  const [keepExtra, setKeepExtra] = useState(true)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())

  const sourceSchemas = useConnections((s) => (tab.sourceId ? s.runtime[tab.sourceId]?.schema?.schemas : undefined))
  const targetSchemas = useConnections((s) => s.runtime[tab.connectionId]?.schema?.schemas)
  const target = connections.find((c) => c.id === tab.connectionId)
  const source = connections.find((c) => c.id === tab.sourceId)
  const crossEngine = !!source && !!target && source.driver !== target.driver

  const run = async () => {
    if (!tab.sourceId && tab.sourceModel === undefined) return
    setBusy(true)
    try {
      if (tab.sourceModel !== undefined) {
        await connect(tab.connectionId)
        const targetSnap = await loadSchema(tab.connectionId, true)
        if (!targetSnap) throw new Error(t('Could not read both schemas'))
        const model = parseDbml(tab.sourceModel, { defaultSchema: targetSnap.defaultSchema, enumType: target?.driver === 'mssql' ? 'nvarchar(50)' : target?.driver === 'oracle' ? 'VARCHAR2(50)' : 'varchar(50)' })
        if (model.errors.length) throw new Error(model.errors.map((e) => `${t('line {n}', { n: String(e.line) })}: ${e.message}`).join('\n'))
        const schemas = [...new Set(model.tables.map((x) => x.schema ?? ''))]
        setSnapshots({ source: { tables: model.tables, schemas, routines: [], defaultSchema: targetSnap.defaultSchema, capturedAt: '' }, target: targetSnap })
        setExcluded(new Set())
        return
      }
      if (!tab.sourceId) return
      await Promise.all([connect(tab.sourceId), connect(tab.connectionId)])
      const [source, targetSnap] = await Promise.all([loadSchema(tab.sourceId, true), loadSchema(tab.connectionId, true)])
      if (!source || !targetSnap) throw new Error(t('Could not read both schemas'))
      setSnapshots({ source, target: targetSnap })
      setExcluded(new Set())
    } catch (err) {
      toast({ kind: 'error', message: t('Compare failed'), detail: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  const changes = useMemo(() => {
    if (!snapshots) return []
    const pick = (snap: SchemaSnapshot, schema?: string) => snap.tables.filter((x) => !schema || (x.schema ?? '') === schema)
    return compareSchemas(pick(snapshots.source, tab.sourceSchema), pick(snapshots.target, tab.targetSchema), { keepExtra })
  }, [snapshots, tab.sourceSchema, tab.targetSchema, keepExtra])

  const byTable = useMemo(() => {
    const map = new Map<string, SchemaChange[]>()
    for (const c of changes) map.set(changeTable(c), [...(map.get(changeTable(c)) ?? []), c])
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [changes])

  const selected = changes.filter((c) => !excluded.has(changeTable(c)))
  const script = useMemo(() => {
    if (!target || !snapshots || !selected.length) return ''
    const dialect = getDialect(target.driver)
    return migrationScript(generateMigration(selected, dialect, snapshots.target.tables), dialect)
  }, [selected, target, snapshots])

  const pickConnection = (id: string, side: 'source' | 'target') =>
    updateTab(tab.id, side === 'source' ? { sourceId: id, sourceSchema: undefined } : { connectionId: id, targetSchema: undefined })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <GitCompare size={15} className="text-accent" />
        {tab.sourceModel !== undefined ? (
          <span className="rounded-md bg-accent-soft px-2 py-1 text-[12px] font-medium text-accent">{t('Model (DBML)')}</span>
        ) : (
          <Select inputSize="sm" className="w-52" value={tab.sourceId ?? ''} onChange={(e) => pickConnection(e.target.value, 'source')}>
            <option value="">{t('Source…')}</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
        {tab.sourceModel === undefined && sourceSchemas && sourceSchemas.length > 1 && (
          <Select inputSize="sm" className="w-36" value={tab.sourceSchema ?? ''} onChange={(e) => updateTab(tab.id, { sourceSchema: e.target.value || undefined })}>
            <option value="">{t('All schemas')}</option>
            {sourceSchemas.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        )}
        <ArrowRight size={14} className="text-fg-faint" />
        <Select inputSize="sm" className="w-52" value={tab.connectionId} onChange={(e) => pickConnection(e.target.value, 'target')}>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        {targetSchemas && targetSchemas.length > 1 && (
          <Select inputSize="sm" className="w-36" value={tab.targetSchema ?? ''} onChange={(e) => updateTab(tab.id, { targetSchema: e.target.value || undefined })}>
            <option value="">{t('All schemas')}</option>
            {targetSchemas.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        )}
        <Button size="sm" variant="primary" loading={busy} disabled={!tab.sourceId && tab.sourceModel === undefined} onClick={() => void run()}>
          {t('Compare')}
        </Button>
        <Checkbox checked={!keepExtra} onChange={(v) => setKeepExtra(!v)} label={t('Drop tables missing in source')} />
      </div>
      {crossEngine && snapshots && (
        <div className="shrink-0 border-b border-line bg-warning-soft px-3 py-1.5 text-[12px] text-warning">
          {t('These are different database engines: column types and defaults are written differently, so review the migration carefully.')}
        </div>
      )}
      {!snapshots ? (
        <EmptyState icon={<GitCompare size={28} />} title={t('Compare two schemas')}>
          {t('Pick the source (e.g. development) and the target (e.g. production). DB Mastermind lists the differences and writes the migration that brings the target in line.')}
        </EmptyState>
      ) : changes.length === 0 ? (
        <EmptyState icon={<GitCompare size={28} />} title={t('The schemas are identical')} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="w-[46%] min-w-[320px] overflow-auto border-r border-line p-2">
            {byTable.map(([table, list]) => (
              <div key={table} className={cn('mb-2 rounded-md border border-line', excluded.has(table) && 'opacity-50')}>
                <div className="flex items-center gap-2 border-b border-line bg-subtle px-2 py-1.5">
                  <input
                    type="checkbox"
                    className="accent-[var(--accent)]"
                    checked={!excluded.has(table)}
                    onChange={(e) =>
                      setExcluded((prev) => {
                        const next = new Set(prev)
                        if (e.target.checked) next.delete(table)
                        else next.add(table)
                        return next
                      })
                    }
                  />
                  <span className="text-[12.5px] font-semibold">{table}</span>
                  <span className="ml-auto text-[11px] text-fg-faint">{list.length}</span>
                </div>
                {list.map((c, i) => {
                  const d = describe(c, t)
                  const Icon = d.icon === 'add' ? Plus : d.icon === 'drop' ? Minus : Pencil
                  return (
                    <div key={i} className="flex items-center gap-2 px-2 py-1 text-[12px]">
                      <Icon size={12} className={cn('shrink-0', d.icon === 'add' ? 'text-success' : d.icon === 'drop' ? 'text-danger' : 'text-warning')} />
                      <span className="truncate font-mono text-[11.5px]">{d.text}</span>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3 text-[12px]">
              {target && <DriverIcon driver={target.driver} size={14} />}
              <span className="font-medium">{t('Migration for {name}', { name: target?.name ?? '' })}</span>
              <div className="flex-1" />
              <Button size="xs" variant="primary" disabled={!script} onClick={() => newQuery(tab.connectionId, script, t('Migration'))}>
                {t('Open in SQL editor')}
              </Button>
            </div>
            <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap select-text">{script}</pre>
          </div>
        </div>
      )}
    </div>
  )
}

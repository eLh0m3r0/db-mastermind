import { useMemo, useState } from 'react'
import { ArrowRight, GitCompare, Minus, Pencil, Plus } from 'lucide-react'
import { compareSchemas, dezignMigrationOptions, dezignWrapScript, findChangedChecks, generateMigration, getDialect, guessRenames, migrationScript, parseDbml, translateTables, unquotedNames, type SchemaChange, type SchemaSnapshot } from '@dbmastermind/core/browser'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Checkbox, Select } from '@/components/ui/Input'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { cn, errorMessage } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { toast } from '@/store/ui'
import { useWorkspace, type CompareTab } from '@/store/workspace'
import { DriverIcon } from '../connections/drivers'
import { modelTabFromFile } from '../model/open-model'
import { describeChange as describe } from '@/lib/schemaChanges'

function changeTable(c: SchemaChange): string {
  return c.kind === 'create_table' ? c.table.name : c.table.name
}

/** Compares two schemas (e.g. dev → prod) and generates the migration for the target. */
export function CompareView({ tab }: { tab: CompareTab }) {
  const t = useT()
  const connections = useConnections((s) => s.list)
  const loadSchema = useConnections((s) => s.loadSchema)
  const connect = useConnections((s) => s.connect)
  const updateTab = useWorkspace((s) => s.update)
  const newQuery = useWorkspace((s) => s.newQuery)
  const openTab = useWorkspace((s) => s.open)
  const [snapshots, setSnapshots] = useState<{ source: SchemaSnapshot; target: SchemaSnapshot; checkChanged?: (table: { schema?: string; name: string }, name: string) => boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [keepExtra, setKeepExtra] = useState(true)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  // Single changes left out of the script (as in DeZign's list of differences), by table and what they say.
  const [skipped, setSkipped] = useState<Set<string>>(new Set())
  const changeKey = (c: SchemaChange) => `${changeTable(c)}|${describe(c, t).text}`
  // Renames the comparison guessed and the user said are not renames.
  const [declined, setDeclined] = useState<Set<string>>(new Set())

  const sourceSchemas = useConnections((s) => (tab.sourceId ? s.runtime[tab.sourceId]?.schema?.schemas : undefined))
  const targetSchemas = useConnections((s) => s.runtime[tab.connectionId]?.schema?.schemas)
  const target = connections.find((c) => c.id === tab.connectionId)
  const source = connections.find((c) => c.id === tab.sourceId)
  const crossEngine = !!source && !!target && source.driver !== target.driver
  // Two models need no database: the script is for the project's own (or the one connected).
  const driver = target?.driver ?? tab.targetDriver

  // An archived version, to look at as it was (DeZign: switch to an archived version). Its own tab, not tied to the
  // project: saving it never writes into the project.
  const openVersion = async (version: { path: string; id: string }) => {
    try {
      const file = await api.openModelVersion(version.path, version.id)
      const defaultSchema = useConnections.getState().runtime[tab.connectionId]?.schema?.defaultSchema
      openTab({ kind: 'model', connectionId: tab.connectionId, ...modelTabFromFile(file, defaultSchema, { quiet: true }), source: undefined, path: undefined, title: tab.targetLabel ?? t('Model') }, { reuse: false })
    } catch (err) {
      toast({ kind: 'error', message: t('Could not open the model'), detail: errorMessage(err) })
    }
  }

  const run = async () => {
    if (!tab.sourceId && tab.sourceModel === undefined) return
    setBusy(true)
    try {
      if (tab.sourceModel !== undefined && tab.targetModel !== undefined) {
        // Two versions of a model: enums stay named types on both sides.
        const read = (text: string, label: string) => {
          const m = parseDbml(text)
          if (m.errors.length) throw new Error(`${label}: ${m.errors.map((e) => `${t('line {n}', { n: String(e.line) })}: ${e.message}`).join('\n')}`)
          return { tables: m.tables, schemas: [...new Set(m.tables.map((x) => x.schema ?? ''))], routines: [], capturedAt: '' } as SchemaSnapshot
        }
        setSnapshots({ source: read(tab.sourceModel, t('Model (DBML)')), target: read(tab.targetModel, tab.targetLabel ?? 'DBML') })
        setExcluded(new Set())
        setSkipped(new Set())
        return
      }
      if (tab.sourceModel !== undefined) {
        await connect(tab.connectionId)
        const targetSnap = await loadSchema(tab.connectionId, true)
        if (!targetSnap) throw new Error(t('Could not read both schemas'))
        const model = parseDbml(tab.sourceModel, { defaultSchema: targetSnap.defaultSchema, enumType: target?.driver === 'mssql' ? 'nvarchar(50)' : target?.driver === 'oracle' ? 'VARCHAR2(50)' : 'varchar(50)' })
        if (model.errors.length) throw new Error(model.errors.map((e) => `${t('line {n}', { n: String(e.line) })}: ${e.message}`).join('\n'))
        // A DeZign project's names are the ones DeZign's own scripts create: bare, so PostgreSQL stores them in lower case.
        const tables = tab.sourceUnquoted && target ? unquotedNames(model.tables, target.driver) : model.tables
        const schemas = [...new Set(tables.map((x) => x.schema ?? ''))]
        // A check of the same name may have another condition in the model: the database says (it stores conditions rewritten).
        const checkChanged = await findChangedChecks(tables, targetSnap.tables, (items) => api.canonicalChecks(tab.connectionId, items)).catch(() => undefined)
        setSnapshots({ source: { tables, schemas, routines: [], defaultSchema: targetSnap.defaultSchema, capturedAt: '' }, target: targetSnap, checkChanged })
        setExcluded(new Set())
        setSkipped(new Set())
        return
      }
      if (!tab.sourceId) return
      await Promise.all([connect(tab.sourceId), connect(tab.connectionId)])
      const [source, targetSnap] = await Promise.all([loadSchema(tab.sourceId, true), loadSchema(tab.connectionId, true)])
      if (!source || !targetSnap) throw new Error(t('Could not read both schemas'))
      setSnapshots({ source, target: targetSnap })
      setExcluded(new Set())
      setSkipped(new Set())
    } catch (err) {
      toast({ kind: 'error', message: t('Compare failed'), detail: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  const sides = useMemo(() => {
    if (!snapshots) return null
    const pick = (snap: SchemaSnapshot, schema?: string) => snap.tables.filter((x) => !schema || (x.schema ?? '') === schema)
    // Across engines, source types are first written the target's way (boolean → bit, text → nvarchar(max)…).
    const source = pick(snapshots.source, tab.sourceSchema)
    return { source: crossEngine && target ? translateTables(source, target.driver) : source, target: pick(snapshots.target, tab.targetSchema) }
  }, [snapshots, tab.sourceSchema, tab.targetSchema, crossEngine, target])
  // A table or a column that is probably the same one under a new name: renamed (the data stays) unless declined.
  const guesses = useMemo(() => (sides ? guessRenames(sides.source, sides.target) : []), [sides])
  const guessKey = (g: (typeof guesses)[number]) => `${g.kind}:${g.table}:${g.from}:${g.to}`

  const changes = useMemo(() => {
    if (!snapshots || !sides) return []
    // A model names its schemas on purpose: its new tables go there unless a schema of the database was picked.
    return compareSchemas(sides.source, sides.target, { keepExtra, model: tab.sourceModel !== undefined && !tab.targetSchema, checkChanged: snapshots.checkChanged, renames: guesses.filter((g) => !declined.has(guessKey(g))) })
  }, [snapshots, sides, guesses, declined, tab.targetSchema, tab.sourceModel, keepExtra])

  const byTable = useMemo(() => {
    const map = new Map<string, SchemaChange[]>()
    for (const c of changes) map.set(changeTable(c), [...(map.get(changeTable(c)) ?? []), c])
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [changes])

  const selected = changes.filter((c) => !excluded.has(changeTable(c)) && !skipped.has(changeKey(c)))
  const script = useMemo(() => {
    if (!driver || !snapshots || !selected.length) return ''
    const dialect = getDialect(driver)
    // A DeZign project names its keys its own way (`PK_%table%`) and keeps its domains as types: the script follows.
    // Its own begin and end scripts for ALTER scripts go around it (Project options in DeZign).
    return dezignWrapScript(migrationScript(generateMigration(selected, dialect, snapshots.target.tables, dezignMigrationOptions(tab.sourceScripting, driver)), dialect), tab.sourceScripting, 'alter')
  }, [selected, driver, snapshots])

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
        {tab.targetModel !== undefined ? (
          <>
            <span className="rounded-md bg-subtle px-2 py-1 text-[12px] font-medium">{tab.targetLabel ?? 'DBML'}</span>
            {tab.targetVersion && (
              <Button size="sm" variant="ghost" onClick={() => void openVersion(tab.targetVersion!)} title={t('Opens the archived version as a model of its own; the project stays as it is')} data-testid="compare-open-version">
                {t('Open this version')}
              </Button>
            )}
          </>
        ) : (
        <Select inputSize="sm" className="w-52" value={tab.connectionId} onChange={(e) => pickConnection(e.target.value, 'target')}>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        )}
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
            {guesses.length > 0 && (
              <div className="mb-2 rounded-md border border-line bg-accent-soft px-2 py-1.5 text-[12px]" data-testid="compare-renames">
                <div className="mb-1 font-semibold">{t('Renamed, so the data stays. Untick what is really a new one and a dropped one:')}</div>
                {guesses.map((g) => (
                  <Checkbox
                    key={guessKey(g)}
                    checked={!declined.has(guessKey(g))}
                    onChange={(on) =>
                      setDeclined((prev) => {
                        const next = new Set(prev)
                        if (on) next.delete(guessKey(g))
                        else next.add(guessKey(g))
                        return next
                      })
                    }
                    label={<span className="font-mono text-[11.5px]">{g.kind === 'table' ? `${g.from} → ${g.to}` : `${g.table}.${g.from} → ${g.to}`}</span>}
                  />
                ))}
              </div>
            )}
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
                    <label key={i} className={cn('flex items-center gap-2 px-2 py-1 text-[12px]', skipped.has(changeKey(c)) && 'opacity-50')}>
                      {list.length > 1 && (
                        <input
                          type="checkbox"
                          className="accent-[var(--accent)]"
                          checked={!skipped.has(changeKey(c))}
                          disabled={excluded.has(table)}
                          onChange={(e) =>
                            setSkipped((prev) => {
                              const next = new Set(prev)
                              if (e.target.checked) next.delete(changeKey(c))
                              else next.add(changeKey(c))
                              return next
                            })
                          }
                          data-testid="compare-change"
                        />
                      )}
                      <Icon size={12} className={cn('shrink-0', d.icon === 'add' ? 'text-success' : d.icon === 'drop' ? 'text-danger' : 'text-warning')} />
                      <span className="truncate font-mono text-[11.5px]">{d.text}</span>
                    </label>
                  )
                })}
              </div>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3 text-[12px]">
              {driver && <DriverIcon driver={driver} size={14} />}
              <span className="font-medium">{t('Migration for {name}', { name: target?.name ?? tab.targetLabel ?? '' })}</span>
              <div className="flex-1" />
              {target ? (
                <Button size="xs" variant="primary" disabled={!script} onClick={() => newQuery(tab.connectionId, script, t('Migration'))}>
                  {t('Open in SQL editor')}
                </Button>
              ) : (
                // (No database to open it for: the script goes to a file.)
                <Button
                  size="xs"
                  variant="primary"
                  disabled={!script}
                  onClick={() => void api.saveSqlFile(script, 'migration.sql').then((path) => path && toast({ kind: 'success', message: t('Script saved'), detail: path }), (err) => toast({ kind: 'error', message: t('Could not save the script'), detail: errorMessage(err) }))}
                >
                  {t('Save script…')}
                </Button>
              )}
            </div>
            <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap select-text">{script}</pre>
          </div>
        </div>
      )}
    </div>
  )
}

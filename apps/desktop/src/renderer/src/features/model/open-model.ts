import { dezignDriver, type DezignChange, type DezignSqlObject } from '@dbmastermind/core/browser'
import type { OpenedModelFile } from '@shared/api'
import { t, tp } from '@/lib/i18n'
import { toast } from '@/store/ui'
import type { ModelTab } from '@/store/workspace'

const LEFT_OUT: [keyof NonNullable<OpenedModelFile['imported']>['leftOut'], string][] = [
  ['relationshipsWithoutColumns', 'relationships without columns: {n}'],
  ['objectNotes', 'notes of relationships (kept in the file): {n}'],
]

/**
 * What a model tab takes from an opened file. Another tool's model (DeZign for Databases) keeps its source and
 * layout: Save writes the changes back into that file, Save as makes a .dbml model of it.
 */
export function modelTabFromFile(file: OpenedModelFile, defaultSchema?: string, options: { /** No notice about what was opened (the caller says its own). */ quiet?: boolean } = {}): Pick<ModelTab, 'text' | 'path' | 'source' | 'dirty' | 'title' | 'positions' | 'diagrams' | 'colors' | 'notes' | 'boxes' | 'display' | 'removedDiagrams' | 'sqlObjects' | 'userProperties' | 'sqlDatabase' | 'scripting'> {
  const name = file.path.split(/[\\/]/).pop() ?? t('Model')
  if (!file.imported) return { text: file.text, path: file.path, source: undefined, dirty: false, title: name, positions: undefined, diagrams: undefined, colors: undefined, notes: undefined, boxes: undefined, display: undefined, removedDiagrams: undefined, sqlObjects: undefined, sqlDatabase: undefined, scripting: undefined }
  // Tables without a schema land in the connection's default schema when the DBML is read.
  const keyed = (key: string) => (key.startsWith('.') ? `${defaultSchema ?? ''}${key}` : key)
  const rekey = <T,>(map: Record<string, T> | undefined) => Object.fromEntries(Object.entries(map ?? {}).map(([key, v]) => [keyed(key), v]))
  const positions = rekey(file.imported.positions)
  // Hidden columns are kept by table key as well.
  const display = <T extends { hidden?: Record<string, string[]> } | undefined>(d: T): T => (d?.hidden ? { ...d, hidden: rekey(d.hidden) } : d)
  const diagrams = file.imported.diagrams.map((d) => ({ ...d, tables: d.tables.map(keyed), positions: rekey(d.positions), colors: rekey(d.colors), display: display(d.display) }))
  const colors = rekey(file.imported.colors)
  const leftOut = LEFT_OUT.filter(([key]) => file.imported!.leftOut[key] > 0).map(([key, label]) => t(label, { n: String(file.imported!.leftOut[key]) }))
  if (!options.quiet) toast({
    kind: leftOut.length ? 'warning' : 'success',
    message: tp(file.imported.tables, { one: 'Opened a DeZign for Databases model: {n} table', many: 'Opened a DeZign for Databases model: {n} tables' }),
    detail: [leftOut.length ? `${t('Not in the model yet:')} ${leftOut.join(' · ')}.` : '', file.imported.sqlObjects?.length ? t('Views, sequences, procedures and triggers of the project ({n}) go into the SQL DDL script as the project has them.', { n: String(file.imported.sqlObjects.length) }) : '', t('Save writes your changes back into the DeZign file (a backup is kept); Save as makes a .dbml model.')].filter(Boolean).join('\n'),
  })
  return { text: file.text, path: undefined, source: { kind: 'dezign', path: file.path, hash: file.imported.hash, layout: true }, dirty: false, title: name, display: display(file.imported.display), removedDiagrams: undefined, positions, diagrams: diagrams.length ? diagrams : undefined, colors: Object.keys(colors).length ? colors : undefined, notes: file.imported.notes.length ? file.imported.notes : undefined, boxes: file.imported.boxes?.length ? file.imported.boxes : undefined, sqlObjects: file.imported.sqlObjects?.length ? file.imported.sqlObjects : undefined, userProperties: file.imported.userProperties?.length ? file.imported.userProperties : undefined, sqlDatabase: file.imported.targetDatabase, scripting: file.imported.scripting }
}

const CHANGE_LABELS: Record<DezignChange['kind'], string> = {
  add_table: 'new table',
  drop_table: 'dropped table',
  rename_table: 'renamed table',
  alter_table: 'table comment',
  add_column: 'new column',
  drop_column: 'dropped column',
  rename_column: 'renamed column',
  alter_column: 'changed column',
  set_primary_key: 'primary key',
  add_index: 'new index',
  drop_index: 'dropped index',
  rename_index: 'renamed index',
  add_check: 'new check',
  drop_check: 'dropped check',
  rename_check: 'renamed check',
  add_relationship: 'new relationship',
  drop_relationship: 'dropped relationship',
  alter_relationship: 'changed relationship',
  rename_relationship: 'renamed foreign key',
  move_table: 'moved in the diagram',
  add_diagram: 'new diagram',
  add_to_diagram: 'added to diagram',
  remove_from_diagram: 'taken off diagram',
  alter_note: 'changed note',
  add_note: 'new note',
  drop_note: 'removed note',
  color_table: 'table color',
  diagram_display: 'what the tables show',
  add_domain: 'new domain',
  alter_domain: 'changed domain',
  rename_domain: 'renamed domain',
  drop_domain: 'removed domain',
  alter_view: 'changed view',
  alter_trigger: 'changed trigger',
  add_trigger: 'new trigger',
  drop_trigger: 'removed trigger',
  alter_procedure: 'changed procedure',
  add_procedure: 'new procedure',
  drop_procedure: 'removed procedure',
  add_sequence: 'new sequence',
  alter_sequence: 'changed sequence',
  drop_sequence: 'removed sequence',
  project_scripts: 'project script',
  add_box: 'new frame',
  drop_box: 'removed frame',
  alter_box: 'changed frame',
  rename_diagram: 'renamed diagram',
  drop_diagram: 'removed diagram',
}

/** One line per change for the confirmation before a model is written back to its DeZign file. */
export function describeDezignChanges(changes: DezignChange[], limit = 40): string[] {
  // (A column DeZign inherited from an attribute package is locked to the package there: changed here, it is the table's own.)
  const lines = changes.map((c) => `${t(CHANGE_LABELS[c.kind])}: ${c.table}${c.name ? ` (${c.name})` : ''}${c.detached ? ` · ${t('no longer follows the attribute package {name}', { name: c.detached })}` : ''}`)
  return lines.length > limit ? [...lines.slice(0, limit), t('… and {n} more', { n: String(lines.length - limit) })] : lines
}

/**
 * The source's views, sequences, procedures and triggers as a block for a DDL script. They are written in the
 * dialect of the project's own database: for another one they are left in as comments, to be rewritten by hand.
 */
export function sqlObjectsScript(objects: DezignSqlObject[] | undefined, database: string | undefined, driver: string): string {
  if (!objects?.length) return ''
  const own = dezignDriver(database)
  const same = !!own && (own === driver || (['mysql', 'mariadb'].includes(own) && ['mysql', 'mariadb'].includes(driver)))
  const order = ['sequence', 'view', 'procedure', 'trigger']
  const body = [...objects]
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
    .map((o) => `${o.sql};`)
    .join('\n\n')
  const head = same ? t('Views, sequences, procedures and triggers from the DeZign project') : t('Views, sequences, procedures and triggers from the DeZign project, written for {db}: rewrite them for this database', { db: database ?? '?' })
  return `\n\n-- ${head}\n${same ? body : body.split('\n').map((l) => `-- ${l}`).join('\n')}\n`
}

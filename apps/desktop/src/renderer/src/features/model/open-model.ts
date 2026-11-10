import type { DezignChange } from '@dbmastermind/core/browser'
import type { OpenedModelFile } from '@shared/api'
import { t, tp } from '@/lib/i18n'
import { toast } from '@/store/ui'
import type { ModelTab } from '@/store/workspace'

const LEFT_OUT: [keyof NonNullable<OpenedModelFile['imported']>['leftOut'], string][] = [
  ['domains', 'domains (their columns keep the base type): {n}'],
  ['views', 'views: {n}'],
  ['procedures', 'procedures: {n}'],
  ['sequences', 'sequences: {n}'],
  ['triggers', 'triggers: {n}'],
  ['relationshipsWithoutColumns', 'relationships without columns: {n}'],
]

/**
 * What a model tab takes from an opened file. Another tool's model (DeZign for Databases) keeps its source and
 * layout: Save writes the changes back into that file, Save as makes a .dbml model of it.
 */
export function modelTabFromFile(file: OpenedModelFile, defaultSchema?: string): Pick<ModelTab, 'text' | 'path' | 'source' | 'dirty' | 'title' | 'positions' | 'diagrams' | 'colors' | 'notes'> {
  const name = file.path.split(/[\\/]/).pop() ?? t('Model')
  if (!file.imported) return { text: file.text, path: file.path, source: undefined, dirty: false, title: name, positions: undefined, diagrams: undefined, colors: undefined, notes: undefined }
  // Tables without a schema land in the connection's default schema when the DBML is read.
  const keyed = (key: string) => (key.startsWith('.') ? `${defaultSchema ?? ''}${key}` : key)
  const rekey = <T,>(map: Record<string, T> | undefined) => Object.fromEntries(Object.entries(map ?? {}).map(([key, v]) => [keyed(key), v]))
  const positions = rekey(file.imported.positions)
  const diagrams = file.imported.diagrams.map((d) => ({ ...d, tables: d.tables.map(keyed), positions: rekey(d.positions), colors: rekey(d.colors) }))
  const colors = rekey(file.imported.colors)
  const leftOut = LEFT_OUT.filter(([key]) => file.imported!.leftOut[key] > 0).map(([key, label]) => t(label, { n: String(file.imported!.leftOut[key]) }))
  toast({
    kind: leftOut.length ? 'warning' : 'success',
    message: tp(file.imported.tables, { one: 'Opened a DeZign for Databases model: {n} table', many: 'Opened a DeZign for Databases model: {n} tables' }),
    detail: [leftOut.length ? `${t('Not in the model yet:')} ${leftOut.join(' · ')}` : '', t('Save writes your changes back into the DeZign file (a backup is kept); Save as makes a .dbml model.')].filter(Boolean).join('\n'),
  })
  return { text: file.text, path: undefined, source: { kind: 'dezign', path: file.path, hash: file.imported.hash }, dirty: false, title: name, positions, diagrams: diagrams.length ? diagrams : undefined, colors: Object.keys(colors).length ? colors : undefined, notes: file.imported.notes.length ? file.imported.notes : undefined }
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
  add_check: 'new check',
  drop_check: 'dropped check',
  add_relationship: 'new relationship',
  drop_relationship: 'dropped relationship',
  alter_relationship: 'changed relationship',
  move_table: 'moved in the diagram',
  alter_note: 'changed note',
}

/** One line per change for the confirmation before a model is written back to its DeZign file. */
export function describeDezignChanges(changes: DezignChange[], limit = 40): string[] {
  const lines = changes.map((c) => `${t(CHANGE_LABELS[c.kind])}: ${c.table}${c.name ? ` (${c.name})` : ''}`)
  return lines.length > limit ? [...lines.slice(0, limit), t('… and {n} more', { n: String(lines.length - limit) })] : lines
}

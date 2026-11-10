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
  ['checks', 'check constraints: {n}'],
  ['relationshipsWithoutColumns', 'relationships without columns: {n}'],
  ['subdiagrams', 'other diagrams: {n}'],
]

/**
 * What a model tab takes from an opened file. Another tool's model (DeZign for Databases) arrives as an unsaved
 * model with the source's layout: saving it writes a new .dbml file and never touches the source.
 */
export function modelTabFromFile(file: OpenedModelFile, defaultSchema?: string): Pick<ModelTab, 'text' | 'path' | 'dirty' | 'title' | 'positions'> {
  const name = file.path.split(/[\\/]/).pop() ?? t('Model')
  if (!file.imported) return { text: file.text, path: file.path, dirty: false, title: name, positions: undefined }
  // Tables without a schema land in the connection's default schema when the DBML is read.
  const positions = Object.fromEntries(Object.entries(file.imported.positions).map(([key, p]) => [key.startsWith('.') ? `${defaultSchema ?? ''}${key}` : key, p]))
  const leftOut = LEFT_OUT.filter(([key]) => file.imported!.leftOut[key] > 0).map(([key, label]) => t(label, { n: String(file.imported!.leftOut[key]) }))
  toast({
    kind: leftOut.length ? 'warning' : 'success',
    message: tp(file.imported.tables, { one: 'Opened a DeZign for Databases model: {n} table', many: 'Opened a DeZign for Databases model: {n} tables' }),
    detail: [leftOut.length ? `${t('Not in the model yet:')} ${leftOut.join(' · ')}` : '', t('The DeZign file is only read. Saving writes a new .dbml model.')].filter(Boolean).join('\n'),
  })
  return { text: file.text, path: undefined, dirty: true, title: name, positions }
}

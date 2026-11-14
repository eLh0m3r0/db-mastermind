import type { DefinedObject } from '@dbmastermind/core/browser'
import { api } from '@/lib/api'
import { t } from '@/lib/i18n'
import { errorMessage } from '@/lib/utils'
import { toast } from '@/store/ui'
import { useWorkspace } from '@/store/workspace'

const sameObject = (a: DefinedObject, b: DefinedObject) =>
  a.kind === b.kind && a.name === b.name && (a.schema ?? '') === (b.schema ?? '') && (a.arguments ?? '') === (b.arguments ?? '')

/**
 * Opens an object's definition in a query tab, ready to edit and run. The tab of the same object is reused as it
 * is (its text may hold the user's edits).
 */
export async function openDefinition(connectionId: string, object: DefinedObject): Promise<void> {
  const { tabs, activate, open } = useWorkspace.getState()
  const existing = tabs.find((tab) => tab.kind === 'query' && tab.connectionId === connectionId && tab.object && sameObject(tab.object as DefinedObject, object))
  if (existing) {
    activate(existing.id)
    return
  }
  try {
    const sql = await api.objectDefinition(connectionId, object)
    open({ kind: 'query', connectionId, title: object.name, sql, savedSql: sql, object: { schema: object.schema, name: object.name, kind: object.kind, arguments: object.arguments ?? null } }, { reuse: false })
  } catch (err) {
    toast({ kind: 'error', message: t('Could not read the definition of {name}', { name: object.name }), detail: errorMessage(err) })
  }
}

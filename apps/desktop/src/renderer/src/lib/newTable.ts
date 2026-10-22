import { designId, type DesignTable } from '@dbmastermind/core/browser'
import type { StoredConnection } from '@shared/api'
import { t } from '@/lib/i18n'
import { useWorkspace } from '@/store/workspace'

/** Opens the schema designer with a new table ready to edit; nothing changes until its migration runs. */
export function newTable(connection: StoredConnection, schema?: string) {
  const id = designId('new')
  const pkType = connection.driver === 'sqlite' ? 'INTEGER' : connection.driver === 'oracle' ? 'NUMBER(19)' : connection.driver === 'duckdb' ? 'BIGINT' : 'bigint'
  const draft: DesignTable = {
    id,
    schema,
    name: 'new_table',
    columns: [{ id: designId('c'), name: 'id', dataType: pkType, nullable: false, identity: true }],
    primaryKey: ['id'],
    foreignKeys: [],
    indexes: [],
  }
  useWorkspace.getState().open({ kind: 'diagram', connectionId: connection.id, title: t('New table'), design: { [id]: draft }, startDesign: id }, { reuse: false })
}

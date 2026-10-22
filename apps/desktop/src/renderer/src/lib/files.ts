import { api } from '@/lib/api'
import { runCommand } from '@/lib/commands'
import { t } from '@/lib/i18n'
import { errorMessage } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { toast, useUi } from '@/store/ui'
import { useWorkspace } from '@/store/workspace'

export const QUERYABLE_FILE = /\.(csv|tsv|txt|parquet|json|jsonl|ndjson|xlsx|db|sqlite|sqlite3|db3|duckdb)$/i

/** Opens a data file in the built-in DuckDB and runs a first SELECT on it. */
export async function queryFile(path?: string): Promise<void> {
  try {
    const target = await api.queryFile(path)
    if (!target) return
    await useConnections.getState().load()
    const ok = await useConnections.getState().connect(target.connectionId)
    if (!ok) throw new Error(useConnections.getState().runtime[target.connectionId]?.error ?? t('Could not connect to the database'))
    useUi.getState().set({ selectedConnectionId: target.connectionId })
    // A database file: its tables are in the explorer; open an empty query on it, like connecting from the sidebar.
    if (target.database) {
      const ws = useWorkspace.getState()
      const tab = ws.tabs.find((x) => x.connectionId === target.connectionId)
      if (tab) ws.activate(tab.id)
      else ws.newQuery(target.connectionId)
      return
    }
    useWorkspace.getState().newQuery(target.connectionId, target.sql, target.title)
    // Let the editor mount, then run it.
    setTimeout(() => runCommand('run-all'), 150)
  } catch (err) {
    toast({ kind: 'error', message: t('Could not open the file'), detail: errorMessage(err) })
  }
}

import { api } from '@/lib/api'
import { runCommand } from '@/lib/commands'
import { t } from '@/lib/i18n'
import { errorMessage } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { toast, useUi } from '@/store/ui'
import { useWorkspace } from '@/store/workspace'
import { modelTabFromFile } from '@/features/model/open-model'

export const MODEL_FILE = /\.(dbml|dez|dezproj)$/i

const LINKS = 'dbm.modelDatabase'
const links = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(LINKS) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}
/** The database a model file was last worked against, so the next time it opens it is linked again. */
export function rememberModelDatabase(path: string | undefined, connectionId: string): void {
  if (path) localStorage.setItem(LINKS, JSON.stringify({ ...links(), [path]: connectionId }))
}

const RECENT = 'dbm.recentModels'
export interface RecentModel {
  path: string
  name: string
  at: string
}
/** Model files opened lately, newest first (the home page lists them). */
export function recentModels(): RecentModel[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT) ?? '[]') as RecentModel[]
    return Array.isArray(list) ? list.filter((m) => m && typeof m.path === 'string') : []
  } catch {
    return []
  }
}
function rememberRecentModel(path: string): void {
  try {
    const name = path.split(/[\\/]/).pop() ?? path
    localStorage.setItem(RECENT, JSON.stringify([{ path, name, at: new Date().toISOString() }, ...recentModels().filter((m) => m.path !== path)].slice(0, 12)))
  } catch {
    // (A convenience: nothing breaks without it.)
  }
}
export function forgetRecentModel(path: string): void {
  try {
    localStorage.setItem(RECENT, JSON.stringify(recentModels().filter((m) => m.path !== path)))
  } catch {
    // (As above.)
  }
}

/**
 * Opens a model file (.dbml, or a DeZign for Databases .dez / .dezproj) in a model tab. A model needs no database:
 * it is linked to the one it was last used with, else to the current connection, else to none.
 */
export async function openModel(path?: string): Promise<void> {
  try {
    const connections = useConnections.getState()
    const ws = useWorkspace.getState()
    const current = ws.tabs.find((x) => x.id === ws.activeTabId)?.connectionId || useUi.getState().selectedConnectionId || ''
    const file = await api.openModelFile(path, connections.list.find((c) => c.id === current)?.knowledgeBasePath)
    if (!file) return
    const remembered = links()[file.path]
    const connectionId = remembered && connections.list.some((c) => c.id === remembered) ? remembered : current
    ws.open({ kind: 'model', connectionId, ...modelTabFromFile(file, connections.runtime[connectionId]?.schema?.defaultSchema) }, { reuse: false })
    rememberRecentModel(file.path)
  } catch (err) {
    toast({ kind: 'error', message: t('Could not open the model'), detail: errorMessage(err) })
  }
}

/** A file handed to the app (double-click in the system, command line, drop): a model, or data to query. */
export function openFile(path: string): void {
  void (MODEL_FILE.test(path) ? openModel(path) : queryFile(path))
}

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

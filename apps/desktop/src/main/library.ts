import { randomUUID } from 'node:crypto'
import type { Dashboard, HistoryEntry, SavedDiagram, SavedQuery, WorkspaceState } from '@shared/api'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { listConnections } from './connections'
import { dataPath, readJson, writeJson } from './storage'
import { invalidateTeam, team, teamDir } from './team'
import { deleteTeamDiagram, deleteTeamQuery, isTeamQuery, TEAM_QUERY_PREFIX, writeTeamDiagram, writeTeamQuery } from './team-folder'

const HISTORY_FILE = 'history.json'
const SAVED_FILE = 'saved-queries.json'
const WORKSPACE_FILE = 'workspace.json'
const DIAGRAMS_FILE = 'diagrams.json'
const DASHBOARDS_FILE = 'dashboards.json'
const MAX_HISTORY = 5000
/** Statements run by external agents through `--mcp` (a separate process appends here). */
export const MCP_HISTORY_FILE = 'mcp-history.jsonl'

let history: HistoryEntry[] | undefined
let historyTimer: NodeJS.Timeout | undefined

function loadHistory(): HistoryEntry[] {
  if (!history) history = readJson<HistoryEntry[]>(HISTORY_FILE, [])
  return history
}

function scheduleHistoryWrite() {
  // Queries can run in quick succession; batch writes.
  clearTimeout(historyTimer)
  historyTimer = setTimeout(() => writeJson(HISTORY_FILE, loadHistory()), 500)
}

export function flushHistory(): void {
  if (historyTimer) {
    clearTimeout(historyTimer)
    writeJson(HISTORY_FILE, loadHistory())
  }
}

export function addHistory(entry: Omit<HistoryEntry, 'id'>): void {
  const list = loadHistory()
  const last = list[0]
  // Re-running the same statement just refreshes the entry.
  if (last && last.connectionId === entry.connectionId && last.sql === entry.sql) list.shift()
  list.unshift({ ...entry, id: randomUUID() })
  if (list.length > MAX_HISTORY) list.length = MAX_HISTORY
  scheduleHistoryWrite()
}

function mcpHistory(): HistoryEntry[] {
  const file = dataPath(MCP_HISTORY_FILE)
  if (!existsSync(file)) return []
  const out: HistoryEntry[] = []
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (!line.trim()) return
      try {
        out.push({ ...(JSON.parse(line) as Omit<HistoryEntry, 'id'>), id: `mcp-${i}`, source: 'mcp' })
      } catch {
        // A line cut short by a crash: skip it.
      }
    })
  return out.reverse()
}

export function listHistory(connectionId?: string, search?: string, limit = 500): HistoryEntry[] {
  const needle = search?.trim().toLowerCase()
  const out: HistoryEntry[] = []
  const agent = mcpHistory()
  const all = agent.length ? [...loadHistory(), ...agent].sort((a, b) => b.executedAt.localeCompare(a.executedAt)) : loadHistory()
  for (const h of all) {
    if (connectionId && h.connectionId !== connectionId) continue
    if (needle && !h.sql.toLowerCase().includes(needle)) continue
    out.push(h)
    if (out.length >= limit) break
  }
  return out
}

export function clearHistory(connectionId?: string): void {
  history = connectionId ? loadHistory().filter((h) => h.connectionId !== connectionId) : []
  scheduleHistoryWrite()
  const file = dataPath(MCP_HISTORY_FILE)
  if (existsSync(file)) {
    const keep = connectionId ? mcpHistory().reverse().filter((h) => h.connectionId !== connectionId) : []
    writeFileSync(file, keep.map(({ id: _id, ...h }) => `${JSON.stringify(h)}\n`).join(''))
  }
}

function localSavedQueries(): SavedQuery[] {
  return readJson<SavedQuery[]>(SAVED_FILE, [])
}

/** This computer's saved queries plus the team folder's (folder "Team/…"). */
export function listSavedQueries(): SavedQuery[] {
  const connections = listConnections()
  // A team query may name a personal connection ("-- connection: ERP"): match it by name here.
  const shared = (team()?.queries ?? []).map((q) =>
    q.connectionId && !connections.some((c) => c.id === q.connectionId) ? { ...q, connectionId: connections.find((c) => c.name === q.connectionId)?.id ?? q.connectionId } : q,
  )
  return [...localSavedQueries(), ...shared]
}

export function saveQuery(query: Omit<SavedQuery, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): SavedQuery {
  const dir = teamDir()
  if (dir && isTeamQuery(query)) {
    const connectionName = listConnections().find((c) => c.id === query.connectionId)?.name
    const id = writeTeamQuery(dir, { ...query, folder: query.folder && isTeamQuery({ folder: query.folder }) ? query.folder : 'Team' }, connectionName)
    // A query moved into the team folder leaves this computer's list.
    if (query.id && !query.id.startsWith(TEAM_QUERY_PREFIX)) deleteSavedQuery(query.id)
    invalidateTeam()
    return listSavedQueries().find((q) => q.id === id)!
  }
  if (query.id?.startsWith(TEAM_QUERY_PREFIX)) {
    // Moved out of the team folder: becomes a personal query.
    if (dir) deleteTeamQuery(dir, query.id)
    invalidateTeam()
    query = { ...query, id: undefined }
  }
  const all = localSavedQueries()
  const now = new Date().toISOString()
  const existing = query.id ? all.find((q) => q.id === query.id) : undefined
  const saved: SavedQuery = {
    ...existing,
    ...query,
    id: existing?.id ?? randomUUID(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  writeJson(SAVED_FILE, existing ? all.map((q) => (q.id === saved.id ? saved : q)) : [...all, saved])
  return saved
}

export function deleteSavedQuery(id: string): void {
  const dir = teamDir()
  if (id.startsWith(TEAM_QUERY_PREFIX)) {
    if (dir) deleteTeamQuery(dir, id)
    invalidateTeam()
    return
  }
  writeJson(
    SAVED_FILE,
    localSavedQueries().filter((q) => q.id !== id),
  )
}

function localDiagrams(): SavedDiagram[] {
  return readJson<SavedDiagram[]>(DIAGRAMS_FILE, [])
}

/** This computer's diagrams plus the team folder's (their connection may be named instead of identified). */
export function listDiagrams(connectionId?: string): SavedDiagram[] {
  const connections = listConnections()
  const shared = (team()?.diagrams ?? []).map((d) =>
    connections.some((c) => c.id === d.connectionId) ? d : { ...d, connectionId: connections.find((c) => c.name === d.connectionId)?.id ?? d.connectionId },
  )
  const all = [...localDiagrams(), ...shared]
  return connectionId ? all.filter((d) => d.connectionId === connectionId) : all
}

export function saveDiagram(diagram: Omit<SavedDiagram, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): SavedDiagram {
  const dir = teamDir()
  if (diagram.team || diagram.id?.startsWith(TEAM_QUERY_PREFIX)) {
    if (!dir) throw new Error('Choose a team folder first (Settings → General)')
    const connection = listConnections().find((c) => c.id === diagram.connectionId)
    const id = writeTeamDiagram(dir, diagram, connection?.team ? connection.id : (connection?.name ?? diagram.connectionId))
    invalidateTeam()
    return listDiagrams().find((d) => d.id === id)!
  }
  const all = localDiagrams()
  const now = new Date().toISOString()
  const existing = diagram.id ? all.find((d) => d.id === diagram.id) : undefined
  const saved: SavedDiagram = { ...existing, ...diagram, id: existing?.id ?? randomUUID(), createdAt: existing?.createdAt ?? now, updatedAt: now }
  writeJson(DIAGRAMS_FILE, existing ? all.map((d) => (d.id === saved.id ? saved : d)) : [...all, saved])
  return saved
}

export function deleteDiagram(id: string): void {
  if (id.startsWith(TEAM_QUERY_PREFIX)) {
    const dir = teamDir()
    if (dir) deleteTeamDiagram(dir, id)
    invalidateTeam()
    return
  }
  writeJson(
    DIAGRAMS_FILE,
    localDiagrams().filter((d) => d.id !== id),
  )
}

export function listDashboards(connectionId?: string): Dashboard[] {
  const all = readJson<Dashboard[]>(DASHBOARDS_FILE, [])
  return connectionId ? all.filter((d) => d.connectionId === connectionId) : all
}

export function saveDashboard(dashboard: Omit<Dashboard, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Dashboard {
  const all = listDashboards()
  const now = new Date().toISOString()
  const existing = dashboard.id ? all.find((d) => d.id === dashboard.id) : undefined
  const saved: Dashboard = { ...existing, ...dashboard, id: existing?.id ?? randomUUID(), createdAt: existing?.createdAt ?? now, updatedAt: now }
  writeJson(DASHBOARDS_FILE, existing ? all.map((d) => (d.id === saved.id ? saved : d)) : [...all, saved])
  return saved
}

export function deleteDashboard(id: string): void {
  writeJson(
    DASHBOARDS_FILE,
    listDashboards().filter((d) => d.id !== id),
  )
}

export function loadWorkspace(): WorkspaceState | null {
  return readJson<WorkspaceState | null>(WORKSPACE_FILE, null)
}

export function saveWorkspace(state: WorkspaceState): void {
  writeJson(WORKSPACE_FILE, state)
}

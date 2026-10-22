import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { ConnectionConfig } from '@dbmastermind/core'
import type { SavedDiagram, SavedQuery } from '../shared/api'
import type { ManagedConfig } from './managed-config'

/**
 * A team folder is any shared folder (network share, OneDrive/SharePoint, a Git checkout) with:
 *   connections.json          connections without passwords (the "Share with colleagues" format)
 *   queries/<folder>/*.sql    saved queries, shown under "Team" in Saved
 *   knowledge/<connection>/   the knowledge base of a connection (Markdown notes)
 */
export const TEAM_CONNECTIONS = 'connections.json'
export const TEAM_QUERIES = 'queries'
export const TEAM_KNOWLEDGE = 'knowledge'
export const TEAM_DIAGRAMS = 'diagrams'
export const TEAM_QUERY_PREFIX = 'team:'
/** Saved-query folder that maps to the team folder. */
export const TEAM_FOLDER_NAME = 'Team'

export type TeamConnection = NonNullable<ManagedConfig['connections']>[number]

export interface TeamContents {
  connections: TeamConnection[]
  queries: SavedQuery[]
  diagrams: SavedDiagram[]
  error?: string
}

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'connection'

function readConnectionsFile(dir: string): TeamConnection[] {
  const file = join(dir, TEAM_CONNECTIONS)
  if (!existsSync(file)) return []
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
  const list = (Array.isArray(raw) ? raw : (raw as { connections?: unknown[] })?.connections) ?? []
  if (!Array.isArray(list)) throw new Error(`${TEAM_CONNECTIONS} must contain a list of connections`)
  return list.map((item) => {
    const c = item as Partial<ConnectionConfig>
    if (!c.name || !c.driver) throw new Error(`Every connection in ${TEAM_CONNECTIONS} needs "name" and "driver"`)
    // Shared files don't carry ids; the name gives a stable one so everyone gets the same connection.
    const id = c.id || `team-${slug(c.name)}`
    let knowledgeBasePath = c.knowledgeBasePath
    if (knowledgeBasePath && !isAbsolute(knowledgeBasePath)) knowledgeBasePath = join(dir, knowledgeBasePath)
    if (!knowledgeBasePath) {
      const candidate = [join(dir, TEAM_KNOWLEDGE, id), join(dir, TEAM_KNOWLEDGE, slug(c.name))].find((p) => existsSync(p))
      if (candidate) knowledgeBasePath = candidate
    }
    return { ...c, id, name: c.name, driver: c.driver, knowledgeBasePath, password: undefined } as TeamConnection
  })
}

function walkSql(root: string, dir = root, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walkSql(root, path, out)
    else if (entry.toLowerCase().endsWith('.sql')) out.push(path)
  }
  return out
}

/** `-- connection: ERP` / `-- description: …` lines at the top of a team query. */
function parseHeader(text: string): { sql: string; connection?: string; description?: string } {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const meta: Record<string, string> = {}
  let i = 0
  for (; i < lines.length; i++) {
    const m = /^--\s*(connection|description):\s*(.*)$/i.exec(lines[i]!)
    if (!m) break
    meta[m[1]!.toLowerCase()] = m[2]!.trim()
  }
  return { sql: lines.slice(i).join('\n').replace(/^\n+/, ''), connection: meta.connection, description: meta.description }
}

/** Everything the team shares; a broken file is reported, the rest still loads. */
export function readTeamFolder(dir: string): TeamContents {
  let connections: TeamConnection[] = []
  let error: string | undefined
  try {
    connections = readConnectionsFile(dir)
  } catch (err) {
    error = `${TEAM_CONNECTIONS}: ${(err as Error).message}`
  }
  const root = join(dir, TEAM_QUERIES)
  const queries = walkSql(root).map((path): SavedQuery => {
    const rel = relative(root, path).split(sep).join('/')
    const sub = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    const { sql, connection, description } = parseHeader(readFileSync(path, 'utf8'))
    const target = connection ? connections.find((c) => c.id === connection || c.name === connection) : undefined
    const time = statSync(path).mtime.toISOString()
    return {
      id: `${TEAM_QUERY_PREFIX}${rel}`,
      name: rel.slice(rel.lastIndexOf('/') + 1).replace(/\.sql$/i, ''),
      sql,
      connectionId: target?.id ?? connection,
      folder: sub ? `${TEAM_FOLDER_NAME}/${sub}` : TEAM_FOLDER_NAME,
      description,
      createdAt: time,
      updatedAt: time,
    }
  })
  const diagrams: SavedDiagram[] = []
  const diagramDir = join(dir, TEAM_DIAGRAMS)
  if (existsSync(diagramDir)) {
    for (const file of readdirSync(diagramDir).filter((f) => f.toLowerCase().endsWith('.json'))) {
      try {
        const d = JSON.parse(readFileSync(join(diagramDir, file), 'utf8')) as Partial<SavedDiagram> & { connection?: string }
        const target = d.connection ? connections.find((c) => c.id === d.connection || c.name === d.connection) : undefined
        const time = statSync(join(diagramDir, file)).mtime.toISOString()
        diagrams.push({
          id: `${TEAM_QUERY_PREFIX}${TEAM_DIAGRAMS}/${file}`,
          connectionId: target?.id ?? d.connection ?? '',
          name: d.name ?? file.replace(/\.json$/i, ''),
          tables: d.tables ?? [],
          positions: d.positions,
          colors: d.colors,
          notes: d.notes,
          team: true,
          createdAt: time,
          updatedAt: time,
        })
      } catch {
        // A broken diagram file is skipped; the others still load.
      }
    }
  }
  return { connections, queries, diagrams, error }
}

/** Writes a diagram to diagrams/<name>.json; renaming removes the old file. Returns its id. */
export function writeTeamDiagram(dir: string, d: Pick<SavedDiagram, 'name' | 'tables' | 'positions' | 'colors' | 'notes'> & { id?: string }, connection: string): string {
  const file = `${safe(d.name)}.json`
  mkdirSync(join(dir, TEAM_DIAGRAMS), { recursive: true })
  const body = { name: d.name, connection, tables: d.tables, positions: d.positions, colors: d.colors, notes: d.notes }
  writeFileSync(join(dir, TEAM_DIAGRAMS, file), `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  const id = `${TEAM_QUERY_PREFIX}${TEAM_DIAGRAMS}/${file}`
  if (d.id?.startsWith(TEAM_QUERY_PREFIX) && d.id !== id) deleteTeamDiagram(dir, d.id)
  return id
}

export function deleteTeamDiagram(dir: string, id: string): void {
  const file = id.slice(`${TEAM_QUERY_PREFIX}${TEAM_DIAGRAMS}/`.length)
  if (!file || file.includes('/') || file.includes('..')) return
  rmSync(join(dir, TEAM_DIAGRAMS, file), { force: true })
}

/** Is this saved query (or folder) stored in the team folder? */
export function isTeamQuery(q: { id?: string; folder?: string }): boolean {
  return !!q.id?.startsWith(TEAM_QUERY_PREFIX) || q.folder === TEAM_FOLDER_NAME || !!q.folder?.startsWith(`${TEAM_FOLDER_NAME}/`)
}

const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'query'

/** Writes a team query as a .sql file; renaming or moving removes the old file. Returns the new id. */
export function writeTeamQuery(dir: string, q: { id?: string; name: string; sql: string; folder?: string; connectionId?: string; description?: string }, connectionName?: string): string {
  const sub = (q.folder ?? TEAM_FOLDER_NAME).split('/').slice(1).map(safe)
  const rel = [...sub, `${safe(q.name)}.sql`].join('/')
  const path = join(dir, TEAM_QUERIES, ...rel.split('/'))
  const header = [connectionName && `-- connection: ${connectionName}`, q.description && `-- description: ${q.description.replace(/\n/g, ' ')}`].filter(Boolean)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${[...header, q.sql.trimEnd()].join('\n')}\n`, 'utf8')
  const id = `${TEAM_QUERY_PREFIX}${rel}`
  if (q.id?.startsWith(TEAM_QUERY_PREFIX) && q.id !== id) deleteTeamQuery(dir, q.id)
  return id
}

export function deleteTeamQuery(dir: string, id: string): void {
  const rel = id.slice(TEAM_QUERY_PREFIX.length)
  if (!rel || rel.split('/').includes('..')) return
  rmSync(join(dir, TEAM_QUERIES, ...rel.split('/')), { force: true })
}

/** Adds or replaces a connection (without secrets) in the team's connections.json, keeping the file's format. */
export function writeTeamConnection(dir: string, connection: ConnectionConfig): void {
  const file = join(dir, TEAM_CONNECTIONS)
  const raw = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown) : { format: 'db-mastermind-connections', version: 1, connections: [] }
  const list = (Array.isArray(raw) ? raw : ((raw as { connections?: TeamConnection[] }).connections ?? [])) as TeamConnection[]
  const { password: _pw, ...rest } = connection as ConnectionConfig & Record<string, unknown>
  for (const key of ['createdAt', 'updatedAt', 'lastUsedAt', 'pinnedTables', 'hiddenSchemas', 'managed', 'team']) delete rest[key]
  if (rest.ssh) rest.ssh = { ...rest.ssh, password: undefined, privateKey: undefined, passphrase: undefined }
  if (rest.ssl) rest.ssl = { ...rest.ssl, key: undefined }
  // A knowledge base inside the team folder is stored relative, so it works from everyone's mount point.
  if (typeof rest.knowledgeBasePath === 'string' && !relative(dir, rest.knowledgeBasePath).startsWith('..') && !isAbsolute(relative(dir, rest.knowledgeBasePath)))
    rest.knowledgeBasePath = relative(dir, rest.knowledgeBasePath).split(sep).join('/')
  const next = [...list.filter((c) => c.id !== rest.id), rest as TeamConnection]
  const out = Array.isArray(raw) ? next : { ...(raw as object), connections: next }
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`, 'utf8')
}

export function removeTeamConnection(dir: string, id: string): void {
  const file = join(dir, TEAM_CONNECTIONS)
  if (!existsSync(file)) return
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
  const list = (Array.isArray(raw) ? raw : ((raw as { connections?: TeamConnection[] }).connections ?? [])) as TeamConnection[]
  const next = list.filter((c) => (c.id || `team-${slug(c.name)}`) !== id)
  writeFileSync(file, `${JSON.stringify(Array.isArray(raw) ? next : { ...(raw as object), connections: next }, null, 2)}\n`, 'utf8')
}

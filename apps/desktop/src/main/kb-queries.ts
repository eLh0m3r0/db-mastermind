/**
 * Saved queries shared with the team through a connection's knowledge base: `queries/<folder…>/<name>.sql`, in the
 * team folder's own format (`-- description:` header; a `-- connection:` line is not written and one found is
 * ignored: the folder belongs to the connection). New saved queries are always on this computer; sharing is the
 * user's act. A file from a teammate is untrusted: read through KnowledgeBase (inside the folder, no links, capped),
 * names are text, a file that can't be read is listed with what is wrong, and nothing runs by itself. The id is
 * `kbq:<connection id>:<path>`.
 */
import { realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { KnowledgeBase } from '@dbmastermind/core'
import type { SavedQuery } from '@shared/api'
import * as connections from './connections'
import * as library from './library'
import { teamDir } from './team'
import { parseHeader, sqlFileText, TEAM_QUERIES } from './team-folder'

const FOLDER = 'queries'
const ID = 'kbq:'

export const isKnowledgeQuery = (id: string | undefined) => !!id?.startsWith(ID)
const idOf = (connectionId: string, path: string) => `${ID}${encodeURIComponent(connectionId)}:${path}`

function fileOf(id: string): { connectionId: string; path: string } | undefined {
  if (!id.startsWith(ID)) return undefined
  const rest = id.slice(ID.length)
  const colon = rest.indexOf(':')
  return colon < 0 ? undefined : { connectionId: decodeURIComponent(rest.slice(0, colon)), path: rest.slice(colon + 1) }
}

function knowledgeOf(connectionId: string): KnowledgeBase | undefined {
  const path = connections.listConnections().find((c) => c.id === connectionId)?.knowledgeBasePath
  return path ? new KnowledgeBase(path) : undefined
}

const safe = (s: string) => s.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/^[.\s]+|[.\s]+$/g, '') || 'query'

/** The file a query is kept in: its folders as subfolders, its name as the file name. */
function pathFor(q: { name: string; folder?: string }): string {
  const sub = (q.folder ?? '').split('/').map((p) => p.trim()).filter(Boolean).map(safe)
  return [FOLDER, ...sub, `${safe(q.name)}.sql`].join('/')
}

/** The real path of the team folder's queries/, so a knowledge base inside the team folder lists none twice. */
function teamQueriesRoot(): string | undefined {
  const dir = teamDir()
  if (!dir) return undefined
  try {
    return realpathSync(join(dir, TEAM_QUERIES))
  } catch {
    return undefined
  }
}

async function readOne(kb: KnowledgeBase, connectionId: string, path: string, modifiedAt: string): Promise<SavedQuery> {
  const rel = path.slice(FOLDER.length + 1)
  const name = rel.slice(rel.lastIndexOf('/') + 1).replace(/\.sql$/i, '')
  const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : undefined
  const base = { id: idOf(connectionId, path), name, connectionId, folder, shared: true, createdAt: modifiedAt, updatedAt: modifiedAt }
  try {
    const { sql, description } = parseHeader(await kb.readText(path))
    // (The file ends with a line break; the query's text doesn't.)
    return { ...base, sql: sql.replace(/\s+$/, ''), description }
  } catch (err) {
    return { ...base, sql: '', problem: (err as Error).message }
  }
}

/** The saved queries in the knowledge bases of every connection that has one, each listed under its connection. */
export async function listKnowledgeQueries(): Promise<SavedQuery[]> {
  const team = teamQueriesRoot()
  const out: SavedQuery[] = []
  for (const c of connections.listConnections()) {
    if (!c.knowledgeBasePath) continue
    const kb = new KnowledgeBase(c.knowledgeBasePath)
    for (const f of await kb.listSql(FOLDER).catch(() => [])) {
      if (team) {
        // Already listed as a team folder query ("Team/…").
        const real = (() => {
          try {
            return realpathSync(join(c.knowledgeBasePath!, ...f.path.split('/')))
          } catch {
            return ''
          }
        })()
        if (real && (real === team || real.startsWith(team + sep))) continue
      }
      out.push(await readOne(kb, c.id, f.path, f.modifiedAt))
    }
  }
  return out
}

/** Saves a shared query: writes its file only when the text changed; a new name or folder renames the file. */
export async function saveKnowledgeQuery(change: Pick<SavedQuery, 'id' | 'sql'> & Partial<Pick<SavedQuery, 'name' | 'folder' | 'description'>>): Promise<SavedQuery> {
  const file = fileOf(change.id)
  if (!file) throw new Error('Not a query of a knowledge base')
  const kb = knowledgeOf(file.connectionId)
  if (!kb) throw new Error('This connection has no knowledge base folder')
  // What the request leaves out (a tab saves only its text) stays as the file has it.
  const now = await readOne(kb, file.connectionId, file.path, '')
  const q = { name: change.name ?? now.name, folder: 'folder' in change ? change.folder : now.folder, description: change.description ?? now.description, sql: change.sql }
  const target = pathFor(q)
  const content = sqlFileText(q.sql, q.description)
  const before = await kb.readText(file.path).catch(() => undefined)
  if (target !== file.path || before !== content) await kb.writeText(target, content)
  if (target !== file.path) await kb.remove(file.path).catch(() => {})
  return readOne(kb, file.connectionId, target, new Date().toISOString())
}

/** Shares a query of this computer with the team: a file in the connection's knowledge base; the local one goes. */
export async function shareQuery(id: string, connectionId: string): Promise<SavedQuery> {
  const local = library.listSavedQueries().find((q) => q.id === id)
  if (!local) throw new Error('Saved query not found')
  if (local.connectionId && local.connectionId !== connectionId) throw new Error('This query belongs to another connection')
  const kb = knowledgeOf(connectionId)
  if (!kb) throw new Error('This connection has no knowledge base folder')
  let target = pathFor(local)
  const taken = new Set((await kb.listSql(FOLDER)).map((f) => f.path.toLowerCase()))
  for (let n = 2; taken.has(target.toLowerCase()); n++) target = pathFor({ ...local, name: `${local.name} ${n}` })
  await kb.writeText(target, sqlFileText(local.sql, local.description))
  library.deleteSavedQuery(id)
  return readOne(kb, connectionId, target, new Date().toISOString())
}

/** Keeps a shared query on this computer only: a local copy of it, and the file removed from the knowledge base. */
export async function unshareQuery(id: string): Promise<SavedQuery> {
  const file = fileOf(id)
  if (!file) throw new Error('Not a query of a knowledge base')
  const kb = knowledgeOf(file.connectionId)
  if (!kb) throw new Error('This connection has no knowledge base folder')
  const q = await readOne(kb, file.connectionId, file.path, '')
  if (q.problem) throw new Error(q.problem)
  // (A folder named "Team" would put it into the team folder: on this computer it goes without that folder.)
  const local = library.saveQuery({ name: q.name, sql: q.sql, connectionId: file.connectionId, folder: q.folder && !/^Team(\/|$)/.test(q.folder) ? q.folder : undefined, description: q.description })
  await kb.remove(file.path)
  return local
}

export async function deleteKnowledgeQuery(id: string): Promise<void> {
  const file = fileOf(id)
  if (!file) return
  const kb = knowledgeOf(file.connectionId)
  if (!kb) throw new Error('This connection has no knowledge base folder')
  await kb.remove(file.path)
}

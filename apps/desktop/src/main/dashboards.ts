/**
 * Where dashboards live: a connection with a knowledge base keeps new ones there (`dashboards/<name>.md`, shared with
 * everyone who uses the folder, read by the assistant and agents); otherwise on this computer (`dashboards.json`).
 * Local ones stay local until the user moves one (sharing its SQL is the user's act). A dashboard always belongs to
 * one connection (another database's dashboards make no sense on it): knowledge base ones through its folder, with the
 * id `kb:<connection id>:<path>`; two connections that share a folder on purpose (dev and prod) see the same files.
 */
import { KnowledgeBase } from '@dbmastermind/core'
import type { Dashboard } from '@shared/api'
import * as connections from './connections'
import { dashboardFileName, parseDashboard, writeDashboard } from './dashboard-file'
import * as library from './library'

const FOLDER = 'dashboards/'
const KB_ID = 'kb:'

type NewDashboard = Omit<Dashboard, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }

function knowledgeOf(connectionId: string): KnowledgeBase | undefined {
  const path = connections.listConnections().find((c) => c.id === connectionId)?.knowledgeBasePath
  return path ? new KnowledgeBase(path) : undefined
}

const sharedId = (connectionId: string, path: string) => `${KB_ID}${encodeURIComponent(connectionId)}:${path}`
/** The connection and file of a knowledge base dashboard's id. */
function fileOf(id: string): { connectionId: string; path: string } | undefined {
  if (!id.startsWith(KB_ID)) return undefined
  const rest = id.slice(KB_ID.length)
  const colon = rest.indexOf(':')
  return colon < 0 ? undefined : { connectionId: decodeURIComponent(rest.slice(0, colon)), path: rest.slice(colon + 1) }
}
const stem = (path: string) => path.slice(FOLDER.length).replace(/\.(md|markdown)$/i, '')

async function readShared(kb: KnowledgeBase, connectionId: string, path: string, modifiedAt: string): Promise<Dashboard> {
  const base = { id: sharedId(connectionId, path), connectionId, shared: true, createdAt: modifiedAt, updatedAt: modifiedAt }
  try {
    const file = parseDashboard((await kb.read(path)).content, stem(path))
    return { ...base, name: file.name, refreshSeconds: file.refreshSeconds, intro: file.intro, tiles: file.tiles.map((t, i) => ({ ...t, id: `tile-${i + 1}` })) }
  } catch (err) {
    // Listed with what is wrong; nothing of it runs.
    return { ...base, name: stem(path), refreshSeconds: 0, tiles: [], problem: (err as Error).message }
  }
}

export async function listDashboards(connectionId: string): Promise<Dashboard[]> {
  const local = library.listDashboards(connectionId)
  const kb = knowledgeOf(connectionId)
  if (!kb) return local
  const files = await kb.list().catch(() => [])
  const shared = await Promise.all(files.filter((f) => f.path.startsWith(FOLDER) && /\.(md|markdown)$/i.test(f.path)).map((f) => readShared(kb, connectionId, f.path, f.modifiedAt)))
  return [...shared, ...local]
}

/** A free `dashboards/<name>.md` (another dashboard of that name keeps its file). */
async function freePath(kb: KnowledgeBase, name: string, own?: string): Promise<string> {
  const taken = new Set((await kb.list().catch(() => [])).map((f) => f.path.toLowerCase()))
  const file = dashboardFileName(name)
  for (let n = 1; ; n++) {
    const path = `${FOLDER}${n === 1 ? file : file.replace(/\.md$/, ` ${n}.md`)}`
    if (path.toLowerCase() === own?.toLowerCase() || !taken.has(path.toLowerCase())) return path
  }
}

async function writeShared(kb: KnowledgeBase, d: NewDashboard, path: string | undefined): Promise<string> {
  const target = await freePath(kb, d.name, path)
  const content = writeDashboard({ name: d.name, refreshSeconds: d.refreshSeconds, intro: d.intro, tiles: d.tiles })
  const before = path ? await kb.read(path).then((doc) => doc.content, () => undefined) : undefined
  // Only a real change is written (opening or refreshing never touches the file; Git sees only edits).
  if (target !== path || before !== content) await kb.write(target, content)
  // A rename names the file after it.
  if (path && target !== path) await kb.remove(path)
  return target
}

export async function saveDashboard(d: NewDashboard): Promise<Dashboard> {
  const file = d.id ? fileOf(d.id) : undefined
  if (file && file.connectionId !== d.connectionId) throw new Error('This dashboard belongs to another connection')
  const path = file?.path
  const kb = knowledgeOf(d.connectionId)
  if (path) {
    if (!kb) throw new Error('This connection has no knowledge base folder')
    const written = await writeShared(kb, d, path)
    return (await readShared(kb, d.connectionId, written, new Date().toISOString()))
  }
  // A new dashboard of a connection with a knowledge base goes there; one kept on this computer stays here.
  if (!d.id && kb) {
    const written = await writeShared(kb, d, undefined)
    return readShared(kb, d.connectionId, written, new Date().toISOString())
  }
  const { shared: _s, problem: _p, intro: _i, ...local } = d
  return library.saveDashboard(local)
}

/** Deletes a dashboard: a knowledge base file (of the connection its id names), or one kept on this computer. */
export async function deleteDashboard(id: string): Promise<void> {
  const file = fileOf(id)
  if (!file) return library.deleteDashboard(id)
  const kb = knowledgeOf(file.connectionId)
  if (!kb) throw new Error('This connection has no knowledge base folder')
  await kb.remove(file.path)
}

/** Moves a dashboard kept on this computer into the connection's knowledge base. */
export async function moveDashboardToKnowledge(id: string): Promise<Dashboard> {
  const local = library.listDashboards().find((d) => d.id === id)
  if (!local) throw new Error('Dashboard not found')
  const kb = knowledgeOf(local.connectionId)
  if (!kb) throw new Error('This connection has no knowledge base folder')
  const written = await writeShared(kb, local, undefined)
  library.deleteDashboard(id)
  return readShared(kb, local.connectionId, written, new Date().toISOString())
}

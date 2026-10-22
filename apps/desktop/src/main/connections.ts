import { randomUUID } from 'node:crypto'
import type { ConnectionConfig } from '@dbmastermind/core'
import type { ExplorerPrefs, StoredConnection } from '@shared/api'
import { decryptSecret, encryptSecret, readJson, writeJson } from './storage'

const FILE = 'connections.json'

const SSH_SECRETS = ['password', 'privateKey', 'passphrase'] as const

async function transformSecrets(
  c: StoredConnection,
  fn: (v: string | undefined) => Promise<string | undefined>,
): Promise<StoredConnection> {
  const out: StoredConnection = { ...c, password: await fn(c.password) }
  if (c.ssh) {
    out.ssh = { ...c.ssh }
    for (const key of SSH_SECRETS) out.ssh[key] = await fn(c.ssh[key])
  }
  if (c.ssl?.key) out.ssl = { ...c.ssl, key: await fn(c.ssl.key) }
  return out
}

let cache: StoredConnection[] = []

/** Reads and decrypts saved connections. Must run after app 'ready', before anything uses them. */
export async function loadConnections(): Promise<void> {
  cache = await Promise.all(readJson<StoredConnection[]>(FILE, []).map((c) => transformSecrets(c, decryptSecret)))
}

export function listConnections(): StoredConnection[] {
  return cache
}

let writes = Promise.resolve()

/** Encrypts and writes in order; later saves never overtake earlier ones. */
function persist() {
  const snapshot = cache
  writes = writes
    .then(async () => writeJson(FILE, await Promise.all(snapshot.map((c) => transformSecrets(c, encryptSecret)))))
    .catch((err: unknown) => console.error('Could not save connections', err))
}

export function flushConnections(): Promise<void> {
  return writes
}

export function getConnection(id: string): StoredConnection {
  const c = listConnections().find((x) => x.id === id)
  if (!c) throw new Error('Connection not found')
  return c
}

export function saveConnection(config: ConnectionConfig): StoredConnection {
  const all = listConnections()
  const now = new Date().toISOString()
  const id = config.id || randomUUID()
  const existing = all.find((c) => c.id === id)
  const saved: StoredConnection = {
    ...config,
    id,
    name: config.name?.trim() || defaultName(config),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastUsedAt: existing?.lastUsedAt,
    pinnedTables: (config as StoredConnection).pinnedTables ?? existing?.pinnedTables,
    hiddenSchemas: (config as StoredConnection).hiddenSchemas ?? existing?.hiddenSchemas,
  }
  cache = existing ? all.map((c) => (c.id === id ? saved : c)) : [...all, saved]
  persist()
  return saved
}

export function touchConnection(id: string): void {
  cache = listConnections().map((c) => (c.id === id ? { ...c, lastUsedAt: new Date().toISOString() } : c))
  persist()
}

export function setExplorerPrefs(id: string, prefs: ExplorerPrefs): void {
  const clean = (list?: string[]) => (list?.length ? list : undefined)
  cache = listConnections().map((c) =>
    c.id !== id
      ? c
      : {
          ...c,
          pinnedTables: 'pinnedTables' in prefs ? clean(prefs.pinnedTables) : c.pinnedTables,
          hiddenSchemas: 'hiddenSchemas' in prefs ? clean(prefs.hiddenSchemas) : c.hiddenSchemas,
        },
  )
  persist()
}

export function deleteConnection(id: string): void {
  cache = listConnections().filter((c) => c.id !== id)
  persist()
}

export function duplicateConnection(id: string): StoredConnection {
  const source = getConnection(id)
  return saveConnection({ ...source, id: '', name: `${source.name} (copy)` })
}

export function defaultName(c: Partial<ConnectionConfig>): string {
  if (c.driver === 'sqlite') return c.filePath?.split(/[\\/]/).pop() ?? 'SQLite'
  const db = c.database ? `/${c.database}` : ''
  return `${c.host ?? 'localhost'}${db}`
}

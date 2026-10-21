import { randomUUID } from 'node:crypto'
import type { ConnectionConfig } from '@dbmastermind/core'
import type { StoredConnection } from '@shared/api'
import { decryptSecret, encryptSecret, readJson, writeJson } from './storage'

const FILE = 'connections.json'

const SSH_SECRETS = ['password', 'privateKey', 'passphrase'] as const

function transformSecrets(c: StoredConnection, fn: (v: string | undefined) => string | undefined): StoredConnection {
  const out: StoredConnection = { ...c, password: fn(c.password) }
  if (c.ssh) {
    out.ssh = { ...c.ssh }
    for (const key of SSH_SECRETS) out.ssh[key] = fn(c.ssh[key])
  }
  if (c.ssl?.key) out.ssl = { ...c.ssl, key: fn(c.ssl.key) }
  return out
}

let cache: StoredConnection[] | undefined

export function listConnections(): StoredConnection[] {
  if (!cache) cache = readJson<StoredConnection[]>(FILE, []).map((c) => transformSecrets(c, decryptSecret))
  return cache
}

function persist() {
  writeJson(
    FILE,
    listConnections().map((c) => transformSecrets(c, encryptSecret)),
  )
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
  }
  cache = existing ? all.map((c) => (c.id === id ? saved : c)) : [...all, saved]
  persist()
  return saved
}

export function touchConnection(id: string): void {
  cache = listConnections().map((c) => (c.id === id ? { ...c, lastUsedAt: new Date().toISOString() } : c))
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

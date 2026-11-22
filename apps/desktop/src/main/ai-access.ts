import { resolve } from 'node:path'
import { capAccess, DEFAULT_PORTS, resolveAiPermissions, type AiPermissions, type ConnectionConfig, type EffectiveAiPermissions } from '@dbmastermind/core'
import { listConnections } from './connections'
import { managedConfig } from './managed'
import { getSettings } from './settings'
import { team } from './team'

/** App-wide defaults; before they existed, the data-sharing and MCP-writes settings said the same. */
export function aiDefaults(): AiPermissions {
  const { ai, mcp } = getSettings()
  return ai.defaults ?? { access: ai.dataSharing === 'schema' ? 'schema' : 'write', agents: true, agentWrites: mcp.allowWrites, knowledgeWrites: true }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * Where a connection's data lives: a server (any database on it, whichever driver speaks to it, through the same SSH
 * host) or a file. Connections made from another one (a duplicate, "Open another database…", an import of an
 * exported file, a project's .env pointing at the same server) share it, whatever their id.
 */
export function serverOf(c: Partial<ConnectionConfig>): string | undefined {
  if (c.filePath) return `file:${resolve(c.filePath)}`
  if (c.driver === 'bigquery') return c.database ? `bigquery:${c.database.toLowerCase()}` : undefined
  if (!c.host?.trim() || !c.driver) return undefined
  const host = c.host.trim().toLowerCase()
  const via = c.ssh?.enabled && c.ssh.host ? `${c.ssh.host.trim().toLowerCase()}:${c.ssh.port ?? 22}>` : ''
  return `${via}${LOCAL_HOSTS.has(host) ? 'localhost' : host}:${c.port ?? DEFAULT_PORTS[c.driver] ?? ''}`
}

/**
 * AI turned off for this connection by the organization's managed configuration or the team folder. Read from there
 * rather than the saved connection, where the user's own AI permissions would win (and a lifted ban would stick).
 * The ban follows the server or file it was put on, not the row: a copy of the connection is banned too.
 */
export function turnedOffCentrally(connection: string | ConnectionConfig): boolean {
  const config = typeof connection === 'string' ? (listConnections().find((c) => c.id === connection) ?? { id: connection }) : connection
  const server = serverOf(config)
  const off = (defs?: (Partial<ConnectionConfig> & { id: string; aiEnabled?: boolean })[]) =>
    !!defs?.some((d) => d.aiEnabled === false && (d.id === config.id || (server !== undefined && serverOf(d) === server)))
  return off(managedConfig()?.connections) || off(team()?.connections)
}

/**
 * Whether AI may be used at all: the organization's managed configuration can turn it off. This is all that decides a
 * chat about a model's text, which involves no connection; `aiAccess` adds the connection's permissions on top.
 */
export function aiAllowed(): boolean {
  return managedConfig()?.policies?.allowAi !== false
}

/** What AI may do on this connection, organization policies included. Every AI entry point checks this. */
export function aiAccess(config: ConnectionConfig): EffectiveAiPermissions {
  const p = resolveAiPermissions(config, aiDefaults())
  if (turnedOffCentrally(config)) return { access: 'off', agents: false, agentWrites: false, knowledgeWrites: false }
  const policies = managedConfig()?.policies ?? {}
  let access = p.access
  if (!aiAllowed()) access = 'off'
  // The app-wide "schema only" of older versions still restricts every connection, as the MCP servers applied it on
  // top (a second answer); saving the app's defaults sets it again (settings.ts).
  if (policies.maxAiDataSharing === 'schema' || getSettings().ai.dataSharing === 'schema') access = capAccess(access, 'schema')
  const agents = p.agents && access !== 'off' && policies.allowMcp !== false
  return {
    access,
    agents,
    agentWrites: p.agentWrites && access === 'write' && agents && policies.allowMcpWrites !== false,
    knowledgeWrites: p.knowledgeWrites && access !== 'off',
  }
}

/** Connections for MCP agents, each with its effective permissions spelled out. */
export function agentConnections<T extends ConnectionConfig>(list: T[]): T[] {
  return list
    .map((c) => ({ c, p: aiAccess(c) }))
    .filter(({ p }) => p.agents)
    .map(({ c, p }) => ({ ...c, ai: { access: p.access, agents: true, agentWrites: p.agentWrites, knowledgeWrites: p.knowledgeWrites } }))
}

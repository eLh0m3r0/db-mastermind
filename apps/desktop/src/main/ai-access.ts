import { capAccess, resolveAiPermissions, type AiPermissions, type ConnectionConfig, type EffectiveAiPermissions } from '@dbmastermind/core'
import { managedConfig } from './managed'
import { getSettings } from './settings'
import { team } from './team'

/** App-wide defaults; before they existed, the data-sharing and MCP-writes settings said the same. */
export function aiDefaults(): AiPermissions {
  const { ai, mcp } = getSettings()
  return ai.defaults ?? { access: ai.dataSharing === 'schema' ? 'schema' : 'write', agents: true, agentWrites: mcp.allowWrites, knowledgeWrites: true }
}

/**
 * AI turned off for this connection by the organization's managed configuration or the team folder. Read from there
 * rather than the saved connection, where the user's own AI permissions would win (and a lifted ban would stick).
 */
export function turnedOffCentrally(id: string): boolean {
  const off = (defs?: { id: string; aiEnabled?: boolean }[]) => !!defs?.some((d) => d.id === id && d.aiEnabled === false)
  return off(managedConfig()?.connections) || off(team()?.connections)
}

/** What AI may do on this connection, organization policies included. Every AI entry point checks this. */
export function aiAccess(config: ConnectionConfig): EffectiveAiPermissions {
  const p = resolveAiPermissions(config, aiDefaults())
  if (turnedOffCentrally(config.id)) return { access: 'off', agents: false, agentWrites: false, knowledgeWrites: false }
  const policies = managedConfig()?.policies
  if (!policies) return p
  let access = p.access
  if (policies.allowAi === false) access = 'off'
  if (policies.maxAiDataSharing === 'schema') access = capAccess(access, 'schema')
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

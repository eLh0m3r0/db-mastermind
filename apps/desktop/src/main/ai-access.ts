import { capAccess, resolveAiPermissions, type AiPermissions, type ConnectionConfig, type EffectiveAiPermissions } from '@dbmastermind/core'
import { managedConfig } from './managed'
import { getSettings } from './settings'

/** App-wide defaults; before they existed, the data-sharing and MCP-writes settings said the same. */
export function aiDefaults(): AiPermissions {
  const { ai, mcp } = getSettings()
  return ai.defaults ?? { access: ai.dataSharing === 'schema' ? 'schema' : 'write', agents: true, agentWrites: mcp.allowWrites, knowledgeWrites: true }
}

/** What AI may do on this connection, organization policies included. Every AI entry point checks this. */
export function aiAccess(config: ConnectionConfig): EffectiveAiPermissions {
  const p = resolveAiPermissions(config, aiDefaults())
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

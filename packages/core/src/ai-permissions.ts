import type { AiAccess, AiPermissions, ConnectionConfig } from './types.js'

export const AI_ACCESS_LEVELS: AiAccess[] = ['off', 'schema', 'read', 'write']

export interface EffectiveAiPermissions {
  access: AiAccess
  agents: boolean
  agentWrites: boolean
  knowledgeWrites: boolean
}

/**
 * What AI may do on a connection: its own permissions over the defaults, never more than the connection itself
 * allows (a read-only connection can't be written, also not by AI).
 */
export function resolveAiPermissions(config: Pick<ConnectionConfig, 'ai' | 'aiEnabled' | 'readOnly'>, defaults: AiPermissions): EffectiveAiPermissions {
  const p: AiPermissions = config.ai ?? (config.aiEnabled === false ? { ...defaults, access: 'off' } : defaults)
  let access = p.access
  if (config.readOnly && access === 'write') access = 'read'
  return {
    access,
    agents: access !== 'off' && p.agents !== false,
    agentWrites: access === 'write' && p.agents !== false && p.agentWrites === true,
    knowledgeWrites: access !== 'off' && p.knowledgeWrites !== false,
  }
}

/** Lowers `access` to at most `cap` (organization policies). */
export function capAccess(access: AiAccess, cap: AiAccess): AiAccess {
  return AI_ACCESS_LEVELS.indexOf(access) > AI_ACCESS_LEVELS.indexOf(cap) ? cap : access
}

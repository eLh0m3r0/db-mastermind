import { describe, expect, it } from 'vitest'
import { capAccess, resolveAiPermissions } from '../src/index.js'

const defaults = { access: 'write' as const, agents: true, agentWrites: false, knowledgeWrites: true }

describe('resolveAiPermissions', () => {
  it('uses the defaults, the legacy switch and the connection override', () => {
    expect(resolveAiPermissions({}, defaults)).toEqual({ access: 'write', agents: true, agentWrites: false, knowledgeWrites: true })
    expect(resolveAiPermissions({ aiEnabled: false }, defaults)).toEqual({ access: 'off', agents: false, agentWrites: false, knowledgeWrites: false })
    expect(resolveAiPermissions({ ai: { access: 'read', agents: false } }, defaults)).toEqual({ access: 'read', agents: false, agentWrites: false, knowledgeWrites: true })
  })
  it('never lets AI write to a read-only connection and needs write access for agent writes', () => {
    expect(resolveAiPermissions({ readOnly: true, ai: { access: 'write', agentWrites: true } }, defaults)).toMatchObject({ access: 'read', agentWrites: false })
    expect(resolveAiPermissions({ ai: { access: 'write', agentWrites: true } }, defaults).agentWrites).toBe(true)
    expect(resolveAiPermissions({ ai: { access: 'write', agentWrites: true, agents: false } }, defaults).agentWrites).toBe(false)
  })
  it('caps access levels', () => {
    expect(capAccess('write', 'schema')).toBe('schema')
    expect(capAccess('schema', 'read')).toBe('schema')
  })
})

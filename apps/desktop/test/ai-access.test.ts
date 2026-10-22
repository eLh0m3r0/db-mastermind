import type { ConnectionConfig } from '@dbmastermind/core'
import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ managed: null as unknown, team: null as unknown }))
vi.mock('../src/main/managed', () => ({ managedConfig: () => state.managed }))
vi.mock('../src/main/team', () => ({ team: () => state.team }))
vi.mock('../src/main/settings', () => ({
  getSettings: () => ({ ai: { dataSharing: 'full', defaults: { access: 'read', agents: true } }, mcp: { allowWrites: false } }),
}))

const { aiAccess, agentConnections } = await import('../src/main/ai-access')

const own: ConnectionConfig = { id: 'erp', name: 'ERP', driver: 'mssql', ai: { access: 'write', agents: true, agentWrites: true } }

describe('aiAccess', () => {
  it('uses the connection\'s own permissions', () => {
    state.managed = null
    state.team = null
    expect(aiAccess(own)).toMatchObject({ access: 'write', agentWrites: true })
  })

  it('AI turned off for the connection by the organization or the team can\'t be turned back on', () => {
    state.managed = { connections: [{ id: 'erp', name: 'ERP', driver: 'mssql', aiEnabled: false }] }
    expect(aiAccess({ ...own, aiEnabled: false })).toEqual({ access: 'off', agents: false, agentWrites: false, knowledgeWrites: false })
    expect(agentConnections([own])).toEqual([])
    state.managed = null
    state.team = { connections: [{ id: 'erp', name: 'ERP', driver: 'mssql', aiEnabled: false }] }
    expect(aiAccess(own).access).toBe('off')
  })

  it('a ban that was lifted no longer applies, even though the saved connection still says so', () => {
    state.managed = { connections: [{ id: 'erp', name: 'ERP', driver: 'mssql' }] }
    state.team = null
    expect(aiAccess({ ...own, aiEnabled: false, managed: true } as ConnectionConfig).access).toBe('write')
  })
})

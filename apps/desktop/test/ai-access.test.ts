import type { ConnectionConfig } from '@dbmastermind/core'
import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  managed: null as unknown,
  team: null as unknown,
  connections: [] as unknown[],
  ai: { dataSharing: 'full', defaults: { access: 'read', agents: true } } as Record<string, unknown>,
}))
vi.mock('../src/main/managed', () => ({ managedConfig: () => state.managed }))
vi.mock('../src/main/team', () => ({ team: () => state.team }))
vi.mock('../src/main/connections', () => ({ listConnections: () => state.connections }))
vi.mock('../src/main/settings', () => ({
  getSettings: () => ({ ai: state.ai, mcp: { allowWrites: false } }),
}))

const { aiAccess, agentConnections, turnedOffCentrally } = await import('../src/main/ai-access')

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

describe('a central AI ban follows the server, not the row', () => {
  const banned = { id: 'erp', name: 'ERP', driver: 'mssql' as const, host: 'erp.corp.local', port: 1433, database: 'erp', aiEnabled: false }
  // What the app makes from a connection: a duplicate, "Open another database…", an imported export, a project's .env.
  const derived: [string, ConnectionConfig][] = [
    ['a duplicate', { ...own, id: 'copy-1', name: 'ERP (copy)', host: 'erp.corp.local', port: 1433, database: 'erp' }],
    ['another database on the server', { ...own, id: 'other-db', name: 'ERP reports', host: 'ERP.corp.local', database: 'reports' }],
    ['an imported export', { ...own, id: 'imported', name: 'ERP', host: 'erp.corp.local', port: 1433 }],
    ['the same server through another driver name', { ...own, id: 'odbc', name: 'erp', driver: 'mssql', host: 'erp.corp.local ' }],
  ]

  for (const source of ['managed', 'team'] as const) {
    for (const [what, copy] of derived) {
      it(`${what} of a connection the ${source === 'managed' ? 'organization' : 'team folder'} banned is banned too`, () => {
        state.managed = source === 'managed' ? { connections: [banned] } : null
        state.team = source === 'team' ? { connections: [banned] } : null
        state.connections = [copy]
        expect(aiAccess(copy)).toEqual({ access: 'off', agents: false, agentWrites: false, knowledgeWrites: false })
        expect(turnedOffCentrally(copy.id)).toBe(true)
        expect(agentConnections([copy])).toEqual([])
      })
    }
  }

  it('another server, another port or a renamed connection on another server is not banned', () => {
    state.managed = { connections: [banned] }
    state.team = null
    expect(aiAccess({ ...own, id: 'x', host: 'crm.corp.local' }).access).toBe('write')
    expect(aiAccess({ ...own, id: 'y', host: 'erp.corp.local', port: 14330 }).access).toBe('write')
    expect(aiAccess({ ...own, id: 'z', name: 'ERP', host: 'other' }).access).toBe('write')
  })

  it('local addresses are one server; a file-based connection is banned by its file', () => {
    state.managed = { connections: [{ id: 'lite', name: 'Lite', driver: 'sqlite', filePath: '/data/shop.db', aiEnabled: false }, { id: 'pg', name: 'PG', driver: 'postgres', host: 'localhost', aiEnabled: false }] }
    state.team = null
    expect(aiAccess({ id: 'c', name: 'c', driver: 'sqlite', filePath: '/data/../data/shop.db' }).access).toBe('off')
    expect(aiAccess({ id: 'd', name: 'd', driver: 'postgres', host: '127.0.0.1', port: 5432 }).access).toBe('off')
    expect(aiAccess({ id: 'e', name: 'e', driver: 'postgres', host: '127.0.0.1', port: 54329 }).access).not.toBe('off')
  })

  it('a definition without a server bans only its own id', () => {
    state.managed = { connections: [{ id: 'vague', name: 'Vague', driver: 'postgres', aiEnabled: false }] }
    expect(aiAccess({ id: 'mine', name: 'Mine', driver: 'postgres' }).access).not.toBe('off')
    expect(aiAccess({ id: 'vague', name: 'Vague', driver: 'postgres' }).access).toBe('off')
  })
})

describe('the older app-wide data sharing is part of the one answer', () => {
  it('a stored "schema only" keeps every connection at schema, whatever the newer defaults say (MCP applied it on top)', () => {
    state.managed = null
    state.team = null
    state.ai = { dataSharing: 'schema', defaults: { access: 'write', agents: true, agentWrites: true } }
    expect(aiAccess({ id: 'a', name: 'a', driver: 'postgres' })).toMatchObject({ access: 'schema', agentWrites: false })
    expect(aiAccess(own)).toMatchObject({ access: 'schema', agentWrites: false })
    expect(agentConnections([own])[0]!.ai).toMatchObject({ access: 'schema', agentWrites: false })
  })

  it('newer defaults of schema only stay schema only when the older setting allows more', () => {
    state.ai = { dataSharing: 'full', defaults: { access: 'schema', agents: true } }
    expect(aiAccess({ id: 'a', name: 'a', driver: 'postgres' }).access).toBe('schema')
    state.ai = { dataSharing: 'schema-and-samples' }
    expect(aiAccess({ id: 'a', name: 'a', driver: 'postgres' }).access).toBe('write')
    state.ai = { dataSharing: 'full', defaults: { access: 'read', agents: true } }
  })
})


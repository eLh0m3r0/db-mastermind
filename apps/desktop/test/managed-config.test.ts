import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { enforceManagedSettings, managedConfigPaths, mergeManagedConnections, readManagedConfig, type ManagedConfig } from '../src/main/managed-config'
import type { AppSettings, StoredConnection } from '../src/shared/api'

const now = '2026-01-01T00:00:00.000Z'
const managed: ManagedConfig = {
  connections: [
    { id: 'erp-prod', name: 'ERP production', driver: 'mssql', host: 'erp.corp', port: 1433, database: 'erp', readOnly: true, production: true, password: 'leaked?' },
    { id: 'dwh', name: 'DWH', driver: 'postgres', host: 'dwh.corp', database: 'dwh' },
  ],
  aiProviders: [{ id: 'azure', enabled: true, resourceName: 'corp-openai', model: 'gpt-5' }],
  defaultAiProvider: 'azure',
  policies: { allowedAiProviders: ['azure', 'ollama'], maxAiDataSharing: 'schema', allowMcpWrites: false },
}

const settings = (patch: Partial<AppSettings['ai']> = {}): AppSettings =>
  ({
    theme: 'system',
    language: 'en',
    ai: { providers: [{ id: 'anthropic', enabled: true, apiKey: 'sk' }, { id: 'azure', enabled: true, apiKey: 'mine', resourceName: 'old' }], dataSharing: 'full', autoRunReadQueries: true, activeProvider: 'anthropic', ...patch },
    mcp: { enabled: true, port: 7337, token: 't', allowWrites: true },
  }) as AppSettings

describe('mergeManagedConnections', () => {
  it('adds managed connections without secrets and keeps the user credentials', () => {
    const stored = [{ id: 'erp-prod', name: 'my name', driver: 'mssql', host: 'old-host', user: 'jan', password: 'secret', createdAt: now, updatedAt: now } as StoredConnection]
    const out = mergeManagedConnections(stored, managed, now)
    const erp = out.find((c) => c.id === 'erp-prod')!
    expect(erp).toMatchObject({ name: 'ERP production', host: 'erp.corp', user: 'jan', password: 'secret', readOnly: true, managed: true })
    const dwh = out.find((c) => c.id === 'dwh')!
    expect(dwh).toMatchObject({ host: 'dwh.corp', managed: true, createdAt: now })
    expect(dwh.password).toBeUndefined()
  })
  it('turns AI off on every connection when the policy says so, and unmarks removed managed entries', () => {
    const stored = [{ id: 'x', name: 'x', driver: 'sqlite', managed: true, createdAt: now, updatedAt: now } as StoredConnection]
    const out = mergeManagedConnections(stored, { policies: { allowAi: false } }, now)
    expect(out).toEqual([{ id: 'x', name: 'x', driver: 'sqlite', managed: undefined, createdAt: now, updatedAt: now, aiEnabled: false }])
  })
})

describe('enforceManagedSettings', () => {
  it('restricts providers, keeps keys, caps data sharing and MCP writes', () => {
    const out = enforceManagedSettings(settings(), managed)
    expect(out.ai.providers).toEqual([{ id: 'azure', enabled: true, apiKey: 'mine', resourceName: 'corp-openai', model: 'gpt-5' }])
    expect(out.ai.activeProvider).toBeUndefined()
    expect(out.ai.dataSharing).toBe('schema')
    expect(out.mcp).toMatchObject({ enabled: true, allowWrites: false })
  })
  it('uses the default provider and switches MCP off', () => {
    const out = enforceManagedSettings(settings({ activeProvider: undefined }), { ...managed, policies: { allowMcp: false } })
    expect(out.ai.activeProvider).toBe('azure')
    expect(out.mcp).toMatchObject({ enabled: false, allowWrites: false })
  })
})

describe('readManagedConfig', () => {
  it('finds the file next to the app and fails closed on a broken one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbm-managed-'))
    const paths = managedConfigPaths(join(dir, 'DB Mastermind.exe'), 'win32', {})
    expect(paths[0]).toBe(join(dir, 'dbmastermind-managed.json'))
    expect(readManagedConfig(paths)).toBeNull()
    writeFileSync(paths[0]!, JSON.stringify(managed))
    expect(readManagedConfig(paths)?.info).toMatchObject({ connections: 2, policies: managed.policies })
    writeFileSync(paths[0]!, '{ broken')
    expect(readManagedConfig(paths)?.info).toMatchObject({ policies: { allowAi: false, allowMcp: false }, error: expect.any(String) })
  })
})

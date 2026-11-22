import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { DatabaseService, type ConnectionConfig } from '@dbmastermind/core'
import { afterAll, describe, expect, it } from 'vitest'
import { createMcpServer } from '../src/server'

/** The server itself never serves a connection whose own AI permissions exclude agents, whoever built its list. */

const dir = mkdtempSync(join(tmpdir(), 'dbm-not-shared-'))
const db = new DatabaseService()
afterAll(async () => {
  await db.disconnectAll()
  rmSync(dir, { recursive: true, force: true })
})

const text = (r: unknown) => ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join('\n')
const connection = (name: string, ai: ConnectionConfig['ai']): ConnectionConfig => ({ id: name, name, driver: 'sqlite', filePath: join(dir, `${name}.db`), ai })

async function clientFor(connections: ConnectionConfig[]) {
  const server = createMcpServer({ db, connections })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(b)
  return client
}

describe('a connection not shared with agents', () => {
  const open = connection('open', { access: 'read', agents: true, agentWrites: false, knowledgeWrites: false })
  const off = connection('off', { access: 'off', agents: true, agentWrites: false, knowledgeWrites: false })
  const appOnly = connection('apponly', { access: 'read', agents: false, agentWrites: false, knowledgeWrites: false })

  it('is not listed, has no schema resource and no tool runs on it', async () => {
    const client = await clientFor([open, off, appOnly])
    const listed = text(await client.callTool({ name: 'list_connections', arguments: {} }))
    expect(listed).toContain('open')
    expect(listed).not.toMatch(/off|apponly/)
    expect((await client.listResources()).resources.map((r) => r.name).join(' ')).not.toMatch(/off|apponly/)
    for (const name of ['off', 'apponly']) {
      for (const call of [
        { name: 'list_tables', arguments: { connection: name } },
        { name: 'run_query', arguments: { connection: name, sql: 'SELECT 1' } },
        { name: 'sample_rows', arguments: { connection: name, table: 'sqlite_master' } },
      ]) {
        expect(text(await client.callTool(call))).toMatch(/is not shared with AI agents/)
      }
      await expect(client.readResource({ uri: `dbmastermind://${name}/schema` })).rejects.toThrow(/not shared with AI agents/)
      await expect(client.getPrompt({ name: 'explore_database', arguments: { connection: name } })).rejects.toThrow(/not shared with AI agents/)
      // Nothing was even opened.
      expect(db.isOpen(name)).toBe(false)
    }
  })

  it('a server whose only connection is turned off serves nothing by default either', async () => {
    const client = await clientFor([off])
    expect(text(await client.callTool({ name: 'list_connections', arguments: {} }))).toBe('No connections are shared with agents.')
    expect(text(await client.callTool({ name: 'run_query', arguments: { sql: 'SELECT 1' } }))).toMatch(/is not shared with AI agents/)
    expect(db.isOpen('off')).toBe(false)
  })
})

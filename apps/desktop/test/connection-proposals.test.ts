import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { DatabaseService } from '@dbmastermind/core'
import { createMcpServer } from 'dbmastermind-mcp'
import { dismissProposal, listProposals, writeProposal } from '../src/main/connection-proposals'

const root = mkdtempSync(join(tmpdir(), 'dbm-proposals-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const now = '2026-11-14T10:00:00.000Z'

describe('connection proposals on disk', () => {
  it('writes, lists oldest first and dismisses', async () => {
    const dir = join(root, 'a')
    const first = await writeProposal(dir, { name: 'A', driver: 'postgres', host: 'h', proposedAt: now })
    await new Promise((r) => setTimeout(r, 5))
    await writeProposal(dir, { name: 'B', driver: 'mysql', host: 'h', proposedAt: now })
    expect((await listProposals(dir)).map((x) => x.proposal.name)).toEqual(['A', 'B'])
    await dismissProposal(dir, first)
    expect((await listProposals(dir)).map((x) => x.proposal.name)).toEqual(['B'])
  })

  it('validates files again and removes what is not a proposal; refuses paths outside the folder', async () => {
    const dir = join(root, 'b')
    await writeProposal(dir, { name: 'ok', driver: 'postgres', host: 'h', proposedAt: now })
    writeFileSync(join(dir, '1-aaaaaaaaaaaa.json'), JSON.stringify({ name: 'x', driver: 'mongodb', host: 'h' }))
    writeFileSync(join(dir, '2-bbbbbbbbbbbb.json'), '{ not json')
    expect((await listProposals(dir)).map((x) => x.proposal.name)).toEqual(['ok'])
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(1)
    await expect(dismissProposal(dir, '../connections.json')).rejects.toThrow(/Not a proposal/)
  })

  it('keeps at most 20 waiting', async () => {
    const dir = join(root, 'c')
    for (let i = 0; i < 23; i++) await writeProposal(dir, { name: `p${i}`, driver: 'postgres', host: 'h', proposedAt: now })
    expect(await listProposals(dir)).toHaveLength(20)
  })
})

describe('MCP propose_connection', () => {
  const connect = async (proposeConnection?: Parameters<typeof createMcpServer>[0]['proposeConnection']) => {
    const server = createMcpServer({ db: new DatabaseService(), connections: [], proposeConnection })
    const [a, b] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-agent', version: '1' })
    await Promise.all([server.connect(a), client.connect(b)])
    return client
  }

  it('is offered only when the app takes proposals, and hands them over without the password', async () => {
    expect((await (await connect()).listTools()).tools.map((t) => t.name)).not.toContain('propose_connection')
    const dir = join(root, 'mcp')
    const client = await connect(async (p) => void (await writeProposal(dir, p)))
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('propose_connection')
    const r = await client.callTool({ name: 'propose_connection', arguments: { name: 'Shop', url: 'postgres://app:s3cret@db.local/shop' } })
    expect(JSON.stringify(r.content)).toMatch(/types the password and saves it/)
    const [saved] = await listProposals(dir)
    expect(saved?.proposal).toMatchObject({ name: 'Shop', driver: 'postgres', host: 'db.local', database: 'shop', user: 'app', proposedBy: 'test-agent' })
    expect(JSON.stringify(saved)).not.toContain('s3cret')
    const bad = await client.callTool({ name: 'propose_connection', arguments: { driver: 'postgres' } })
    expect(bad.isError).toBe(true)
  })
})

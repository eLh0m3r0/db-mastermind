import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { DatabaseService, type ConnectionConfig } from '@dbmastermind/core'
import { createMcpServer } from 'dbmastermind-mcp'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * AI permissions are decided when they are used: a connection whose AI is turned off or lowered while an agent is
 * connected (the HTTP endpoint, the `--mcp` stdio server) gets the new permissions on its next call.
 */

const dir = mkdtempSync(join(tmpdir(), 'dbm-live-'))
const state = vi.hoisted(() => ({
  connections: [] as ConnectionConfig[],
  managed: null as unknown,
  team: null as unknown,
  reloads: [] as string[],
  settings: {
    ai: { providers: [], dataSharing: 'schema-and-samples', autoRunReadQueries: true, defaults: { access: 'read', agents: true } },
    mcp: { enabled: true, port: 0, token: 'test-token-0123456789abcdef', allowWrites: false },
  } as Record<string, any>,
  db: undefined as unknown,
}))
vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test', getPath: () => '/nonexistent', exit: () => undefined }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../src/main/api', () => ({ get db() { return state.db } }))
vi.mock('../src/main/connections', () => ({ listConnections: () => state.connections, loadConnections: async () => void state.reloads.push('connections') }))
vi.mock('../src/main/settings', () => ({ getSettings: () => state.settings, loadSettings: async () => void state.reloads.push('settings') }))
vi.mock('../src/main/managed', () => ({ managedConfig: () => state.managed, managed: () => null, reloadManaged: () => void state.reloads.push('managed') }))
vi.mock('../src/main/team', () => ({ team: () => state.team, invalidateTeam: () => void state.reloads.push('team') }))
vi.mock('../src/main/library', () => ({ addHistory: () => undefined, MCP_HISTORY_FILE: 'mcp-history.jsonl' }))
vi.mock('../src/main/storage', () => ({ dataPath: (f: string) => join(dir, f) }))
vi.mock('../src/main/connection-proposals', () => ({ writeProposal: async () => undefined, PROPOSALS_FOLDER: 'proposals' }))
vi.mock('../src/main/password-command', () => ({ withCommandPassword: async (c: ConnectionConfig) => c }))
vi.mock('../src/main/proposals-watch', () => ({ notifyProposals: () => undefined, proposalsDir: () => dir }))

const { applyMcpHttp } = await import('../src/main/mcp-http')
const { currentlyShared } = await import('../src/main/mcp-mode')
const { agentConnections } = await import('../src/main/ai-access')
const { askParent, guardMcpTransport, LiveConnections } = await import('../src/main/mcp-live')

const db = new DatabaseService()
state.db = db
const file = join(dir, 'shop.db')
const shop: ConnectionConfig = { id: 'shop', name: 'Shop', driver: 'sqlite', filePath: file, ai: { access: 'write', agents: true, agentWrites: true, knowledgeWrites: true } }
const other: ConnectionConfig = { id: 'crm', name: 'CRM', driver: 'sqlite', filePath: join(dir, 'crm.db'), ai: { access: 'read', agents: true } }
const text = (r: unknown) => ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join('\n')
const query = { name: 'run_query', arguments: { connection: 'Shop', sql: 'SELECT name FROM items' } }
const insert = { name: 'run_query', arguments: { connection: 'Shop', sql: "INSERT INTO items VALUES ('pear')" } }
const setShop = (ai: ConnectionConfig['ai']) => (state.connections = [{ ...shop, ai }, other])

beforeAll(async () => {
  await db.connect(shop)
  await db.runScript('shop', "CREATE TABLE items (name text); INSERT INTO items VALUES ('apple')")
  await db.disconnect('shop')
})
afterAll(async () => {
  await db.disconnectAll()
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  setShop(shop.ai)
  state.managed = null
  state.team = null
  state.reloads = []
})

/** The same steps for every path: what an agent already connected sees after each change. */
async function lowerMidSession(client: Client) {
  expect(text(await client.callTool(query))).toContain('apple')
  setShop({ access: 'read', agents: true, agentWrites: false })
  const write = await client.callTool(insert)
  expect(text(write)).not.toMatch(/^1 row|inserted/i)
  expect((await db.runScript('shop', 'SELECT count(*) FROM items'))[0]!.results![0]!.rows[0]![0]).toBe(1)
  setShop({ access: 'schema', agents: true })
  expect(text(await client.callTool(query))).not.toContain('apple')
  setShop({ access: 'off', agents: false })
  const refused = await client.callTool(query)
  expect(refused.isError).toBe(true)
  expect(text(refused)).toBe('"Shop" is no longer shared with AI agents in DB Mastermind (its AI permissions, or your organization\'s or team\'s settings), so this was not run.')
  // The organization's ban, set after the agent connected, counts the same.
  setShop(shop.ai)
  expect(text(await client.callTool(query))).toContain('apple')
  state.managed = { connections: [{ id: 'other-row', name: 'Shop elsewhere', driver: 'sqlite', filePath: file, aiEnabled: false }] }
  expect(text(await client.callTool(query))).toMatch(/no longer shared/)
  expect(text(await client.callTool({ name: 'list_connections', arguments: {} }))).not.toContain('Shop')
}

describe('the HTTP endpoint', () => {
  let url = ''
  beforeAll(async () => {
    state.settings.mcp.port = 47000 + Math.floor(Math.random() * 2000)
    expect(await applyMcpHttp()).toEqual({ running: true })
    url = `http://127.0.0.1:${state.settings.mcp.port}/mcp`
  })
  afterAll(async () => {
    state.settings.mcp.enabled = false
    await applyMcpHttp()
  })
  const client = async (authorization: string) => {
    const c = new Client({ name: 'test', version: '1' })
    await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: authorization } } }))
    return c
  }

  it('takes the token only as "Bearer <token>"', async () => {
    const post = (authorization: string) =>
      fetch(url, { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    const token = state.settings.mcp.token as string
    expect((await post(token)).status).toBe(401)
    expect((await post(`bearer ${token}`)).status).toBe(401)
    expect((await post(`Bearer  ${token}`)).status).toBe(401)
    expect((await post(`Bearer ${token}x`)).status).toBe(401)
    const ok = await post(`Bearer ${token}`)
    expect(ok.status).toBe(200)
    const body = await ok.text()
    expect(body).not.toContain(token)
  })

  it('a permission lowered or turned off while the agent is connected applies to its next call', async () => {
    await lowerMidSession(await client(`Bearer ${state.settings.mcp.token}`))
  })
})

describe('the --mcp stdio server', () => {
  /** The child's server and guard, its questions answered by the parent's `currentlyShared` (as over IPC). */
  async function stdioClient() {
    const initial = await currentlyShared(undefined)
    const live = new LiveConnections(initial, [], undefined)
    const parent = new Set<(m: unknown) => void>()
    const current = askParent(
      (m) => void currentlyShared(undefined).then((connections) => parent.forEach((l) => l({ type: 'connections', seq: m.seq, connections }))),
      (listener) => (parent.add(listener), () => void parent.delete(listener)),
    )
    const server = createMcpServer({ db, connections: live.list, version: 'test' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    guardMcpTransport(a, live, async () => live.set(await current()))
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(b)
    return client
  }

  it('a permission lowered or turned off after the server started applies to the next call', async () => {
    await lowerMidSession(await stdioClient())
  })

  it('the parent reads what the app saved again for every request: connections, settings, managed configuration, team folder', async () => {
    const client = await stdioClient()
    state.reloads = []
    await client.callTool(query)
    await client.callTool(query)
    expect(state.reloads.filter((r) => r === 'connections')).toHaveLength(2)
    expect(new Set(state.reloads)).toEqual(new Set(['managed', 'team', 'settings', 'connections']))
  })

  it('a server started with one connection refuses plainly when it is turned off (calls name no connection then)', async () => {
    state.connections = [shop]
    const live = new LiveConnections(agentConnections(state.connections), [], 'shop')
    const server = createMcpServer({ db, connections: live.list, version: 'test' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    guardMcpTransport(a, live, () => live.set(agentConnections(state.connections)))
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(b)
    expect(text(await client.callTool({ name: 'run_query', arguments: { sql: 'SELECT name FROM items' } }))).toContain('apple')
    state.connections = [{ ...shop, ai: { access: 'off' } }]
    const refused = await client.callTool({ name: 'run_query', arguments: { sql: 'SELECT name FROM items' } })
    expect(text(refused)).toMatch(/"Shop" is no longer shared/)
    await expect(client.readResource({ uri: 'dbmastermind://Shop/schema' })).rejects.toThrow(/no longer shared/)
  })

  it('when the permissions can\'t be read, nothing runs on the old ones', async () => {
    const live = new LiveConnections(agentConnections(state.connections))
    const server = createMcpServer({ db, connections: live.list, version: 'test' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    guardMcpTransport(a, live, () => Promise.reject(new Error('parent gone')))
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(b)
    expect(text(await client.callTool(query))).toMatch(/could not read the current AI permissions/)
  })

  it('a parent that never answers is a refusal, not a hang', async () => {
    vi.useFakeTimers()
    const ask = askParent(() => undefined, () => () => undefined, 1000)
    const pending = ask()
    vi.advanceTimersByTime(1001)
    await expect(pending).rejects.toThrow(/No answer/)
    vi.useRealTimers()
  })
})

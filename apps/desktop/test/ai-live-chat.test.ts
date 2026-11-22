import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { agentDatabase, DatabaseService, DB_TOOLS, type ConnectionConfig, type ToolContext } from '@dbmastermind/core'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The app's own assistant decides AI permissions when they are used: a chat already running gets the connection's
 * new permissions on its next tool call, and an approval the user gives after AI was lowered runs nothing.
 */

const dir = mkdtempSync(join(tmpdir(), 'dbm-live-chat-'))
const state = vi.hoisted(() => ({
  connections: [] as ConnectionConfig[],
  managed: null as unknown,
  db: undefined as unknown,
}))
vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test', isPackaged: false, getAppPath: () => '' }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../src/main/api', () => ({ get db() { return state.db }, ensureConnected: async () => undefined }))
vi.mock('../src/main/connections', () => ({
  listConnections: () => state.connections,
  getConnection: (id: string) => {
    const c = state.connections.find((x) => x.id === id)
    if (!c) throw new Error('Connection not found')
    return c
  },
}))
vi.mock('../src/main/settings', () => ({ getSettings: () => ({ ai: { providers: [], dataSharing: 'schema-and-samples', autoRunReadQueries: false, defaults: { access: 'read', agents: true } }, mcp: { allowWrites: false } }) }))
vi.mock('../src/main/managed', () => ({ managedConfig: () => state.managed }))
vi.mock('../src/main/team', () => ({ team: () => null }))
vi.mock('../src/main/library', () => ({ addHistory: () => undefined }))
vi.mock('../src/main/transactions', () => ({ trackEditorSession: () => undefined }))
vi.mock('../src/main/ai/complete', () => ({ activeProvider: () => ({ id: 'openai' }) }))
vi.mock('../src/main/ai/cli', () => ({ runCli: async () => undefined }))
vi.mock('../src/main/ai/models', () => ({ createModel: () => undefined }))

const { chatPermissions } = await import('../src/main/ai/assistant')
const { chatMcpEndpoint } = await import('../src/main/ai/chat-mcp')

const db = new DatabaseService()
state.db = db
const shop: ConnectionConfig = { id: 'shop', name: 'Shop', driver: 'sqlite', filePath: join(dir, 'shop.db'), ai: { access: 'write', agents: true, knowledgeWrites: true } }
const setShop = (ai: ConnectionConfig['ai']) => (state.connections = [{ ...shop, ai }])
const count = async () => (await db.runScript('shop', 'SELECT count(*) FROM items'))[0]!.results![0]!.rows[0]![0]
const runQuery = DB_TOOLS.find((t) => t.name === 'run_query')!
// As the app makes it: the tools get the guarded view, made again for the permissions of the moment.
const view = (allowData: boolean) => agentDatabase(db, { allowData })
const base: ToolContext = { db: view(false), connectionId: 'shop', maxRows: 50, allowData: false, allowKnowledgeWrites: false }

beforeAll(async () => {
  await db.connect(shop)
  await db.runScript('shop', "CREATE TABLE items (name text); INSERT INTO items VALUES ('apple')")
})
afterAll(async () => {
  await db.disconnectAll()
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  setShop(shop.ai)
  state.managed = null
})

describe('a chat with the API providers', () => {
  it('each tool call gets the permissions of that moment', async () => {
    const chat = chatPermissions('shop', async () => true, true)
    expect(chat.context(base, view)).toMatchObject({ allowData: true, allowKnowledgeWrites: true })
    expect(await chat.gate('run_query', { sql: 'SELECT 1' })).toBeUndefined()
    expect(await runQuery.run(chat.context(base, view), { sql: 'SELECT name FROM items' })).toContain('apple')
    setShop({ access: 'schema', agents: true })
    expect(chat.context(base, view)).toMatchObject({ allowData: false, confirmWrite: undefined })
    const refused = await runQuery.run(chat.context(base, view), { sql: 'SELECT name FROM items' }).catch((e: Error) => e.message)
    expect(refused).not.toContain('apple')
    expect(refused).toMatch(/only shares the schema/)
    setShop({ access: 'off' })
    expect(await chat.gate('run_query', { sql: 'SELECT 1' })).toBe('AI is turned off for "Shop" now (its AI permissions in DB Mastermind), so this was not run.')
    // The organization's ban, put on the server after the chat started, counts the same.
    setShop(shop.ai)
    state.managed = { connections: [{ id: 'elsewhere', name: 'Shop', driver: 'sqlite', filePath: shop.filePath, aiEnabled: false }] }
    expect(await chat.gate('describe_table', { table: 'items' })).toMatch(/turned off/)
  })

  it('a write approved after AI was lowered meanwhile does not run', async () => {
    const before = await count()
    const chat = chatPermissions(
      'shop',
      async () => {
        setShop({ access: 'read', agents: true })
        return true
      },
      true,
    )
    const out = await runQuery.run(chat.context(base, view), { sql: "INSERT INTO items VALUES ('pear')" }).catch((e: Error) => e.message)
    expect(out).toMatch(/no longer change data in "Shop"/)
    expect(await count()).toBe(before)
  })

  it('"Approve all" does not outlive the permission: every write checks again', async () => {
    let calls = 0
    const chat = chatPermissions('shop', async () => (++calls, true), true)
    const ctx = chat.context(base, view)
    expect(await chat.confirmWrite("INSERT INTO items VALUES ('kiwi')")).toBe(true)
    setShop({ access: 'read', agents: true })
    await expect(ctx.confirmWrite!("INSERT INTO items VALUES ('fig')")).rejects.toThrow(/no longer change data/)
    expect(calls).toBe(1)
  })

  it('an approved read, a knowledge file and a deleted connection are checked after the answer too', async () => {
    const chat = chatPermissions('shop', async () => (setShop({ access: 'schema', agents: true, knowledgeWrites: false }), true), false)
    expect(await chat.gate('run_query', { sql: 'SELECT name FROM items' })).toMatch(/only the schema of "Shop"/)
    setShop(shop.ai)
    expect(await chat.gate('write_knowledge', { path: 'a.md', content: 'x' })).toMatch(/no longer save knowledge base files/)
    state.connections = []
    expect(await chat.gate('describe_table', { table: 'items' })).toMatch(/AI is turned off for "shop"/)
  })
})

describe('a chat through an agent CLI (the assistant\'s MCP endpoint)', () => {
  it('a permission lowered or turned off during the chat applies to the next call', async () => {
    const chat = chatPermissions('shop', async () => true, true)
    const endpoint = await chatMcpEndpoint({ id: 'shop', name: 'Shop' }, () => ({ db, connections: chat.mcpConnections(), confirmWrite: chat.confirmWrite, beforeTool: chat.gate }))
    const client = new Client({ name: 'cli', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: endpoint.headers } }))
    const text = (r: unknown) => ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join('\n')
    const select = { name: 'run_query', arguments: { sql: 'SELECT name FROM items' } }
    expect(text(await client.callTool(select))).toContain('apple')
    setShop({ access: 'schema', agents: true })
    expect(text(await client.callTool(select))).not.toContain('apple')
    setShop({ access: 'off' })
    const refused = await client.callTool(select)
    expect(text(refused)).toMatch(/"Shop" is no longer shared/)
    await expect(client.readResource({ uri: 'dbmastermind://Shop/schema' })).rejects.toThrow(/no longer shared/)
    setShop(shop.ai)
    expect(text(await client.callTool(select))).toContain('apple')
    endpoint.close()
    const bare = await fetch(endpoint.url, { method: 'POST', headers: { Authorization: endpoint.headers.Authorization!.replace('Bearer ', ''), 'Content-Type': 'application/json' }, body: '{}' })
    expect(bare.status).toBe(401)
  })
})

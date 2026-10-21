// Verifies the packaged app works as a stdio MCP server (`--mcp`) with saved connections.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const exe = process.argv[2]
const userData = mkdtempSync(join(tmpdir(), 'dbm-mcp-'))
writeFileSync(
  join(userData, 'connections.json'),
  JSON.stringify([
    { id: 'pg1', name: 'Shop', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind', createdAt: '', updatedAt: '' },
    { id: 'hidden', name: 'Secret', driver: 'postgres', host: '127.0.0.1', port: 54329, aiEnabled: false, createdAt: '', updatedAt: '' },
  ]),
)
const client = new Client({ name: 'check', version: '1' })
await client.connect(new StdioClientTransport({ command: exe, args: ['--mcp'], env: { ...process.env, DBM_USER_DATA: userData } }))
const conns = await client.callTool({ name: 'list_connections', arguments: {} })
console.log(conns.content[0].text)
const q = await client.callTool({ name: 'run_query', arguments: { sql: 'select count(*) as n from shop.customers' } })
console.log(q.content[0].text)
await client.close()

// Smoke test of a packaged build: launches the real executable as an MCP server over stdio and
// queries a SQLite database through it. Proves the app boots, finds its data folder and that the
// SQLite worker runs inside Electron on this platform.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const exe = process.argv[2]
const dir = mkdtempSync(join(tmpdir(), 'dbm-smoke-'))
const dbPath = join(dir, 'smoke.db')
const db = new DatabaseSync(dbPath)
db.exec(`CREATE TABLE fruit (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO fruit (name) VALUES ('apple'), ('pear'), ('plum');`)
db.close()
writeFileSync(join(dir, 'connections.json'), JSON.stringify([{ id: 's1', name: 'Smoke', driver: 'sqlite', filePath: dbPath, createdAt: '', updatedAt: '' }]))

const client = new Client({ name: 'smoke', version: '1' })
const timer = setTimeout(() => {
  console.error('Timed out')
  process.exit(1)
}, 90_000)
const transport = new StdioClientTransport({ command: exe, args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), '--mcp'], env: { ...process.env, DBM_USER_DATA: dir, DBM_NO_UPDATE_CHECK: '1' }, stderr: 'pipe' })
transport.stderr?.on('data', (d) => process.stderr.write(`[app] ${d}`))
await client.connect(transport)
const text = (r) => r.content.map((c) => c.text).join('\n')
const tables = text(await client.callTool({ name: 'list_tables', arguments: {} }))
const count = text(await client.callTool({ name: 'run_query', arguments: { sql: 'SELECT COUNT(*) AS n FROM fruit' } }))
console.log(tables)
console.log(count)
await client.close()
clearTimeout(timer)
if (!tables.includes('fruit') || !/^n\n3\b/m.test(count)) {
  console.error('Unexpected output')
  process.exit(1)
}
console.log('SMOKE OK')
process.exit(0)

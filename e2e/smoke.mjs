// Smoke test of a packaged build: launches the real executable as an MCP server over stdio and
// queries a SQLite database through it. Proves the app boots, finds its data folder and that the
// SQLite worker and the DuckDB native binding run inside Electron on this platform.
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
const csvPath = join(dir, 'sales.csv')
writeFileSync(csvPath, 'city;amount\nPraha;10,5\nBrno;20\n')
// A file nobody handed to the Duck connection: an agent may not read it.
const otherPath = join(dir, 'other.csv')
writeFileSync(otherPath, 'amount\n1\n')
writeFileSync(
  join(dir, 'connections.json'),
  JSON.stringify([
    { id: 's1', name: 'Smoke', driver: 'sqlite', filePath: dbPath, createdAt: '', updatedAt: '' },
    // (`files`: what the user opened with this connection, Query a file; agents may read those and no others.)
    { id: 'd1', name: 'Duck', driver: 'duckdb', files: [csvPath], createdAt: '', updatedAt: '' },
  ]),
)

const client = new Client({ name: 'smoke', version: '1' })
const timer = setTimeout(() => {
  console.error('Timed out')
  process.exit(1)
}, 90_000)
const transport = new StdioClientTransport({ command: exe, args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), '--mcp'], env: { ...process.env, DBM_USER_DATA: dir, DBM_NO_UPDATE_CHECK: '1' }, stderr: 'pipe' })
transport.stderr?.on('data', (d) => process.stderr.write(`[app] ${d}`))
await client.connect(transport)
const text = (r) => r.content.map((c) => c.text).join('\n')
const tables = text(await client.callTool({ name: 'list_tables', arguments: { connection: 'Smoke' } }))
const count = text(await client.callTool({ name: 'run_query', arguments: { connection: 'Smoke', sql: 'SELECT COUNT(*) AS n FROM fruit' } }))
const duck = text(
  await client.callTool({ name: 'run_query', arguments: { connection: 'Duck', sql: `SELECT sum(amount) AS total FROM read_csv('${csvPath.replaceAll("'", "''")}', decimal_separator = ',')` } }),
)
const refused = text(await client.callTool({ name: 'run_query', arguments: { connection: 'Duck', sql: `SELECT * FROM read_csv('${otherPath.replaceAll("'", "''")}')` } }))
console.log(tables)
console.log(count)
console.log(duck)
console.log(refused)
await client.close()
clearTimeout(timer)
const sentence = `"${otherPath}" can't be read here: open it in DB Mastermind with Query a file, or allow it with --allow-files (dbmastermind-mcp, dbm).`
if (!tables.includes('fruit') || !/^n\n3\b/m.test(count) || !/^total\n30\.5\b/m.test(duck) || !refused.includes(sentence)) {
  console.error('Unexpected output')
  process.exit(1)
}
console.log('SMOKE OK')
process.exit(0)

// The package as npm would publish it: `npm pack`, installed into an empty folder, started the way users start it
// (`npx dbmastermind-mcp` over stdio, `npx dbm query`). Outside the repository nothing from the workspace's
// node_modules can hide a missing dependency or a file left out of the tarball. The MCP client is a few lines of
// JSON-RPC rather than the SDK, so the server is checked against the wire protocol itself.
//
//   node packages/mcp/test/packed-package.mjs [--tarball dbmastermind-mcp-x.y.z.tgz] [work folder]
//
// Without --tarball it packs packages/mcp first. CI (ci.yml, mcp-package) packs once and runs this on Linux, macOS
// and Windows with Node 22.16 (the engines floor) and 24. DBM_KEEP=1 keeps the work folder.
import { execSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
// --tarball takes the file or a folder holding one .tgz (CI downloads it into a folder).
let tarballArg = args[0] === '--tarball' ? resolve(args.splice(0, 2)[1]) : undefined
if (tarballArg && statSync(tarballArg).isDirectory()) {
  const found = readdirSync(tarballArg).filter((f) => f.endsWith('.tgz'))
  if (found.length !== 1) fail(`expected one .tgz in ${tarballArg}, found ${found.length}`)
  tarballArg = join(tarballArg, found[0])
}
const work = args[0] ? resolve(args[0]) : mkdtempSync(join(tmpdir(), 'dbm-packed-'))
const app = join(work, 'app')
mkdirSync(app, { recursive: true })
const windows = process.platform === 'win32'
const quote = (s) => (windows ? `"${s}"` : `'${s.replaceAll("'", `'\\''`)}'`)
const sh = (cmd, cwd) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
const seconds = (t0) => ((Date.now() - t0) / 1000).toFixed(1)
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
function folderSize(dir) {
  let total = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) total += folderSize(p)
    else if (e.isFile()) total += statSync(p).size
  }
  return total
}
function fail(message) {
  console.error(`PACKED PACKAGE FAILED: ${message}`)
  process.exit(1)
}
const deadline = setTimeout(() => fail('timed out after 5 minutes'), 5 * 60_000)

console.log(`node ${process.version}, npm ${sh('npm --version').trim()}, ${process.platform}-${process.arch}`)

let t0 = Date.now()
let tarball = tarballArg
if (!tarball) {
  // prepack builds dist/, as `npm publish` does.
  const packed = JSON.parse(sh(`npm pack --json --pack-destination ${quote(work)}`, pkgDir))[0]
  tarball = join(work, packed.filename)
  console.log(`packed in ${seconds(t0)} s`)
}
console.log(`${basename(tarball)}: ${mb(statSync(tarball).size)}`)

writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'packed-check', private: true }))
t0 = Date.now()
sh(`npm install --no-audit --no-fund ${quote(tarball)}`, app)
console.log(`installed in ${seconds(t0)} s, node_modules ${mb(folderSize(join(app, 'node_modules')))}`)
const installed = join(app, 'node_modules', 'dbmastermind-mcp')
for (const f of ['dist/cli.js', 'dist/dbm.js', 'README.md', 'LICENSE', 'server.json']) {
  if (!existsSync(join(installed, f))) fail(`${f} is not in the package`)
}
const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
const serverJson = JSON.parse(readFileSync(join(installed, 'server.json'), 'utf8'))
if (manifest.mcpName !== serverJson.name) fail(`mcpName ${manifest.mcpName} differs from server.json's name ${serverJson.name}`)
if (serverJson.version !== manifest.version || serverJson.packages?.[0]?.version !== manifest.version) {
  fail(`server.json is for ${serverJson.version}, the package is ${manifest.version}`)
}

const dbPath = join(work, 'shop.db')
const db = new DatabaseSync(dbPath)
db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  INSERT INTO customers (name) VALUES ('Alice'), ('Bob'), ('Carol');`)
db.close()
const url = `sqlite://${dbPath}`

// --no-install: run the installed bin, never one downloaded from the registry (a bare --no swallows the arguments).
const server = spawn(`npx --no-install dbmastermind-mcp --url ${quote(url)} --name shop`, {
  cwd: app,
  shell: true,
  stdio: ['pipe', 'pipe', 'pipe'],
})
let stderr = ''
server.stderr.on('data', (d) => (stderr += d))
server.on('exit', (code) => {
  if (pending.size) fail(`the server exited (${code}) before answering\n${stderr}`)
})
const pending = new Map()
let buffer = ''
server.stdout.on('data', (d) => {
  buffer += d
  for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
    const line = buffer.slice(0, i).trim()
    buffer = buffer.slice(i + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      fail(`not JSON-RPC on stdout: ${line.slice(0, 200)}`)
    }
    const waiter = pending.get(msg.id)
    if (!waiter) continue
    pending.delete(msg.id)
    if (msg.error) fail(`${waiter.method}: ${JSON.stringify(msg.error)}`)
    waiter.resolve(msg.result)
  }
})
let nextId = 1
function request(method, params) {
  const id = nextId++
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return new Promise((resolve) => pending.set(id, { method, resolve }))
}
const text = (result) => result.content.map((c) => c.text).join('\n')

t0 = Date.now()
const init = await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'packed-package-test', version: '1' },
})
console.log(`initialize: ${init.serverInfo.name} ${init.serverInfo.version}, protocol ${init.protocolVersion} (${seconds(t0)} s)`)
server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
const { tools } = await request('tools/list', {})
const names = tools.map((t) => t.name)
console.log(`tools/list: ${names.join(', ')}`)
for (const name of ['list_tables', 'describe_table', 'run_query']) if (!names.includes(name)) fail(`no ${name} tool`)
const tables = text(await request('tools/call', { name: 'list_tables', arguments: { connection: 'shop' } }))
if (!tables.includes('customers')) fail(`list_tables did not list customers:\n${tables}`)
const count = text(
  await request('tools/call', { name: 'run_query', arguments: { connection: 'shop', sql: 'SELECT count(*) AS n FROM customers' } }),
)
if (!/^n\n3\b/m.test(count)) fail(`run_query returned:\n${count}`)
console.log('list_tables and run_query answered')
server.stdin.end()
if (windows) {
  // shell: true starts cmd.exe; ending stdin stops the server, taskkill makes sure nothing is left behind.
  try {
    execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: 'ignore' })
  } catch {}
} else server.kill()

const rows = sh(`npx --no-install dbm query --url ${quote(url)} ${quote('SELECT name FROM customers ORDER BY id')}`, app)
if (!/^name\r?\nAlice\r?\nBob\r?\nCarol\b/.test(rows)) fail(`dbm query printed:\n${rows}`)
console.log(`dbm query printed ${rows.trim().split(/\r?\n/).length - 1} rows`)

clearTimeout(deadline)
if (!process.env.DBM_KEEP && !args[0]) rmSync(work, { recursive: true, force: true })
console.log('PACKED PACKAGE OK')
process.exit(0)

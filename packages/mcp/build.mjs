import { readFileSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'

// Bundle core into the CLIs (the MCP server and dbm); database drivers stay regular npm dependencies.
for (const [entry, outfile] of [['src/cli.ts', 'dist/cli.js'], ['src/dbm-cli.ts', 'dist/dbm.js']]) await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  external: ['@modelcontextprotocol/sdk', '@duckdb/node-api', 'mssql', 'mysql2', 'pg', 'pg-cursor', 'ssh2'],
  logLevel: 'info',
})

// The MCP registry entry (server.json, published after npm) names the package version: a version bump only touches
// package.json, so the build (also run by prepack) carries it over.
const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const server = JSON.parse(readFileSync('server.json', 'utf8'))
if (server.version !== version || server.packages.some((p) => p.version !== version)) {
  server.version = version
  for (const p of server.packages) p.version = version
  writeFileSync('server.json', JSON.stringify(server, null, 2) + '\n')
  console.log(`server.json: version ${version}`)
}

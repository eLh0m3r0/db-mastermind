import { execFileSync } from 'node:child_process'
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

// server.json must name this version (the registry publishes it next to the npm package): a mismatch stops the build
// instead of being fixed silently. npm version runs sync-server-json.mjs, which keeps them equal.
execFileSync(process.execPath, ['sync-server-json.mjs', '--check'], { stdio: 'inherit' })

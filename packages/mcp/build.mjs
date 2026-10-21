import { build } from 'esbuild'

// Bundle core into the CLI; database drivers stay regular npm dependencies.
await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  external: ['@modelcontextprotocol/sdk', 'mssql', 'mysql2', 'pg', 'pg-cursor', 'ssh2'],
  logLevel: 'info',
})

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The MCP registry entry must name the version that is on npm: server.json, packages/mcp/package.json and the
// repository's version agree (sync-server-json.mjs, run by `npm version`, keeps them so).
describe('server.json', () => {
  it('agrees with the package and the repository version', () => {
    const r = spawnSync(process.execPath, [join(__dirname, '..', 'sync-server-json.mjs'), '--check'], { encoding: 'utf8' })
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
  })
})

// server.json (the MCP registry entry, published next to the npm package) names the package version twice. It must
// equal packages/mcp/package.json's version and the repository's own version, or the registry would list a version
// that doesn't exist on npm, or an old one.
//
//   node packages/mcp/sync-server-json.mjs           write the package version into server.json
//   node packages/mcp/sync-server-json.mjs --check   exit 1 with the differences (CI, release.yml, build.mjs)
//
// A release's version bump is `npm version <x.y.z> --workspaces --include-workspace-root --no-git-tag-version`: npm
// then runs this package's `version` script, which is this file, so server.json follows in the same step.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const read = (file) => JSON.parse(readFileSync(file, 'utf8'))
const pkg = read(join(here, 'package.json'))
const root = read(join(here, '..', '..', 'package.json'))
const serverFile = join(here, 'server.json')
const server = read(serverFile)

if (process.argv.includes('--check')) {
  const problems = []
  if (root.version !== pkg.version) problems.push(`package.json ${root.version}, packages/mcp/package.json ${pkg.version}`)
  if (server.name !== pkg.mcpName) problems.push(`server.json name ${server.name}, mcpName ${pkg.mcpName}`)
  if (server.version !== pkg.version) problems.push(`server.json version ${server.version}, package ${pkg.version}`)
  for (const p of server.packages) {
    if (p.identifier !== pkg.name) problems.push(`server.json package ${p.identifier}, npm name ${pkg.name}`)
    if (p.version !== pkg.version) problems.push(`server.json packages[].version ${p.version}, package ${pkg.version}`)
  }
  if (problems.length) {
    console.error(`Versions disagree:\n- ${problems.join('\n- ')}\nBump with: npm version <x.y.z> --workspaces --include-workspace-root --no-git-tag-version`)
    process.exit(1)
  }
  console.log(`dbmastermind-mcp ${pkg.version}: package.json, packages/mcp/package.json and server.json agree`)
} else {
  server.version = pkg.version
  for (const p of server.packages) p.version = pkg.version
  writeFileSync(serverFile, JSON.stringify(server, null, 2) + '\n')
  console.log(`server.json: version ${pkg.version}`)
}

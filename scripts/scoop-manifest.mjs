// Scoop manifest for a release, uploaded as a release asset: `scoop install <url of db-mastermind.json>`.
// Usage: node scripts/scoop-manifest.mjs <version> <x64 portable zip> <arm64 portable zip>
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const [version, x64, arm64] = process.argv.slice(2)
const repo = 'https://github.com/eLh0m3r0/db-mastermind'
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const asset = (file) => `${repo}/releases/download/v${version}/${basename(file)}`

const manifest = {
  version,
  description: 'Free, open-source database client: browse, filter, ER diagrams, schema design with migrations, AI assistant',
  homepage: 'https://dbmastermind.app/',
  license: 'MIT',
  architecture: {
    '64bit': { url: asset(x64), hash: sha(x64) },
    arm64: { url: asset(arm64), hash: sha(arm64) },
  },
  shortcuts: [['DB Mastermind.exe', 'DB Mastermind']],
  // Portable mode keeps connections and settings in "data" next to the exe: keep it across updates.
  persist: 'data',
  checkver: { github: repo },
  autoupdate: {
    architecture: {
      '64bit': { url: `${repo}/releases/download/v$version/DB-Mastermind-$version-win-x64-portable.zip` },
      arm64: { url: `${repo}/releases/download/v$version/DB-Mastermind-$version-win-arm64-portable.zip` },
    },
  },
}
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)

// Keeps only this target's DuckDB binding, then ad-hoc signs macOS builds (electron-builder's own ad-hoc path
// insists on a timestamp, which needs a real identity).
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ARCHS = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }

/** CI installs DuckDB bindings for every architecture it builds; each package must only carry its own (60+ MB each). */
function pruneDuckDBBindings(context) {
  const resources =
    context.electronPlatformName === 'darwin'
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : path.join(context.appOutDir, 'resources')
  const dir = path.join(resources, 'app.asar.unpacked', 'node_modules', '@duckdb')
  if (!fs.existsSync(dir)) return
  const keep = `node-bindings-${context.electronPlatformName}-${ARCHS[context.arch]}`
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('node-bindings-') && name !== keep) fs.rmSync(path.join(dir, name), { recursive: true, force: true })
  }
  if (!fs.existsSync(path.join(dir, keep))) console.warn(`  • DuckDB binding ${keep} is missing: DuckDB connections won't work in this build`)
}

exports.default = async function afterPack(context) {
  pruneDuckDBBindings(context)
  if (context.electronPlatformName !== 'darwin') return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  try {
    // Extended attributes (quarantine, Finder info) make codesign refuse to sign.
    execFileSync('xattr', ['-cr', app])
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  } catch (err) {
    // Local builds inside iCloud-synced folders get attributes re-added; only CI must succeed.
    if (process.env.CI) throw err
    console.warn(`  • ad-hoc signing skipped: ${err.message.split('\n')[0]}`)
  }
}

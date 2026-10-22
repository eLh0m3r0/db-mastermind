// Keeps only this target's DuckDB binding, then signs macOS builds: with the project's own certificate when
// MAC_SIGN_P12 is set (release builds), otherwise ad-hoc (electron-builder's own ad-hoc path insists on a timestamp,
// which needs a real identity).
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

/**
 * A self-signed certificate that stays the same across releases (not an Apple Developer ID: Gatekeeper still asks on
 * the first open). Its point is the designated requirement: an ad-hoc signature is tied to one build's hash, so each
 * update looks like another app to the macOS keychain, which then asks again for the saved-password key and holds the
 * app until someone answers. With `identifier … and certificate root = …` "Always Allow" survives updates.
 * rcodesign signs from the .p12 directly (codesign won't use an untrusted certificate).
 */
function signWithCertificate(app) {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dbm-sign-'))
  try {
    const p12 = path.join(dir, 'cert.p12')
    const password = path.join(dir, 'password')
    fs.writeFileSync(p12, Buffer.from(process.env.MAC_SIGN_P12, 'base64'), { mode: 0o600 })
    fs.writeFileSync(password, process.env.MAC_SIGN_PASSWORD ?? '', { mode: 0o600 })
    execFileSync(process.env.RCODESIGN, ['sign', '--p12-file', p12, '--p12-password-file', password, app], { stdio: 'inherit' })
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

exports.default = async function afterPack(context) {
  pruneDuckDBBindings(context)
  if (context.electronPlatformName !== 'darwin') return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  try {
    // Extended attributes (quarantine, Finder info) make codesign refuse to sign.
    execFileSync('xattr', ['-cr', app])
    if (process.env.MAC_SIGN_P12 && process.env.RCODESIGN) return signWithCertificate(app)
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  } catch (err) {
    // Local builds inside iCloud-synced folders get attributes re-added; only CI must succeed.
    if (process.env.CI) throw err
    console.warn(`  • ad-hoc signing skipped: ${err.message.split('\n')[0]}`)
  }
}

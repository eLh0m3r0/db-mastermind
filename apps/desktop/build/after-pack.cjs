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

const DEVELOPER_ID = ['MAC_DEVID_P12', 'MAC_DEVID_PASSWORD', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER_ID', 'APPLE_API_KEY_P8']

/**
 * With an Apple Developer ID (all five secrets in DEVELOPER_ID): sign with the hardened runtime, have Apple notarize
 * the app and staple the ticket to it. This runs before electron-builder makes the .dmg and the .zip from the app, so
 * both carry the stapled app and latest-mac.yml hashes the final files (a .zip can't be stapled, and stapling the
 * .dmg afterwards would change it after its hash was written). docs/macos-notarization.md has the whole procedure.
 */
function signAndNotarize(app) {
  const rcodesign = (args) => execFileSync(process.env.RCODESIGN, args, { stdio: 'inherit' })
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dbm-notarize-'))
  try {
    const p12 = path.join(dir, 'developer-id.p12')
    const password = path.join(dir, 'password')
    const p8 = path.join(dir, 'api-key.p8')
    const apiKey = path.join(dir, 'api-key.json')
    fs.writeFileSync(p12, Buffer.from(process.env.MAC_DEVID_P12, 'base64'), { mode: 0o600 })
    fs.writeFileSync(password, process.env.MAC_DEVID_PASSWORD, { mode: 0o600 })
    fs.writeFileSync(p8, process.env.APPLE_API_KEY_P8, { mode: 0o600 })
    rcodesign(['encode-app-store-connect-api-key', '--output-path', apiKey, process.env.APPLE_API_ISSUER_ID, process.env.APPLE_API_KEY_ID, p8])
    // --for-notarization: Developer ID required, timestamped, hardened runtime on every Mach-O. Entitlements apply only
    // where they are scoped: the app itself and each Electron helper app (the renderer runs V8 too).
    const entitlements = path.join(__dirname, 'entitlements.mac.plist')
    const scoped = fs
      .readdirSync(path.join(app, 'Contents', 'Frameworks'))
      .filter((name) => name.endsWith('.app'))
      .flatMap((name) => ['--entitlements-xml-file', `Contents/Frameworks/${name}:${entitlements}`])
    rcodesign(['sign', '--for-notarization', '--p12-file', p12, '--p12-password-file', password, '--entitlements-xml-file', entitlements, ...scoped, app])
    execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' })
    // Uploads the app (rcodesign zips a bundle itself), waits for Apple's verdict and staples the ticket to the app.
    rcodesign(['notary-submit', '--api-key-file', apiKey, '--staple', app])
    execFileSync('xcrun', ['stapler', 'validate', app], { stdio: 'inherit' })
    execFileSync('spctl', ['--assess', '--type', 'execute', '--verbose=4', app], { stdio: 'inherit' })
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
    const devId = DEVELOPER_ID.filter((name) => process.env[name])
    // Half a configuration must not quietly ship the old signature: either all five secrets or none.
    if (devId.length > 0 && devId.length < DEVELOPER_ID.length) throw new Error(`Developer ID signing needs all of ${DEVELOPER_ID.join(', ')}; missing ${DEVELOPER_ID.filter((n) => !devId.includes(n)).join(', ')}`)
    if (devId.length === DEVELOPER_ID.length) {
      if (!process.env.RCODESIGN) throw new Error('Developer ID signing needs rcodesign (RCODESIGN)')
      return signAndNotarize(app)
    }
    if (process.env.MAC_SIGN_P12 && process.env.RCODESIGN) return signWithCertificate(app)
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  } catch (err) {
    // Local builds inside iCloud-synced folders get attributes re-added; only CI must succeed.
    if (process.env.CI) throw err
    console.warn(`  • ad-hoc signing skipped: ${err.message.split('\n')[0]}`)
  }
}

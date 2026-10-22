// Ad-hoc signs macOS builds (electron-builder's own ad-hoc path insists on a timestamp, which needs a real identity).
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function afterPack(context) {
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

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { app } from 'electron'

/**
 * Self-update for the unsigned macOS app. Squirrel.Mac (electron-updater's macOS path) only accepts signed apps, so
 * this does what it would: read latest-mac.yml from the latest release, download this architecture's zip, check its
 * SHA-512 against that file, unpack it with ditto, and swap the app bundle after the app quits (a detached shell
 * script waits for the process to end, keeps the old bundle until the copy succeeded, and reopens the app on
 * "Restart now"). Downloads made by the app aren't quarantined, so the new version opens without a warning.
 */

const FEED = process.env.DBM_UPDATE_FEED ?? 'https://github.com/eLh0m3r0/db-mastermind/releases/latest/download'

type Log = (level: string, ...parts: unknown[]) => void

interface Pending {
  version: string
  app: string
}

let pending: Pending | undefined
let relaunch = false
let hooked = false

/** The running .app bundle, e.g. /Applications/DB Mastermind.app. */
export function macBundle(): string {
  return resolve(app.getPath('exe'), '..', '..', '..')
}

/** Installs that can replace themselves: a bundle in a folder we may write to, not run from a disk image or translocated. */
export function canSelfUpdateMac(): boolean {
  if (process.platform !== 'darwin' || !app.isPackaged) return false
  const bundle = macBundle()
  if (!bundle.endsWith('.app') || bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) return false
  try {
    accessSync(dirname(bundle), constants.W_OK)
    accessSync(bundle, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** The few fields needed from latest-mac.yml (electron-builder's format). */
export function parseLatestMac(yml: string): { version: string; files: { url: string; sha512: string }[] } {
  const version = /^version:\s*['"]?([^'"\s]+)/m.exec(yml)?.[1] ?? ''
  const files: { url: string; sha512: string }[] = []
  for (const block of yml.split(/\n\s*-\s+url:\s*/).slice(1)) {
    const url = block.split('\n')[0]!.trim().replace(/^['"]|['"]$/g, '')
    const sha512 = /sha512:\s*['"]?([A-Za-z0-9+/=]+)/.exec(block)?.[1]
    if (url && sha512) files.push({ url, sha512 })
  }
  return { version, files }
}

/** Looks for a newer version; downloads, verifies and unpacks it. Resolves with the version when one is ready. */
export async function downloadMacUpdate(current: string, newer: (a: string, b: string) => boolean, log: Log): Promise<string | undefined> {
  const res = await fetch(`${FEED}/latest-mac.yml`, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`latest-mac.yml: HTTP ${res.status}`)
  const latest = parseLatestMac(await res.text())
  if (!latest.version || !newer(latest.version, current)) {
    log('INFO', `Up to date (${current}, latest ${latest.version || '?'})`)
    return undefined
  }
  if (pending?.version === latest.version) return latest.version
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const file = latest.files.find((f) => f.url.endsWith(`-mac-${arch}.zip`))
  if (!file) throw new Error(`No ${arch} zip in latest-mac.yml`)

  const dir = join(app.getPath('userData'), 'updates', latest.version)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const zip = join(dir, file.url)
  log('INFO', `Downloading ${file.url}`)
  const download = await fetch(`${FEED}/${encodeURIComponent(file.url)}`, { signal: AbortSignal.timeout(30 * 60_000) })
  if (!download.ok || !download.body) throw new Error(`${file.url}: HTTP ${download.status}`)
  const hash = createHash('sha512')
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk)
      done(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(download.body as import('node:stream/web').ReadableStream), hashing, createWriteStream(zip))
  const actual = hash.digest('base64')
  if (actual !== file.sha512) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`${file.url}: checksum mismatch`)
  }
  await promisify(execFile)('/usr/bin/ditto', ['-x', '-k', zip, join(dir, 'app')])
  rmSync(zip, { force: true })
  const bundle = readdirSync(join(dir, 'app')).find((name) => name.endsWith('.app'))
  if (!bundle) throw new Error('The update contains no app bundle')
  pending = { version: latest.version, app: join(dir, 'app', bundle) }
  log('INFO', `Update ${latest.version} downloaded; installs on quit or "Restart now"`)
  if (!hooked) {
    hooked = true
    app.on('will-quit', () => swapAfterExit(log))
  }
  return latest.version
}

/**
 * Replaces the bundle once this process has exited. Arguments: pid, installed app, new app, folder to clean up, and
 * 1 to reopen. The new version is copied next to the app first and swapped in with two renames: the app is never
 * half-copied, any failure leaves (or puts back) the installed one, and only the copies are ever deleted.
 */
export const SWAP_SCRIPT = [
  'while kill -0 "$1" 2>/dev/null; do sleep 0.3; done',
  // An earlier swap cut off between its renames (power loss) left only the old copy: put it back first.
  '[ -d "$2" ] || [ ! -d "$2.old" ] || mv "$2.old" "$2"',
  'rm -rf "$2.old" "$2.new"',
  'if /usr/bin/ditto "$3" "$2.new" && mv "$2" "$2.old" && mv "$2.new" "$2"; then rm -rf "$2.old"; else [ -d "$2" ] || mv "$2.old" "$2"; rm -rf "$2.new"; fi',
  '/usr/bin/xattr -dr com.apple.quarantine "$2" 2>/dev/null',
  'rm -rf "$4"',
  'if [ "$5" = 1 ]; then /usr/bin/open "$2"; fi',
].join('\n')

/** Starts the detached script that replaces the bundle once this process has exited. */
function swapAfterExit(log: Log): void {
  if (!pending || !existsSync(pending.app)) return
  const target = macBundle()
  log('INFO', `Installing ${pending.version} into ${target} after quit${relaunch ? ', then reopening' : ''}`)
  const child = spawn('/bin/sh', ['-c', SWAP_SCRIPT, 'dbm-update', String(process.pid), target, pending.app, dirname(dirname(pending.app)), relaunch ? '1' : '0'], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  pending = undefined
}

export function macUpdateReady(): boolean {
  return !!pending
}

/** "Restart now": quit, swap, reopen. */
export function installMacUpdateNow(): void {
  relaunch = true
  app.quit()
}

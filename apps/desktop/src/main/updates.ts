import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { canSelfUpdateMac, downloadMacUpdate, installMacUpdateNow } from './mac-update'
import { managedConfig } from './managed'
import { isPortable } from './storage'

const RELEASES_API = 'https://api.github.com/repos/eLh0m3r0/db-mastermind/releases/latest'

function newer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0)
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  }
  return false
}

/**
 * Installs that can update themselves: the per-user Windows installer (NSIS) and the Linux AppImage. Not the
 * portable zip (Scoop or the user replaces it), not MSI (IT deploys it). macOS: see mac-update.ts.
 */
export function canAutoUpdate(): boolean {
  // Microsoft Store installs are updated by the Store.
  if (process.windowsStore) return false
  if (process.platform === 'win32') return !isPortable && existsSync(join(dirname(app.getPath('exe')), 'Uninstall DB Mastermind.exe'))
  // The unsigned macOS app updates through its own path (mac-update.ts) when it may replace its bundle.
  if (process.platform === 'darwin') return canSelfUpdateMac()
  return process.platform === 'linux' && !!process.env.APPIMAGE
}

type Release = { version: string; url: string }

async function latestRelease(): Promise<Release | null> {
  const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) return null
  const release = (await res.json()) as { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean }
  if (!release.tag_name || release.draft || release.prerelease) return null
  return { version: release.tag_name.replace(/^v/, ''), url: release.html_url ?? 'https://github.com/eLh0m3r0/db-mastermind/releases' }
}

/** Updater decisions and electron-updater's own messages, in <data>/logs/updater.log (kept under 1 MB). */
function log(level: string, ...parts: unknown[]): void {
  try {
    const dir = join(app.getPath('userData'), 'logs')
    const file = join(dir, 'updater.log')
    mkdirSync(dir, { recursive: true })
    if (existsSync(file) && statSync(file).size > 1_000_000) writeFileSync(file, '')
    const text = parts.map((p) => (p instanceof Error ? (p.stack ?? p.message) : typeof p === 'string' ? p : JSON.stringify(p))).join(' ')
    appendFileSync(file, `${new Date().toISOString()} ${level} ${text}\n`)
  } catch {
    // Logging must never break the app.
  }
}

const logger = { info: (...a: unknown[]) => log('INFO', ...a), warn: (...a: unknown[]) => log('WARN', ...a), error: (...a: unknown[]) => log('ERROR', ...a), debug: (...a: unknown[]) => log('DEBUG', ...a) }

let updater: Promise<typeof import('electron-updater').autoUpdater> | undefined

/**
 * electron-updater is CommonJS with a lazily defined `autoUpdater` export: a dynamic import exposes it only on
 * `default` (the named binding is undefined, which silently disabled updates in 0.9.0 and 0.9.1).
 */
async function loadAutoUpdater(): Promise<typeof import('electron-updater').autoUpdater> {
  const mod = (await import('electron-updater')) as typeof import('electron-updater') & { default?: typeof import('electron-updater') }
  const autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater
  if (!autoUpdater) throw new Error('electron-updater did not load')
  return autoUpdater
}

/** electron-updater, configured once: downloads in the background and installs on quit. */
function autoUpdaterFor(ready: (info: { version: string }) => void) {
  updater ??= loadAutoUpdater().then((autoUpdater) => {
    autoUpdater.logger = logger
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('update-downloaded', (info) => {
      log('INFO', `Update ${info.version} downloaded; installs on quit or "Restart now"`)
      ready({ version: info.version })
    })
    autoUpdater.on('error', (err) => log('ERROR', 'electron-updater', err))
    return autoUpdater
  })
  return updater
}

const disabled = () => process.env.DBM_NO_UPDATE_CHECK || managedConfig()?.policies?.disableUpdateCheck

/**
 * Self-updating installs download new versions in the background and offer a restart (or install on quit).
 * Everything else checks GitHub Releases and offers a download link.
 */
export async function checkForUpdates(
  notify: (info: { version: string; url: string }) => void,
  ready: (info: { version: string }) => void = () => {},
): Promise<void> {
  if (!app.isPackaged || disabled()) return
  const auto = canAutoUpdate()
  log('INFO', `Version ${app.getVersion()} on ${process.platform}/${process.arch}; self-updating install: ${auto}; exe ${app.getPath('exe')}`)
  if (auto) {
    try {
      if (process.platform === 'darwin') {
        const version = await downloadMacUpdate(app.getVersion(), newer, log)
        if (version) ready({ version })
        return
      }
      await (await autoUpdaterFor(ready)).checkForUpdates()
      return
    } catch (err) {
      log('ERROR', 'Self-update check failed, falling back to the release link', err)
    }
  }
  try {
    const release = await latestRelease()
    if (release && newer(release.version, app.getVersion())) notify(release)
  } catch {
    // Offline or rate limited: try again next launch.
  }
}

export type UpdateCheck =
  | { state: 'up-to-date'; version: string }
  | { state: 'downloading'; version: string }
  | { state: 'available'; version: string; url: string }
  | { state: 'disabled' | 'development' | 'offline' }

/** Help → Check for Updates: the same check, with an answer for the user. */
export async function checkNow(ready: (info: { version: string }) => void): Promise<UpdateCheck> {
  if (!app.isPackaged) return { state: 'development' }
  if (disabled()) return { state: 'disabled' }
  try {
    if (canAutoUpdate() && process.platform === 'darwin') {
      const version = await downloadMacUpdate(app.getVersion(), newer, log)
      if (version) ready({ version })
      return version ? { state: 'downloading', version } : { state: 'up-to-date', version: app.getVersion() }
    }
    if (canAutoUpdate()) {
      const result = await (await autoUpdaterFor(ready)).checkForUpdates()
      const version = result?.updateInfo.version
      return version && newer(version, app.getVersion()) ? { state: 'downloading', version } : { state: 'up-to-date', version: app.getVersion() }
    }
    const release = await latestRelease()
    if (!release) return { state: 'offline' }
    return newer(release.version, app.getVersion()) ? { state: 'available', ...release } : { state: 'up-to-date', version: app.getVersion() }
  } catch {
    return { state: 'offline' }
  }
}

/** Restarts into the downloaded update. */
export async function installUpdate(): Promise<void> {
  if (process.platform === 'darwin') return installMacUpdateNow()
  const autoUpdater = await loadAutoUpdater()
  autoUpdater.quitAndInstall(false, true)
}

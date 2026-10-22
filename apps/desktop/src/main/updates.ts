import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
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
 * portable zip (Scoop or the user replaces it), not MSI (IT deploys it), not macOS (Squirrel needs a signed app).
 */
export function canAutoUpdate(): boolean {
  if (process.platform === 'win32') return !isPortable && existsSync(join(dirname(app.getPath('exe')), 'Uninstall DB Mastermind.exe'))
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

let updater: Promise<typeof import('electron-updater').autoUpdater> | undefined

/** electron-updater, configured once: downloads in the background and installs on quit. */
function autoUpdaterFor(ready: (info: { version: string }) => void) {
  updater ??= import('electron-updater').then(({ autoUpdater }) => {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('update-downloaded', (info) => ready({ version: info.version }))
    autoUpdater.on('error', () => undefined)
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
  if (canAutoUpdate()) {
    try {
      await (await autoUpdaterFor(ready)).checkForUpdates()
      return
    } catch {
      // Fall back to the download link below.
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
  const { autoUpdater } = await import('electron-updater')
  autoUpdater.quitAndInstall(false, true)
}

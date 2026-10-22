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

/**
 * Self-updating installs download new versions in the background and offer a restart (or install on quit).
 * Everything else checks GitHub Releases and offers a download link.
 */
export async function checkForUpdates(
  notify: (info: { version: string; url: string }) => void,
  ready: (info: { version: string }) => void = () => {},
): Promise<void> {
  if (!app.isPackaged || process.env.DBM_NO_UPDATE_CHECK || managedConfig()?.policies?.disableUpdateCheck) return
  if (canAutoUpdate()) {
    try {
      const { autoUpdater } = await import('electron-updater')
      autoUpdater.autoDownload = true
      autoUpdater.autoInstallOnAppQuit = true
      autoUpdater.on('update-downloaded', (info) => ready({ version: info.version }))
      autoUpdater.on('error', () => undefined)
      await autoUpdater.checkForUpdates()
      return
    } catch {
      // Fall back to the download link below.
    }
  }
  try {
    const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return
    const release = (await res.json()) as { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean }
    if (!release.tag_name || release.draft || release.prerelease) return
    if (newer(release.tag_name, app.getVersion())) {
      notify({ version: release.tag_name.replace(/^v/, ''), url: release.html_url ?? 'https://github.com/eLh0m3r0/db-mastermind/releases' })
    }
  } catch {
    // Offline or rate limited: try again next launch.
  }
}

/** Restarts into the downloaded update. */
export async function installUpdate(): Promise<void> {
  const { autoUpdater } = await import('electron-updater')
  autoUpdater.quitAndInstall(false, true)
}

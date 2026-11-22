import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, powerMonitor } from 'electron'
import { canSelfUpdateMac, downloadMacUpdate, installMacUpdateNow } from './mac-update'
import { managedConfig } from './managed'
import { getSettings } from './settings'
import { installedForAllUsers, isPortable } from './storage'

const RELEASES_API = 'https://api.github.com/repos/eLh0m3r0/db-mastermind/releases/latest'
/** The app's Store page (Windows opens it in the Store app). */
export const STORE_URL = 'https://apps.microsoft.com/detail/9p0grd7bz4nf'

/**
 * Microsoft Store installs are updated by the Store, which offers a version only after it passes certification.
 * GitHub's newer release must not be announced there: its installer would add a second copy beside the Store one,
 * which doesn't see the Store copy's data.
 */
export const isStoreInstall = (): boolean => !!process.windowsStore

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
  if (isStoreInstall()) return false
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

/** Off for good: the environment or the IT policy. Help → Check for Updates says so. */
const disabled = () => process.env.DBM_NO_UPDATE_CHECK || managedConfig()?.policies?.disableUpdateCheck
/** The background checks also respect the user's setting; checking by hand still works. */
const automaticOff = () => disabled() || getSettings().checkForUpdates === false

/**
 * Self-updating installs download new versions in the background and offer a restart (or install on quit).
 * Everything else checks GitHub Releases and offers a download link.
 */
export async function checkForUpdates(
  notify: (info: { version: string; url: string }) => void,
  ready: (info: { version: string }) => void = () => {},
): Promise<void> {
  // The Store and an MSI deployed for all users are updated by others; a reminder would only lead to a second copy.
  if (!app.isPackaged || automaticOff() || isStoreInstall() || installedForAllUsers) return
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
    // Offline or rate limited: the next scheduled check tries again.
  }
}

const HOUR = 3_600_000

/**
 * Runs `check` now, every `every` ms, and after the computer wakes up when the last check is older than `afterWake`.
 * An app left open for days (or a laptop that sleeps overnight) still learns about new versions. Returns a stop
 * function.
 */
export function scheduleChecks(check: () => Promise<void>, onWake: (listener: () => void) => void, every = 4 * HOUR, afterWake = HOUR): () => void {
  let last = 0
  let running = false
  const run = () => {
    if (running) return
    running = true
    last = Date.now()
    void check()
      .catch(() => {})
      .finally(() => {
        running = false
      })
  }
  run()
  const timer = setInterval(run, every)
  timer.unref?.()
  let stopped = false
  onWake(() => {
    if (!stopped && Date.now() - last >= afterWake) run()
  })
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

/**
 * The startup check, repeated while the app runs. Each version is announced once: a later check that finds the same
 * download (or the same release) stays quiet. The callbacks return false when there was no window to tell.
 */
export function startUpdateChecks(notify: (info: { version: string; url: string }) => boolean, ready: (info: { version: string }) => boolean): void {
  if (!app.isPackaged || disabled()) return
  const told = new Set<string>()
  const once = <T extends { version: string }>(kind: string, fn: (info: T) => boolean) => (info: T) => {
    if (!told.has(`${kind} ${info.version}`) && fn(info)) told.add(`${kind} ${info.version}`)
  }
  scheduleChecks(
    () => checkForUpdates(once('available', notify), once('ready', ready)),
    (listener) => powerMonitor.on('resume', listener),
  )
}

export type UpdateCheck =
  | { state: 'up-to-date'; version: string }
  | { state: 'downloading'; version: string }
  | { state: 'ready'; version: string }
  | { state: 'available'; version: string; url: string }
  | { state: 'store'; url: string }
  | { state: 'administrator'; version: string; url: string }
  | { state: 'disabled' | 'development' | 'offline' }

/** Help → Check for Updates: the same check, with an answer for the user. */
export async function checkNow(ready: (info: { version: string }) => void, failed?: (info: { version: string; message: string }) => void): Promise<UpdateCheck> {
  if (!app.isPackaged) return { state: 'development' }
  if (disabled()) return { state: 'disabled' }
  if (isStoreInstall()) return { state: 'store', url: STORE_URL }
  try {
    if (canAutoUpdate() && process.platform === 'darwin') {
      // Answers once the download starts; the restart prompt (`ready`) follows when it is done, or `failed` says why
      // not (the answer "downloading" was already given, so a rejection would reach nobody).
      let downloading: string | undefined
      return await new Promise<UpdateCheck>((resolve, reject) => {
        downloadMacUpdate(app.getVersion(), newer, log, (version) => {
          downloading = version
          resolve({ state: 'downloading', version })
        }).then(
          (version) => {
            if (version) ready({ version })
            resolve(version ? { state: 'ready', version } : { state: 'up-to-date', version: app.getVersion() })
          },
          (err: unknown) => {
            log('ERROR', 'Update download failed', err)
            if (downloading !== undefined) failed?.({ version: downloading, message: err instanceof Error ? err.message : String(err) })
            reject(err)
          },
        )
      })
    }
    if (canAutoUpdate()) {
      const result = await (await autoUpdaterFor(ready)).checkForUpdates()
      const version = result?.updateInfo.version
      return version && newer(version, app.getVersion()) ? { state: 'downloading', version } : { state: 'up-to-date', version: app.getVersion() }
    }
    const release = await latestRelease()
    if (!release) return { state: 'offline' }
    if (!newer(release.version, app.getVersion())) return { state: 'up-to-date', version: app.getVersion() }
    return installedForAllUsers ? { state: 'administrator', ...release } : { state: 'available', ...release }
  } catch {
    return { state: 'offline' }
  }
}

let beforeInstall: () => Promise<boolean> = async () => true
/**
 * What must happen before the installer starts (index.ts: open transactions are committed or rolled back as the user
 * says). electron-updater starts the installer before it quits, and the installer closes the app whatever
 * before-quit asks then.
 */
export function setBeforeInstall(settle: () => Promise<boolean>): void {
  beforeInstall = settle
}

let installFailed: () => void = () => {}
/** Told when the restart into the update did not happen after all (the installer threw): the agreed quit is off. */
export function setInstallFailed(handler: () => void): void {
  installFailed = handler
}

/** Restarts into the downloaded update; nothing happens when the user keeps an open transaction. */
export async function installUpdate(): Promise<void> {
  if (!(await beforeInstall())) return
  try {
    if (process.platform === 'darwin') return installMacUpdateNow()
    const autoUpdater = await loadAutoUpdater()
    // The AppImage updater starts the new AppImage at once, while this process still quits: holding the single-
    // instance lock, it would make the new one hand its arguments over and exit (Restart now ended as a plain quit).
    if (process.platform === 'linux') app.releaseSingleInstanceLock()
    autoUpdater.quitAndInstall(false, true)
  } catch (err) {
    installFailed()
    throw err
  }
}

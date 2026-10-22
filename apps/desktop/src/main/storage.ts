import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, accessSync, constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, safeStorage } from 'electron'

/**
 * Portable mode keeps all data next to the executable, so the app can run from a USB stick or an unzipped
 * folder without touching the user profile. It's on when the app isn't installed (Windows zip build), when a
 * `portable` marker or `data` folder exists next to the executable, or when DBM_PORTABLE=1.
 */
function detectPortableDir(): string | null {
  if (!app.isPackaged && !process.env.DBM_PORTABLE) return null
  const exeDir = process.env.PORTABLE_EXECUTABLE_DIR ?? dirname(app.getPath('exe'))
  const marker = existsSync(join(exeDir, 'portable')) || existsSync(join(exeDir, 'data'))
  const installedByNsis = existsSync(join(exeDir, 'Uninstall DB Mastermind.exe'))
  // MSI (per-machine) installs live under Program Files; never keep data there, even when running elevated.
  const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432].filter((p): p is string => !!p).map((p) => p.toLowerCase())
  const installedPerMachine = process.platform === 'win32' && programFiles.some((p) => exeDir.toLowerCase().startsWith(p))
  const wantPortable =
    process.env.DBM_PORTABLE === '1' || marker || (process.platform === 'win32' && !installedByNsis && !installedPerMachine)
  if (!wantPortable) return null
  const dir = join(exeDir, 'data')
  try {
    mkdirSync(dir, { recursive: true })
    accessSync(dir, constants.W_OK)
    return dir
  } catch {
    return null
  }
}

const portableDir = detectPortableDir()

export const isPortable = portableDir !== null

/** Must run before app 'ready' so Chromium also stores its profile in the portable folder. */
export function configureDataDir(): string {
  if (portableDir) app.setPath('userData', portableDir)
  if (process.env.DBM_USER_DATA) app.setPath('userData', process.env.DBM_USER_DATA)
  return app.getPath('userData')
}

export function dataPath(...parts: string[]): string {
  return join(app.getPath('userData'), ...parts)
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(dataPath(file), 'utf8')) as T
  } catch {
    return fallback
  }
}

/** Atomic write: a crash mid-write never leaves a truncated file. */
export function writeJson(file: string, value: unknown): void {
  const target = dataPath(file)
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, target)
}

const ENC_PREFIX = 'enc:v1:'
const PLAIN_PREFIX = 'plain:'

export async function encryptSecret(value: string | undefined): Promise<string | undefined> {
  if (!value) return value
  if (await safeStorage.isAsyncEncryptionAvailable()) return ENC_PREFIX + (await safeStorage.encryptStringAsync(value)).toString('base64')
  // No OS keychain (e.g. Linux without a secret service): stored obfuscated only. Surfaced in Settings.
  return PLAIN_PREFIX + Buffer.from(value, 'utf8').toString('base64')
}

export async function decryptSecret(value: string | undefined): Promise<string | undefined> {
  if (!value) return value
  try {
    if (value.startsWith(ENC_PREFIX)) {
      return (await safeStorage.decryptStringAsync(Buffer.from(value.slice(ENC_PREFIX.length), 'base64'))).result
    }
    if (value.startsWith(PLAIN_PREFIX)) return Buffer.from(value.slice(PLAIN_PREFIX.length), 'base64').toString('utf8')
  } catch (err) {
    // Encrypted on another machine/user (e.g. portable folder copied): the secret must be re-entered.
    if (process.env.DBM_DEBUG) console.error('decryptSecret failed:', err)
    return undefined
  }
  return value
}

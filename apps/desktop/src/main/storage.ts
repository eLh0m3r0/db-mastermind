import { execFileSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
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
const MAC_PREFIX = 'enc:v2:'
const PLAIN_PREFIX = 'plain:'

/**
 * macOS: the key that encrypts saved passwords, kept in the login keychain and read through /usr/bin/security.
 *
 * Electron's safeStorage keeps its key in a keychain item that only the creating app may read without asking, and
 * for an app without an Apple Developer ID macOS identifies "the app" by the exact build (its cdhash partition), so
 * after every update the keychain asked again and the app waited without a window until someone answered. An item
 * created and read by Apple's own `security` tool isn't tied to our build, so updates don't ask. Any process of the
 * same user can read it the same way (as it could a key file; Beekeeper Studio and DBeaver keep theirs in files),
 * but it stays encrypted at rest in the keychain. One key per data folder, so test or portable profiles never share
 * the user's key. Null when unavailable: secrets then use safeStorage as before.
 */
let macKey: Buffer | null | undefined
function macSecretKey(): Buffer | null {
  // Development and e2e runs (a fresh data folder each time) would leave a keychain item per run: packaged apps only.
  if (process.platform !== 'darwin' || (!app.isPackaged && !process.env.DBM_MAC_SECRET_KEY)) return null
  if (macKey !== undefined) return macKey
  const service = 'DB Mastermind secrets'
  const account = createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 16)
  const security = (args: string[]) => execFileSync('/usr/bin/security', args, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).toString().trim()
  try {
    let hex = ''
    try {
      hex = security(['find-generic-password', '-s', service, '-a', account, '-w'])
    } catch {
      // Not created yet.
    }
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      hex = randomBytes(32).toString('hex')
      security(['add-generic-password', '-U', '-s', service, '-a', account, '-l', 'DB Mastermind', '-w', hex])
      if (security(['find-generic-password', '-s', service, '-a', account, '-w']) !== hex) throw new Error('Key not stored')
    }
    macKey = Buffer.from(hex, 'hex')
  } catch (err) {
    if (process.env.DBM_DEBUG) console.error('macOS secret key unavailable:', err)
    macKey = null
  }
  return macKey
}

/** AES-256-GCM: base64(iv | tag | ciphertext). */
function sealMac(key: Buffer, value: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return MAC_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')
}

function openMac(key: Buffer, sealed: string): string {
  const raw = Buffer.from(sealed.slice(MAC_PREFIX.length), 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
}

let legacyRead = false

/** True once after secrets in an older format were read: the caller saves again so they're re-encrypted. */
export function takeLegacySecretsFlag(): boolean {
  const was = legacyRead
  legacyRead = false
  return was
}

export async function encryptSecret(value: string | undefined): Promise<string | undefined> {
  if (!value) return value
  const key = macSecretKey()
  if (key) return sealMac(key, value)
  if (await safeStorage.isAsyncEncryptionAvailable()) return ENC_PREFIX + (await safeStorage.encryptStringAsync(value)).toString('base64')
  // No OS keychain (e.g. Linux without a secret service): stored obfuscated only. Surfaced in Settings.
  return PLAIN_PREFIX + Buffer.from(value, 'utf8').toString('base64')
}

export async function decryptSecret(value: string | undefined): Promise<string | undefined> {
  if (!value) return value
  try {
    if (value.startsWith(MAC_PREFIX)) {
      const key = macSecretKey()
      if (!key) throw new Error('The macOS key for saved passwords is unavailable')
      return openMac(key, value)
    }
    if (value.startsWith(ENC_PREFIX)) {
      // On macOS this asks the keychain one last time; the caller then re-encrypts with the key above.
      if (macSecretKey()) legacyRead = true
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

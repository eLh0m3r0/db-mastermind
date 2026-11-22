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

/** Installed for all users (the MSI, in Program Files; not the Store package): the organization updates it. */
export const installedForAllUsers = (() => {
  if (process.platform !== 'win32' || !app.isPackaged || process.windowsStore) return false
  const exeDir = dirname(app.getPath('exe')).toLowerCase()
  const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432].filter((p): p is string => !!p).map((p) => p.toLowerCase())
  return programFiles.some((p) => exeDir.startsWith(p)) && !existsSync(join(dirname(app.getPath('exe')), 'Uninstall DB Mastermind.exe'))
})()

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
/** Apple's `security` tool. Under DBM_DEBUG each call is logged by its command only (never a value). */
function security(args: string[]): string {
  if (process.env.DBM_DEBUG) console.error(`[secrets] security ${args[0]}`)
  return execFileSync('/usr/bin/security', args, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).toString().trim()
}

function macSecretKey(): Buffer | null {
  // Development and e2e runs (a fresh data folder each time) would leave a keychain item per run: packaged apps only.
  if (process.platform !== 'darwin' || (!app.isPackaged && !process.env.DBM_MAC_SECRET_KEY)) return null
  if (macKey !== undefined) return macKey
  // No login keychain: nothing is asked (not even `find`), and the answer isn't kept, so a keychain the user makes
  // meanwhile is used by the next save.
  if (!hasDefaultKeychain()) return null
  const service = 'DB Mastermind secrets'
  const account = createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 16)
  try {
    macKey = readOrCreateMacKey(security, service, account, hasDefaultKeychain)
  } catch (err) {
    // The keychain is there but didn't give the key (locked, refused, timed out): secrets under this key are kept, not
    // lost (UnreadableSecrets), and new ones this session use safeStorage, as they always did.
    if (process.env.DBM_DEBUG) console.error('macOS secret key unavailable:', (err as Error).message)
    macKey = null
  }
  return macKey
}

let defaultKeychain: boolean | undefined
let keychainCheckedAt = 0
/** How long "no keychain" is believed before it is asked again (the user may be making one as the form suggests). */
const KEYCHAIN_RECHECK_MS = 3000
/**
 * macOS: whether the user has a default (login) keychain to keep a key in. Without one, adding an item (ours, or
 * safeStorage's) shows "Keychain Not Found" for each: a new Mac user can be without one. `security default-keychain
 * -d user` asks without a dialog: it exits 1 when there is none; a keychain file that no longer exists counts as none.
 * "There is one" holds for the session; "there is none" is asked again after a moment.
 */
export function hasDefaultKeychain(): boolean {
  if (process.platform !== 'darwin') return true
  if (defaultKeychain === true || (defaultKeychain === false && Date.now() - keychainCheckedAt < KEYCHAIN_RECHECK_MS)) return defaultKeychain
  keychainCheckedAt = Date.now()
  try {
    const path = security(['default-keychain', '-d', 'user']).replace(/^\s*"|"\s*$/g, '')
    defaultKeychain = !!path && existsSync(path)
  } catch {
    defaultKeychain = false
  }
  if (!defaultKeychain && process.env.DBM_DEBUG) console.error('[secrets] no default keychain: secrets are stored without encryption')
  return defaultKeychain
}

let safeStorageUsed = false

/**
 * Whether encrypting now asks nothing new of the keychain: on macOS, a key is already in use this session (read for
 * a secret the user saved). Elsewhere encrypting never shows a dialog.
 */
export function secretKeyInUse(): boolean {
  if (process.platform !== 'darwin') return true
  return !!macKey || safeStorageUsed
}

/** Whether safeStorage may be used: on macOS only with a login keychain (without one it shows "Keychain Not Found"). */
function safeStorageAllowed(): boolean {
  return hasDefaultKeychain()
}

/** `security` exits with this when the keychain has no such item (errSecItemNotFound). */
const KEYCHAIN_ITEM_NOT_FOUND = 44

/**
 * Reads the key, creating it only when the keychain says there is none. Any other failure (locked keychain, timeout)
 * throws instead: a new key would replace the one every saved password is encrypted with.
 */
export function readOrCreateMacKey(security: (args: string[]) => string, service: string, account: string, keychainExists: () => boolean = () => true): Buffer {
  const find = ['find-generic-password', '-s', service, '-a', account, '-w']
  let hex: string
  try {
    hex = security(find)
  } catch (err) {
    if ((err as { status?: number }).status !== KEYCHAIN_ITEM_NOT_FOUND) throw err
    // `find` says "not found" also when there is no keychain at all; adding would then show "Keychain Not Found".
    if (!keychainExists()) throw new Error('This Mac user has no default keychain')
    const created = randomBytes(32).toString('hex')
    try {
      // No -U: never overwrite a key. Adding fails when another process (the MCP server) created one meanwhile.
      security(['add-generic-password', '-s', service, '-a', account, '-l', 'DB Mastermind', '-w', created])
    } catch {
      // Use the one that exists.
    }
    hex = security(find)
  }
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('The stored key is malformed')
  return Buffer.from(hex, 'hex')
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

/**
 * Linux without a secret service (GNOME Keyring, KWallet): Chromium falls back to a fixed key ('basic_text'), or
 * the app to plain obfuscation. Saved passwords are then readable by anyone who can read the data folder.
 */
export function secretsWithoutKeychain(): 'keyring' | 'mac-keychain' | undefined {
  // (macOS: only where a key would be kept in the keychain or safeStorage would be used.)
  if (process.platform === 'darwin') return hasDefaultKeychain() ? undefined : 'mac-keychain'
  if (process.platform !== 'linux' || process.env.DBM_USER_DATA) return undefined
  try {
    if (!safeStorage.isEncryptionAvailable()) return 'keyring'
    const backend = (safeStorage as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.()
    return backend === 'basic_text' || backend === 'unknown' ? 'keyring' : undefined
  } catch {
    return undefined
  }
}

export async function encryptSecret(value: string | undefined): Promise<string | undefined> {
  if (!value) return value
  const key = macSecretKey()
  if (key) return sealMac(key, value)
  if (safeStorageAllowed() && (await safeStorage.isAsyncEncryptionAvailable())) {
    if (process.env.DBM_DEBUG) console.error('[secrets] safeStorage encrypt')
    const sealed = ENC_PREFIX + (await safeStorage.encryptStringAsync(value)).toString('base64')
    safeStorageUsed = true
    return sealed
  }
  // No OS keychain (Linux without a secret service, a Mac user without a login keychain): stored obfuscated only. The
  // forms say so (secretsWithoutKeychain).
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
      if (!safeStorageAllowed()) throw new Error('The keychain is unavailable')
      if (process.env.DBM_DEBUG) console.error('[secrets] safeStorage decrypt')
      const plain = (await safeStorage.decryptStringAsync(Buffer.from(value.slice(ENC_PREFIX.length), 'base64'))).result
      safeStorageUsed = true
      return plain
    }
    if (value.startsWith(PLAIN_PREFIX)) {
      // Stored without a keychain on a Mac that has one now: the caller saves again, encrypted (a secret the user gave).
      if (process.platform === 'darwin' && safeStorageAllowed()) legacyRead = true
      return Buffer.from(value.slice(PLAIN_PREFIX.length), 'base64').toString('utf8')
    }
  } catch (err) {
    // Encrypted on another machine/user (e.g. portable folder copied), or the keychain is unavailable right now: the
    // secret must be re-entered. Callers keep the ciphertext (see UnreadableSecrets), so a passing outage loses nothing.
    if (process.env.DBM_DEBUG) console.error('decryptSecret failed:', err)
    return undefined
  }
  return value
}

/**
 * Secrets that couldn't be decrypted when loading, by owner and field. Saving writes their ciphertext back unchanged
 * until a new value replaces it; otherwise the first save after a keychain hiccup would erase them for good.
 */
export class UnreadableSecrets {
  private kept = new Map<string, string>()

  /** Decrypts, remembering the ciphertext when that fails. */
  async decrypt(owner: string, field: string, value: string | undefined): Promise<string | undefined> {
    const plain = await decryptSecret(value)
    if (value && plain === undefined) this.kept.set(`${owner}\n${field}`, value)
    return plain
  }

  /** Encrypts a value, or gives back the kept ciphertext when there's none. A new value replaces the kept one. */
  async encrypt(owner: string, field: string, value: string | undefined): Promise<string | undefined> {
    const key = `${owner}\n${field}`
    if (!value) return this.kept.get(key) ?? value
    this.kept.delete(key)
    return encryptSecret(value)
  }

  has(owner: string, field: string): boolean {
    return this.kept.has(`${owner}\n${field}`)
  }

  clear(): void {
    this.kept.clear()
  }
}

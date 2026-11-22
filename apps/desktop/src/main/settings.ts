import { randomBytes } from 'node:crypto'
import { app } from 'electron'
import type { AiProviderSettings, AppSettings } from '@shared/api'
import { managedConfig } from './managed'
import { enforceManagedSettings } from './managed-config'
import { readJson, secretKeyInUse, takeLegacySecretsFlag, UnreadableSecrets, writeJson } from './storage'

const FILE = 'settings.json'

export function defaultSettings(): AppSettings {
  return {
    theme: 'system',
    // First run follows the system language (Czech or English); after that the user's choice is stored.
    language: process.env.DBM_LANGUAGE === 'en' || process.env.DBM_LANGUAGE === 'cs' ? process.env.DBM_LANGUAGE : /^cs\b/i.test(app.getLocale()) || app.getPreferredSystemLanguages().some((l) => /^cs\b/i.test(l)) ? 'cs' : 'en',
    pageSize: 200,
    maxResultRows: 10_000,
    editorFontSize: 13,
    confirmDangerousStatements: true,
    showSystemSchemas: false,
    nullDisplay: 'NULL',
    dateFormat: 'iso',
    ai: { providers: [], dataSharing: 'schema-and-samples', autoRunReadQueries: true },
    // No token until the endpoint is turned on (updateSettings): a token is a secret, and storing one is what would
    // ask the keychain for a key on the very first start.
    mcp: { enabled: false, port: 7337, token: '', allowWrites: false },
  }
}

let cached: AppSettings | undefined

/** API keys that didn't decrypt (keychain unavailable): saving keeps them instead of erasing them. */
const unreadable = new UnreadableSecrets()

function mapKeys(providers: AiProviderSettings[], fn: (owner: string, field: string, v: string | undefined) => Promise<string | undefined>) {
  return Promise.all(providers.map(async (p) => ({ ...p, apiKey: await fn(p.id, 'apiKey', p.apiKey) })))
}

/** Encrypted values start like this (storage.ts); anything else in the token field is a token saved in plain text. */
const ENCRYPTED = /^(enc:v\d+|plain):/

/** A new token for the MCP endpoint. */
const newToken = () => randomBytes(24).toString('base64url')

/**
 * The MCP endpoint's token, decrypted. A token saved in plain text by older versions is used as it is (agents are
 * configured with it). One that doesn't decrypt (keychain unavailable) is kept as ciphertext and written back on save;
 * meanwhile the token is empty, which the endpoint never accepts. Missing or too short: none (created when the
 * endpoint is turned on).
 */
async function readToken(stored: string | undefined): Promise<string> {
  if (!stored) return ''
  const plain = await unreadable.decrypt('mcp', 'token', stored)
  return plain && plain.length >= 16 ? plain : ''
}

/** The token was set or the endpoint turned on this session: saving it may create the key (the user asked for it). */
let tokenChosen = false

/**
 * Reads settings and decrypts API keys and the MCP token. Must run after app 'ready'. A fresh profile asks nothing of
 * the keychain: only secrets that exist are decrypted, and nothing new is encrypted.
 */
export async function loadSettings(): Promise<void> {
  const defaults = defaultSettings()
  const stored = readJson<Partial<AppSettings>>(FILE, {})
  takeLegacySecretsFlag()
  unreadable.clear()
  tokenChosen = false
  const token = await readToken(stored.mcp?.token)
  cached = enforceManagedSettings({
    ...defaults,
    ...stored,
    ai: { ...defaults.ai, ...stored.ai, providers: await mapKeys(stored.ai?.providers ?? [], (owner, field, v) => unreadable.decrypt(owner, field, v)) },
    mcp: { ...defaults.mcp, ...stored.mcp, token },
  }, managedConfig())
  // The endpoint is on but its token is missing (a hand-edited file): a new one, stored as the next save decides.
  const missing = cached.mcp.enabled && !cached.mcp.token && !unreadable.has('mcp', 'token')
  if (missing) cached = { ...cached, mcp: { ...cached.mcp, token: newToken() } }
  // The first run stores the detected language. Also saves secrets read in an older encryption format in the current one.
  if (missing || !stored.language || takeLegacySecretsFlag()) persist(cached)
}

export function getSettings(): AppSettings {
  cached ??= defaultSettings()
  return cached
}

let writes = Promise.resolve()

/**
 * The token as saved: encrypted once a key is in use anyway or the user turned the endpoint on or made a new token.
 * Until then a token an older version saved in plain text stays as it was: it must never be what creates the key.
 */
async function tokenToStore(token: string): Promise<string | undefined> {
  if (token && !tokenChosen && !secretKeyInUse()) return token
  return unreadable.encrypt('mcp', 'token', token)
}

function persist(settings: AppSettings) {
  writes = writes
    .then(async () =>
      writeJson(FILE, {
        ...settings,
        ai: { ...settings.ai, providers: await mapKeys(settings.ai.providers, (owner, field, v) => unreadable.encrypt(owner, field, v)) },
        mcp: { ...settings.mcp, token: await tokenToStore(settings.mcp.token) },
      }),
    )
    .catch((err: unknown) => console.error('Could not save settings', err))
}

/**
 * Saving the app's AI defaults also sets the older app-wide data sharing to match: `aiAccess` still applies a "schema
 * only" stored there, and the defaults are where the user now chooses it.
 */
function sharingOf(patch: Partial<AppSettings['ai']>, current: AppSettings['ai']): Partial<AppSettings['ai']> {
  // (The settings page sends the whole AI section: a data sharing equal to the current one is no choice of its own.)
  if (!patch.defaults || (patch.dataSharing !== undefined && patch.dataSharing !== current.dataSharing)) return {}
  if (patch.defaults.access === 'schema') return { dataSharing: 'schema' }
  return current.dataSharing === 'schema' ? { dataSharing: 'schema-and-samples' } : {}
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const current = getSettings()
  const next: AppSettings = {
    ...current,
    ...patch,
    ai: patch.ai ? { ...current.ai, ...patch.ai, ...sharingOf(patch.ai, current.ai) } : current.ai,
    mcp: patch.mcp ? { ...current.mcp, ...patch.mcp } : current.mcp,
  }
  // Turning the endpoint on (or a new token) is when the token is needed: made now if there is none.
  if (patch.mcp && next.mcp.enabled) {
    tokenChosen = true
    if (!next.mcp.token && !unreadable.has('mcp', 'token')) next.mcp = { ...next.mcp, token: newToken() }
  }
  cached = enforceManagedSettings(next, managedConfig())
  persist(cached)
  return cached
}

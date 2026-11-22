import { randomBytes } from 'node:crypto'
import { app } from 'electron'
import type { AiProviderSettings, AppSettings } from '@shared/api'
import { managedConfig } from './managed'
import { enforceManagedSettings } from './managed-config'
import { readJson, takeLegacySecretsFlag, UnreadableSecrets, writeJson } from './storage'

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
    mcp: { enabled: false, port: 7337, token: randomBytes(24).toString('base64url'), allowWrites: false },
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

/**
 * The MCP endpoint's token, decrypted. A token saved in plain text by older versions is used as it is (agents are
 * configured with it) and saved encrypted. One that doesn't decrypt (keychain unavailable) is kept as ciphertext and
 * written back on save; meanwhile the token is empty, which the endpoint never accepts. Only a missing or too short
 * token is replaced by a new one.
 */
async function readToken(stored: string | undefined, fresh: string): Promise<{ token: string; save: boolean }> {
  if (!stored) return { token: fresh, save: true }
  const plain = await unreadable.decrypt('mcp', 'token', stored)
  if (plain === undefined) return { token: '', save: false }
  if (plain.length < 16) return { token: fresh, save: true }
  return { token: plain, save: !ENCRYPTED.test(stored) }
}

/** Reads settings and decrypts API keys and the MCP token. Must run after app 'ready'. */
export async function loadSettings(): Promise<void> {
  const defaults = defaultSettings()
  const stored = readJson<Partial<AppSettings>>(FILE, {})
  takeLegacySecretsFlag()
  unreadable.clear()
  const token = await readToken(stored.mcp?.token, defaults.mcp.token)
  cached = enforceManagedSettings({
    ...defaults,
    ...stored,
    ai: { ...defaults.ai, ...stored.ai, providers: await mapKeys(stored.ai?.providers ?? [], (owner, field, v) => unreadable.decrypt(owner, field, v)) },
    mcp: { ...defaults.mcp, ...stored.mcp, token: token.token },
  }, managedConfig())
  // The first run stores the generated token (also replacing an empty or short one) and the detected language; a
  // token in plain text is saved encrypted. Also saves secrets read in an older encryption format in the current one.
  if (token.save || !stored.language || takeLegacySecretsFlag()) persist(cached)
}

export function getSettings(): AppSettings {
  cached ??= defaultSettings()
  return cached
}

let writes = Promise.resolve()

function persist(settings: AppSettings) {
  writes = writes
    .then(async () =>
      writeJson(FILE, {
        ...settings,
        ai: { ...settings.ai, providers: await mapKeys(settings.ai.providers, (owner, field, v) => unreadable.encrypt(owner, field, v)) },
        mcp: { ...settings.mcp, token: await unreadable.encrypt('mcp', 'token', settings.mcp.token) },
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
  cached = enforceManagedSettings(next, managedConfig())
  persist(cached)
  return cached
}

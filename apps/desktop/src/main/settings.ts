import { randomBytes } from 'node:crypto'
import { app } from 'electron'
import type { AiProviderSettings, AppSettings } from '@shared/api'
import { managedConfig } from './managed'
import { enforceManagedSettings } from './managed-config'
import { decryptSecret, encryptSecret, readJson, writeJson } from './storage'

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

function mapKeys(providers: AiProviderSettings[], fn: (v: string | undefined) => Promise<string | undefined>) {
  return Promise.all(providers.map(async (p) => ({ ...p, apiKey: await fn(p.apiKey) })))
}

/** Reads settings and decrypts API keys. Must run after app 'ready'. */
export async function loadSettings(): Promise<void> {
  const defaults = defaultSettings()
  const stored = readJson<Partial<AppSettings>>(FILE, {})
  cached = enforceManagedSettings({
    ...defaults,
    ...stored,
    ai: { ...defaults.ai, ...stored.ai, providers: await mapKeys(stored.ai?.providers ?? [], decryptSecret) },
    mcp: { ...defaults.mcp, ...stored.mcp, token: stored.mcp?.token && stored.mcp.token.length >= 16 ? stored.mcp.token : defaults.mcp.token },
  }, managedConfig())
  // The first run stores the generated token (also replacing an empty or short one) and the detected language.
  if (!stored.mcp?.token || stored.mcp.token.length < 16 || !stored.language) persist(cached)
}

export function getSettings(): AppSettings {
  cached ??= defaultSettings()
  return cached
}

let writes = Promise.resolve()

function persist(settings: AppSettings) {
  writes = writes
    .then(async () => writeJson(FILE, { ...settings, ai: { ...settings.ai, providers: await mapKeys(settings.ai.providers, encryptSecret) } }))
    .catch((err: unknown) => console.error('Could not save settings', err))
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const current = getSettings()
  const next: AppSettings = {
    ...current,
    ...patch,
    ai: patch.ai ? { ...current.ai, ...patch.ai } : current.ai,
    mcp: patch.mcp ? { ...current.mcp, ...patch.mcp } : current.mcp,
  }
  cached = enforceManagedSettings(next, managedConfig())
  persist(cached)
  return cached
}

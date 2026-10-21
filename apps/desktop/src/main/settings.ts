import { randomBytes } from 'node:crypto'
import type { AiProviderSettings, AppSettings } from '@shared/api'
import { decryptSecret, encryptSecret, readJson, writeJson } from './storage'

const FILE = 'settings.json'

export function defaultSettings(): AppSettings {
  return {
    theme: 'system',
    language: 'en',
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

function mapKeys(providers: AiProviderSettings[], fn: (v: string | undefined) => string | undefined) {
  return providers.map((p) => ({ ...p, apiKey: fn(p.apiKey) }))
}

export function getSettings(): AppSettings {
  if (cached) return cached
  const defaults = defaultSettings()
  const stored = readJson<Partial<AppSettings>>(FILE, {})
  cached = {
    ...defaults,
    ...stored,
    ai: { ...defaults.ai, ...stored.ai, providers: mapKeys(stored.ai?.providers ?? [], decryptSecret) },
    mcp: { ...defaults.mcp, ...stored.mcp },
  }
  if (!stored.mcp?.token) persist(cached)
  return cached
}

function persist(settings: AppSettings) {
  writeJson(FILE, { ...settings, ai: { ...settings.ai, providers: mapKeys(settings.ai.providers, encryptSecret) } })
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const current = getSettings()
  const next: AppSettings = {
    ...current,
    ...patch,
    ai: patch.ai ? { ...current.ai, ...patch.ai } : current.ai,
    mcp: patch.mcp ? { ...current.mcp, ...patch.mcp } : current.mcp,
  }
  cached = next
  persist(next)
  return next
}

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ConnectionConfig } from '@dbmastermind/core'
import type { AiDataSharing, AiProviderId, AiProviderSettings, AppSettings, ManagedInfo, ManagedPolicies, StoredConnection } from '../shared/api'

/**
 * A configuration file an IT department (or a colleague preparing the portable zip) puts next to the app or in a
 * system folder: predefined connections, AI endpoints and policies. Users can't override it from the UI.
 */
export interface ManagedConfig {
  /** Connections everyone gets. Secrets are never read from this file; users enter their own credentials. */
  connections?: (Partial<ConnectionConfig> & { id: string; name: string; driver: ConnectionConfig['driver'] })[]
  /** AI providers without keys, e.g. the company's Azure OpenAI endpoint or a local Ollama server. */
  aiProviders?: Omit<AiProviderSettings, 'apiKey'>[]
  /** Used when the user hasn't chosen a provider. */
  defaultAiProvider?: AiProviderId
  /** Team folder everyone uses (network share, synced folder); users can't change it. */
  teamFolder?: string
  policies?: ManagedPolicies
}

export const MANAGED_FILE = 'dbmastermind-managed.json'

/** Where the file is looked for, first match wins. */
export function managedConfigPaths(exePath: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const exeDir = dirname(exePath)
  const paths = [env.DBM_MANAGED_CONFIG, env.PORTABLE_EXECUTABLE_DIR && join(env.PORTABLE_EXECUTABLE_DIR, MANAGED_FILE), join(exeDir, MANAGED_FILE)]
  // macOS: next to the .app bundle as well (exe is …/DB Mastermind.app/Contents/MacOS/DB Mastermind).
  if (platform === 'darwin') paths.push(join(exeDir, '..', '..', '..', MANAGED_FILE), '/Library/Application Support/DB Mastermind/managed.json')
  else if (platform === 'win32') paths.push(join(env.ProgramData ?? 'C:\\ProgramData', 'DB Mastermind', 'managed.json'))
  else paths.push('/etc/dbmastermind/managed.json')
  return paths.filter((p): p is string => !!p)
}

const SECRET_KEYS = ['password'] as const

/** Reads the first managed config found; a broken file is reported instead of silently ignored. */
export function readManagedConfig(paths: string[]): { config: ManagedConfig; info: ManagedInfo } | null {
  const path = paths.find((p) => existsSync(p))
  if (!path) return null
  try {
    const config = JSON.parse(readFileSync(path, 'utf8')) as ManagedConfig
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('The file must contain a JSON object')
    for (const c of config.connections ?? []) {
      if (!c.id || !c.name || !c.driver) throw new Error('Every connection needs "id", "name" and "driver"')
    }
    return { config, info: { path, policies: config.policies ?? {}, connections: (config.connections ?? []).length } }
  } catch (err) {
    // Fail closed: with an unreadable policy file, AI and MCP stay off rather than wide open.
    return { config: { policies: { allowAi: false, allowMcp: false } }, info: { path, policies: { allowAi: false, allowMcp: false }, connections: 0, error: (err as Error).message } }
  }
}

/**
 * Saved connections with the managed (or team folder) ones added; their fields win, the user's own credentials
 * are kept. `mark` is the flag set on them.
 */
export function mergeManagedConnections(
  stored: StoredConnection[],
  managed: Pick<ManagedConfig, 'connections' | 'policies'> | null,
  now = new Date().toISOString(),
  mark: 'managed' | 'team' = 'managed',
): StoredConnection[] {
  const defs = managed?.connections ?? []
  const byId = new Map(defs.map((d) => [d.id, d]))
  const strip = <T extends object>(d: T): T => {
    const out = { ...d } as Record<string, unknown>
    for (const key of SECRET_KEYS) delete out[key]
    if (out.ssh && typeof out.ssh === 'object') out.ssh = { ...(out.ssh as object), password: undefined, privateKey: undefined, passphrase: undefined }
    return out as T
  }
  const out = stored.map((c) => {
    const def = byId.get(c.id)
    if (!def) return c[mark] ? { ...c, [mark]: undefined } : c
    const merged = { ...c, ...strip(def), [mark]: true } as StoredConnection
    // Keep the user's SSH secrets when the managed entry defines the tunnel.
    if (def.ssh && c.ssh) merged.ssh = { ...merged.ssh!, password: c.ssh.password, privateKey: c.ssh.privateKey, passphrase: c.ssh.passphrase }
    return merged
  })
  for (const def of defs) {
    if (!stored.some((c) => c.id === def.id)) out.push({ ...(strip(def) as ConnectionConfig), createdAt: now, updatedAt: now, [mark]: true } as StoredConnection)
  }
  if (managed?.policies?.allowAi === false) return out.map((c) => ({ ...c, aiEnabled: false }))
  return out
}

const SHARING: AiDataSharing[] = ['schema', 'schema-and-samples', 'full']

/** Settings with the policies applied: providers added or restricted, data sharing capped, MCP switched off. */
export function enforceManagedSettings(settings: AppSettings, managed: ManagedConfig | null): AppSettings {
  if (!managed) return settings
  const p = managed.policies ?? {}
  let providers = settings.ai.providers.map((s) => {
    const def = managed.aiProviders?.find((d) => d.id === s.id)
    return def ? { ...s, ...def, apiKey: s.apiKey } : s
  })
  for (const def of managed.aiProviders ?? []) if (!providers.some((s) => s.id === def.id)) providers.push({ ...def })
  if (p.allowedAiProviders) providers = providers.filter((s) => p.allowedAiProviders!.includes(s.id))
  let activeProvider = settings.ai.activeProvider ?? managed.defaultAiProvider
  if (activeProvider && !providers.some((s) => s.id === activeProvider)) activeProvider = undefined
  const cap = p.maxAiDataSharing ? SHARING.indexOf(p.maxAiDataSharing) : SHARING.length - 1
  const dataSharing = SHARING.indexOf(settings.ai.dataSharing) > cap ? SHARING[cap]! : settings.ai.dataSharing
  return {
    ...settings,
    teamFolder: managed.teamFolder ?? settings.teamFolder,
    ai: { ...settings.ai, providers, activeProvider, dataSharing },
    mcp: {
      ...settings.mcp,
      enabled: p.allowMcp === false ? false : settings.mcp.enabled,
      allowWrites: p.allowMcp === false || p.allowMcpWrites === false ? false : settings.mcp.allowWrites,
    },
  }
}

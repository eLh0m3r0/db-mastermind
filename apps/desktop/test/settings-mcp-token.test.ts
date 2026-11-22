import { afterEach, describe, expect, it, vi } from 'vitest'

// settings.json in memory; secrets "encrypted" as enc:v2:<base64>, unreadable while the keychain is locked.
const disk = vi.hoisted(() => ({ files: new Map<string, unknown>(), locked: false, logged: [] as string[] }))
vi.mock('electron', () => ({ app: { getLocale: () => 'en', getPreferredSystemLanguages: () => ['en'] } }))
vi.mock('../src/main/managed', () => ({ managedConfig: () => null }))
vi.mock('../src/main/storage', () => {
  const encryptSecret = async (v: string | undefined) => (v ? `enc:v2:${Buffer.from(v).toString('base64')}` : v)
  const decryptSecret = async (v: string | undefined) => {
    if (!v || !v.startsWith('enc:v2:')) return v
    return disk.locked ? undefined : Buffer.from(v.slice(7), 'base64').toString()
  }
  // As storage.ts: a value that doesn't decrypt is kept and written back until a new value replaces it.
  class UnreadableSecrets {
    private kept = new Map<string, string>()
    async decrypt(owner: string, field: string, value: string | undefined) {
      const plain = await decryptSecret(value)
      if (value && plain === undefined) this.kept.set(`${owner}\n${field}`, value)
      return plain
    }
    async encrypt(owner: string, field: string, value: string | undefined) {
      if (!value) return this.kept.get(`${owner}\n${field}`) ?? value
      this.kept.delete(`${owner}\n${field}`)
      return encryptSecret(value)
    }
    has(owner: string, field: string) {
      return this.kept.has(`${owner}\n${field}`)
    }
    clear() {
      this.kept.clear()
    }
  }
  return {
    readJson: (file: string, fallback: unknown) => structuredClone(disk.files.get(file) ?? fallback),
    writeJson: (file: string, value: unknown) => void disk.files.set(file, structuredClone(value)),
    takeLegacySecretsFlag: () => false,
    // No key in use yet (a fresh start): a token from an older version is then left as it is (keychain-start.test.ts).
    secretKeyInUse: () => false,
    UnreadableSecrets,
  }
})

const { getSettings, loadSettings, updateSettings } = await import('../src/main/settings')

const TOKEN = 'agent-token-0123456789abcdefXYZ'
const stored = () => disk.files.get('settings.json') as { mcp: { token: string }; ai: { dataSharing: string } }
const flush = () => new Promise((r) => setTimeout(r, 20))
const everything = () => JSON.stringify([...disk.files.values()]) + disk.logged.join('\n')

afterEach(() => {
  disk.files.clear()
  disk.locked = false
  disk.logged = []
  vi.restoreAllMocks()
})

describe('the MCP endpoint token in settings.json', () => {
  const turnOn = () => updateSettings({ mcp: { ...getSettings().mcp, enabled: true } })

  it('is made when the endpoint is turned on and saved encrypted like the API keys', async () => {
    await loadSettings()
    await flush()
    expect(getSettings().mcp.token).toBe('')
    turnOn()
    await flush()
    const token = getSettings().mcp.token
    expect(token.length).toBeGreaterThanOrEqual(16)
    expect(stored().mcp.token).toMatch(/^enc:v2:/)
    expect(JSON.stringify(stored())).not.toContain(token)
    updateSettings({ mcp: { ...getSettings().mcp, port: 7444 } })
    await flush()
    expect(JSON.stringify(stored())).not.toContain(token)
  })

  it('a token saved in plain text by an older version keeps its value and is saved encrypted when the endpoint is turned on', async () => {
    disk.files.set('settings.json', { language: 'en', mcp: { enabled: false, port: 7337, token: TOKEN, allowWrites: false } })
    await loadSettings()
    await flush()
    expect(getSettings().mcp.token).toBe(TOKEN)
    turnOn()
    await flush()
    expect(getSettings().mcp.token).toBe(TOKEN)
    expect(stored().mcp.token).toMatch(/^enc:v2:/)
    expect(JSON.stringify(stored())).not.toContain(TOKEN)
    await loadSettings()
    expect(getSettings().mcp.token).toBe(TOKEN)
  })

  it('a keychain hiccup neither loses nor replaces it, and the endpoint gets no usable token meanwhile', async () => {
    disk.files.set('settings.json', { language: 'en', mcp: { enabled: true, port: 7337, token: `enc:v2:${Buffer.from(TOKEN).toString('base64')}`, allowWrites: false } })
    disk.locked = true
    await loadSettings()
    expect(getSettings().mcp.token).toBe('')
    updateSettings({ theme: 'dark' })
    updateSettings({ mcp: { ...getSettings().mcp, port: 7444 } })
    await flush()
    expect(stored().mcp.token).toBe(`enc:v2:${Buffer.from(TOKEN).toString('base64')}`)
    disk.locked = false
    await loadSettings()
    expect(getSettings().mcp.token).toBe(TOKEN)
  })

  it('never shows up in what is logged when saving fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation((...args) => void disk.logged.push(args.map(String).join(' ')))
    disk.files.set('settings.json', { language: 'en', mcp: { enabled: false, port: 7337, token: TOKEN, allowWrites: false } })
    await loadSettings()
    turnOn()
    await flush()
    disk.files.set = () => {
      throw new Error('disk full')
    }
    updateSettings({ theme: 'dark' })
    await flush()
    expect(errors).toHaveBeenCalled()
    expect(disk.logged.join('\n')).not.toContain(TOKEN)
    disk.files.set = Map.prototype.set
    expect(everything()).not.toContain(TOKEN)
  })
})

describe('saving the AI defaults sets the older data sharing to match', () => {
  it('schema only in the defaults is schema only everywhere; lifting it lifts the older setting too', async () => {
    disk.files.set('settings.json', { language: 'en', ai: { providers: [], dataSharing: 'schema' }, mcp: { token: TOKEN } })
    await loadSettings()
    updateSettings({ ai: { ...getSettings().ai, defaults: { access: 'read', agents: true } } })
    expect(getSettings().ai.dataSharing).toBe('schema-and-samples')
    updateSettings({ ai: { ...getSettings().ai, defaults: { access: 'schema', agents: true } } })
    expect(getSettings().ai.dataSharing).toBe('schema')
  })
})

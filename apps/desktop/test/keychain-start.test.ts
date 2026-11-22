import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * macOS keychain at start (1.5.1 on a new Mac showed "Keychain Not Found" twice): a fresh profile asks nothing of the
 * keychain; a Mac user without a default keychain never gets `add-generic-password` or safeStorage (each would show
 * that dialog) and secrets are stored obfuscated with the forms saying so; a keychain that appears later encrypts them
 * on the next save. `security` and safeStorage are fakes here: nothing reaches the real keychain.
 */

const dir = mkdtempSync(join(tmpdir(), 'dbm-keychain-'))
const keychainFile = join(dir, 'login.keychain-db')
writeFileSync(keychainFile, '')
const mac = vi.hoisted(() => ({
  keychain: true,
  /** Every `security` command and safeStorage call, in order. A call that would show a dialog is marked DIALOG. */
  calls: [] as string[],
  items: new Map<string, string>(),
  data: '',
  keychainPath: '',
}))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFileSync: (bin: string, args: string[]) => {
    if (bin !== '/usr/bin/security') throw new Error(`unexpected ${bin}`)
    const fail = (status: number) => {
      throw Object.assign(new Error(`security exited ${status}`), { status })
    }
    const opt = (name: string) => args[args.indexOf(name) + 1]!
    switch (args[0]) {
      case 'default-keychain':
        mac.calls.push('default-keychain')
        if (!mac.keychain) fail(1)
        return Buffer.from(`    "${mac.keychainPath}"\n`)
      case 'find-generic-password': {
        mac.calls.push('find')
        const v = mac.items.get(`${opt('-s')}/${opt('-a')}`)
        if (v === undefined) fail(44)
        return Buffer.from(`${v}\n`)
      }
      case 'add-generic-password':
        if (!mac.keychain) {
          mac.calls.push('add DIALOG')
          fail(1)
        }
        mac.calls.push('add')
        mac.items.set(`${opt('-s')}/${opt('-a')}`, opt('-w'))
        return Buffer.from('')
      default:
        throw new Error(`unexpected security ${args[0]}`)
    }
  },
}))
vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => mac.data, getLocale: () => 'en', getPreferredSystemLanguages: () => ['en'] },
  safeStorage: {
    isEncryptionAvailable: () => (mac.calls.push('safeStorage available'), true),
    isAsyncEncryptionAvailable: async () => (mac.calls.push(mac.keychain ? 'safeStorage available' : 'safeStorage DIALOG'), true),
    encryptStringAsync: async (v: string) => (mac.calls.push(mac.keychain ? 'safeStorage encrypt' : 'safeStorage DIALOG'), Buffer.from(`ss:${v}`)),
    decryptStringAsync: async (b: Buffer) => (mac.calls.push(mac.keychain ? 'safeStorage decrypt' : 'safeStorage DIALOG'), { result: b.toString().slice(3) }),
  },
}))
vi.mock('../src/main/managed', () => ({ managedConfig: () => null }))
vi.mock('../src/main/team', () => ({ team: () => null }))

const platform = process.platform
afterAll(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  rmSync(dir, { recursive: true, force: true })
})

/** A new app start: fresh module state (cached keys, the keychain check) over the same data folder. */
async function start() {
  vi.resetModules()
  const storage = await import('../src/main/storage')
  const settings = await import('../src/main/settings')
  const connections = await import('../src/main/connections')
  return { storage, settings, connections }
}
const flush = () => new Promise((r) => setTimeout(r, 30))
const saved = (file: string) => JSON.parse(readFileSync(join(mac.data, file), 'utf8'))
const TOKEN = 'agent-token-0123456789abcdefXYZ'

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  mac.keychain = true
  mac.calls = []
  mac.items = new Map()
  mac.data = mkdtempSync(join(dir, 'data-'))
  mac.keychainPath = keychainFile
})

describe('a fresh profile', () => {
  it('starts without asking the keychain or safeStorage anything, and has no MCP token', async () => {
    const { settings, connections } = await start()
    await settings.loadSettings()
    await connections.loadConnections()
    await flush()
    expect(mac.calls).toEqual([])
    expect(settings.getSettings().mcp.token).toBe('')
    expect(saved('settings.json').mcp.token).toBe('')
  })

  it('the --mcp process (settings and connections loaded again) asks nothing either', async () => {
    const { settings, connections } = await start()
    await settings.loadSettings()
    await flush()
    await settings.loadSettings()
    await connections.loadConnections()
    await flush()
    expect(mac.calls).toEqual([])
  })
})

describe('the MCP endpoint token', () => {
  it('is made and encrypted when the endpoint is turned on (that may create the key: the user asked for it)', async () => {
    const { settings } = await start()
    await settings.loadSettings()
    settings.updateSettings({ mcp: { ...settings.getSettings().mcp, enabled: true } })
    await flush()
    const token = settings.getSettings().mcp.token
    expect(token.length).toBeGreaterThanOrEqual(16)
    expect(saved('settings.json').mcp.token).toMatch(/^enc:v2:/)
    expect(mac.calls).toEqual(['default-keychain', 'find', 'add', 'find'])
    // The next start reads it back with the key that exists.
    const next = await start()
    await next.settings.loadSettings()
    expect(next.settings.getSettings().mcp.token).toBe(token)
  })

  it('a token an older version saved in plain text keeps working and never creates the key at start', async () => {
    writeFileSync(join(mac.data, 'settings.json'), JSON.stringify({ language: 'en', mcp: { enabled: true, port: 7337, token: TOKEN, allowWrites: false } }))
    const { settings } = await start()
    await settings.loadSettings()
    settings.updateSettings({ theme: 'dark' })
    await flush()
    expect(settings.getSettings().mcp.token).toBe(TOKEN)
    expect(saved('settings.json').mcp.token).toBe(TOKEN)
    expect(mac.calls).toEqual([])
  })

  it('…and is encrypted once a key is in use for a secret the user saved', async () => {
    writeFileSync(join(mac.data, 'settings.json'), JSON.stringify({ language: 'en', mcp: { enabled: true, port: 7337, token: TOKEN, allowWrites: false } }))
    const { settings } = await start()
    await settings.loadSettings()
    settings.updateSettings({ ai: { ...settings.getSettings().ai, providers: [{ id: 'openai', enabled: true, apiKey: 'sk-test-0123456789' }], activeProvider: 'openai' } })
    await flush()
    settings.updateSettings({ theme: 'dark' })
    await flush()
    expect(saved('settings.json').mcp.token).toMatch(/^enc:v2:/)
    const next = await start()
    await next.settings.loadSettings()
    expect(next.settings.getSettings().mcp.token).toBe(TOKEN)
  })

  it('…or when the endpoint is turned on again', async () => {
    writeFileSync(join(mac.data, 'settings.json'), JSON.stringify({ language: 'en', mcp: { enabled: false, port: 7337, token: TOKEN, allowWrites: false } }))
    const { settings } = await start()
    await settings.loadSettings()
    settings.updateSettings({ mcp: { ...settings.getSettings().mcp, enabled: true } })
    await flush()
    expect(settings.getSettings().mcp.token).toBe(TOKEN)
    expect(saved('settings.json').mcp.token).toMatch(/^enc:v2:/)
  })
})

describe('a Mac user without a default keychain', () => {
  beforeEach(() => {
    mac.keychain = false
  })

  it('never gets add-generic-password or safeStorage: a saved password is stored obfuscated and the forms warn', async () => {
    const { storage, settings, connections } = await start()
    await settings.loadSettings()
    await connections.loadConnections()
    connections.saveConnection({ id: 'pg', name: 'Shop', driver: 'postgres', host: 'db', password: 'secret-password' })
    await connections.flushConnections()
    expect(mac.calls.filter((c) => c.includes('DIALOG') || c.startsWith('add') || c.startsWith('safeStorage'))).toEqual([])
    expect(saved('connections.json')[0].password).toMatch(/^plain:/)
    expect(storage.secretsWithoutKeychain()).toBe('mac-keychain')
    // Turning the endpoint on stores its token the same way.
    settings.updateSettings({ mcp: { ...settings.getSettings().mcp, enabled: true } })
    await flush()
    expect(saved('settings.json').mcp.token).toMatch(/^plain:/)
    expect(mac.calls.filter((c) => c.includes('DIALOG') || c.startsWith('add') || c.startsWith('safeStorage'))).toEqual([])
  })

  it('a key the keychain can\'t find is not replaced, and an older safeStorage secret is kept as it is', async () => {
    writeFileSync(join(mac.data, 'connections.json'), JSON.stringify([{ id: 'a', name: 'A', driver: 'postgres', host: 'h', password: 'enc:v2:AAAA', createdAt: '', updatedAt: '' }, { id: 'b', name: 'B', driver: 'postgres', host: 'h', password: 'enc:v1:c3M6eA==', createdAt: '', updatedAt: '' }]))
    const { connections } = await start()
    await connections.loadConnections()
    connections.touchConnection('a')
    await connections.flushConnections()
    expect(saved('connections.json').map((c: { password: string }) => c.password)).toEqual(['enc:v2:AAAA', 'enc:v1:c3M6eA=='])
    expect(mac.calls.filter((c) => c.includes('DIALOG') || c.startsWith('add') || c.startsWith('safeStorage'))).toEqual([])
  })

  it('a keychain made later: the next start encrypts what was stored without one', async () => {
    const first = await start()
    await first.connections.loadConnections()
    first.connections.saveConnection({ id: 'pg', name: 'Shop', driver: 'postgres', host: 'db', password: 'secret-password' })
    await first.connections.flushConnections()
    expect(saved('connections.json')[0].password).toMatch(/^plain:/)
    mac.keychain = true
    const next = await start()
    await next.connections.loadConnections()
    await next.connections.flushConnections()
    await flush()
    expect(saved('connections.json')[0].password).toMatch(/^enc:v2:/)
    expect(next.connections.getConnection('pg').password).toBe('secret-password')
    expect(next.storage.secretsWithoutKeychain()).toBeUndefined()
  })

  it('a keychain file that no longer exists counts as none', async () => {
    mac.keychain = true
    mac.keychainPath = join(dir, 'gone.keychain-db')
    const { storage } = await start()
    expect(storage.hasDefaultKeychain()).toBe(false)
    expect(await storage.encryptSecret('x')).toMatch(/^plain:/)
    expect(mac.calls.filter((c) => c.startsWith('add') || c.startsWith('safeStorage'))).toEqual([])
  })
})

describe('with a keychain', () => {
  it('exit 44 creates the key once; later secrets use it without adding again', async () => {
    const { storage } = await start()
    const a = await storage.encryptSecret('one')
    const b = await storage.encryptSecret('two')
    expect([a, b].every((v) => v?.startsWith('enc:v2:'))).toBe(true)
    expect(mac.calls.filter((c) => c === 'add')).toHaveLength(1)
    expect(await storage.decryptSecret(a)).toBe('one')
  })

  it('a keychain that is there but does not give the key: secrets use safeStorage this session, as before, never plain text', async () => {
    const { storage } = await start()
    // A malformed key (as a locked or refusing keychain would) makes the key unavailable for the session.
    const account = (await import('node:crypto')).createHash('sha256').update(mac.data).digest('hex').slice(0, 16)
    mac.items.set(`DB Mastermind secrets/${account}`, 'not-a-key')
    expect(await storage.encryptSecret('x')).toMatch(/^enc:v1:/)
    // The key that exists is never replaced.
    expect(mac.calls.filter((c) => c.startsWith('add'))).toEqual([])
    expect(mac.items.get(`DB Mastermind secrets/${account}`)).toBe('not-a-key')
    expect(storage.secretsWithoutKeychain()).toBeUndefined()
  })
})

describe('a login keychain made while the app runs', () => {
  it('is used by the next save, as the form says: no restart needed', async () => {
    mac.keychain = false
    const now = vi.spyOn(Date, 'now')
    let clock = 1_000_000
    now.mockImplementation(() => clock)
    try {
      const { storage } = await start()
      expect(await storage.encryptSecret('first')).toMatch(/^plain:/)
      expect(storage.secretsWithoutKeychain()).toBe('mac-keychain')
      // Asked again only after a moment, never once per secret.
      const checks = () => mac.calls.filter((c) => c === 'default-keychain').length
      const before = checks()
      await storage.encryptSecret('second')
      expect(checks()).toBe(before)
      expect(mac.calls.filter((c) => c === 'find' || c.startsWith('add') || c.startsWith('safeStorage'))).toEqual([])
      mac.keychain = true
      clock += 5000
      expect(await storage.encryptSecret('third')).toMatch(/^enc:v2:/)
      expect(storage.secretsWithoutKeychain()).toBeUndefined()
      expect(mac.calls.filter((c) => c.includes('DIALOG'))).toEqual([])
    } finally {
      now.mockRestore()
    }
  })
})

describe('Windows and Linux are unchanged', () => {
  it('safeStorage encrypts as before and no `security` runs', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const { storage } = await start()
    expect(await storage.encryptSecret('x')).toMatch(/^enc:v1:/)
    expect(mac.calls.filter((c) => !c.startsWith('safeStorage'))).toEqual([])
    expect(storage.secretKeyInUse()).toBe(true)
  })
})

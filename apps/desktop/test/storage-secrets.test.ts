import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/nonexistent', setPath: () => undefined },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => false,
    decryptStringAsync: async () => {
      throw new Error('The keychain is locked')
    },
  },
}))

const { readOrCreateMacKey, UnreadableSecrets } = await import('../src/main/storage')

const KEY = 'ab'.repeat(32)
const failure = (status: number | null) => Object.assign(new Error(`security exited ${status}`), { status })

describe('readOrCreateMacKey', () => {
  it('reads the existing key', () => {
    const calls: string[][] = []
    const key = readOrCreateMacKey((args) => (calls.push(args), KEY), 's', 'a')
    expect(key.toString('hex')).toBe(KEY)
    expect(calls.map((c) => c[0])).toEqual(['find-generic-password'])
  })

  it('creates a key only when the keychain has none, without overwriting', () => {
    let stored: string | undefined
    const security = (args: string[]) => {
      if (args[0] === 'add-generic-password') {
        stored = args[args.indexOf('-w') + 1]
        return ''
      }
      if (stored === undefined) throw failure(44)
      return stored
    }
    const added: string[][] = []
    const key = readOrCreateMacKey((args) => (args[0] === 'add-generic-password' && added.push(args), security(args)), 's', 'a')
    expect(key.toString('hex')).toBe(stored)
    expect(added[0]).not.toContain('-U')
  })

  it('never replaces the key when reading fails for another reason', () => {
    for (const status of [36, 51, null]) {
      const added: string[][] = []
      const security = (args: string[]) => {
        if (args[0] === 'add-generic-password') added.push(args)
        throw failure(status)
      }
      expect(() => readOrCreateMacKey(security, 's', 'a')).toThrow()
      expect(added).toEqual([])
    }
  })

  it('uses the key another process created meanwhile', () => {
    let finds = 0
    const security = (args: string[]) => {
      if (args[0] === 'add-generic-password') throw failure(45)
      if (finds++ === 0) throw failure(44)
      return KEY
    }
    expect(readOrCreateMacKey(security, 's', 'a').toString('hex')).toBe(KEY)
  })
})

describe('UnreadableSecrets', () => {
  it('writes back a ciphertext that could not be decrypted', async () => {
    const secrets = new UnreadableSecrets()
    const sealed = 'enc:v1:c2VjcmV0'
    expect(await secrets.decrypt('c1', 'password', sealed)).toBeUndefined()
    expect(await secrets.encrypt('c1', 'password', undefined)).toBe(sealed)
    expect(await secrets.encrypt('c2', 'password', undefined)).toBeUndefined()
  })

  it('replaces it once a new value is entered', async () => {
    const secrets = new UnreadableSecrets()
    await secrets.decrypt('c1', 'password', 'enc:v1:c2VjcmV0')
    expect(await secrets.encrypt('c1', 'password', 'new')).toBe(`plain:${Buffer.from('new').toString('base64')}`)
    expect(await secrets.encrypt('c1', 'password', undefined)).toBeUndefined()
  })
})

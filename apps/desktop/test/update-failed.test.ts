import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => '/nonexistent', getVersion: () => '1.0.0', on: () => undefined },
  powerMonitor: { on: () => undefined },
}))
vi.mock('../src/main/mac-update', () => ({
  canSelfUpdateMac: () => true,
  installMacUpdateNow: vi.fn(),
  // The download starts (Check for Updates answers "downloading"), then its checksum is wrong.
  downloadMacUpdate: (_current: string, _newer: unknown, _log: unknown, started: (version: string) => void) => {
    started('9.9.9')
    return new Promise((_, reject) => setTimeout(() => reject(new Error('The download does not match its SHA-512')), 10))
  },
}))
vi.mock('../src/main/settings', () => ({ getSettings: () => ({}) }))
vi.mock('../src/main/managed', () => ({ managedConfig: () => undefined }))

const { checkNow } = await import('../src/main/updates')
const platform = process.platform
afterEach(() => Object.defineProperty(process, 'platform', { value: platform, configurable: true }))

describe('a macOS update that fails after "downloading" was answered', () => {
  it('tells the person why', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const failed = vi.fn()
    expect(await checkNow(() => {}, failed)).toEqual({ state: 'downloading', version: '9.9.9' })
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith({ version: '9.9.9', message: 'The download does not match its SHA-512' }))
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

const quitAndInstall = vi.fn()
const installMacUpdateNow = vi.fn()

vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => '/nonexistent', getVersion: () => '1.0.0', on: () => undefined },
  powerMonitor: { on: () => undefined },
}))
vi.mock('electron-updater', () => ({ autoUpdater: { quitAndInstall } }))
vi.mock('../src/main/mac-update', () => ({ canSelfUpdateMac: () => false, downloadMacUpdate: vi.fn(), installMacUpdateNow }))
vi.mock('../src/main/settings', () => ({ getSettings: () => ({}) }))
vi.mock('../src/main/managed', () => ({ managedConfig: () => undefined }))

const { installUpdate, setBeforeInstall } = await import('../src/main/updates')
const platform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  quitAndInstall.mockClear()
  installMacUpdateNow.mockClear()
})

describe('Restart now', () => {
  for (const os of ['win32', 'darwin'] as const) {
    it(`settles open transactions before the installer starts (${os})`, async () => {
      Object.defineProperty(process, 'platform', { value: os, configurable: true })
      const order: string[] = []
      quitAndInstall.mockImplementation(() => order.push('install'))
      installMacUpdateNow.mockImplementation(() => order.push('install'))
      setBeforeInstall(async () => (order.push('settle'), false))
      await installUpdate()
      expect(order).toEqual(['settle'])
      setBeforeInstall(async () => (order.push('settle'), true))
      await installUpdate()
      expect(order).toEqual(['settle', 'settle', 'install'])
    })
  }
})

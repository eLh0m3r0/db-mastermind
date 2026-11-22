import { afterEach, describe, expect, it, vi } from 'vitest'

const quitAndInstall = vi.fn()
const installMacUpdateNow = vi.fn()
const releaseSingleInstanceLock = vi.fn()

vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => '/nonexistent', getVersion: () => '1.0.0', on: () => undefined, releaseSingleInstanceLock },
  powerMonitor: { on: () => undefined },
}))
vi.mock('electron-updater', () => ({ autoUpdater: { quitAndInstall } }))
vi.mock('../src/main/mac-update', () => ({ canSelfUpdateMac: () => false, downloadMacUpdate: vi.fn(), installMacUpdateNow }))
vi.mock('../src/main/settings', () => ({ getSettings: () => ({}) }))
vi.mock('../src/main/managed', () => ({ managedConfig: () => undefined }))

const { installUpdate, setBeforeInstall, setInstallFailed } = await import('../src/main/updates')
const platform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  quitAndInstall.mockClear()
  installMacUpdateNow.mockClear()
})

describe('Restart now', () => {
  for (const os of ['win32', 'darwin', 'linux'] as const) {
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

  it('an AppImage lets go of the single-instance lock before the new one starts', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const order: string[] = []
    releaseSingleInstanceLock.mockImplementation(() => order.push('release'))
    quitAndInstall.mockImplementation(() => order.push('install'))
    setBeforeInstall(async () => true)
    await installUpdate()
    expect(order).toEqual(['release', 'install'])
  })

  for (const os of ['win32', 'darwin', 'linux'] as const) {
    it(`an installer that throws says so, so the agreed quit is off (${os})`, async () => {
      Object.defineProperty(process, 'platform', { value: os, configurable: true })
      const failed = vi.fn()
      setInstallFailed(failed)
      setBeforeInstall(async () => true)
      quitAndInstall.mockImplementation(() => {
        throw new Error('installer broke')
      })
      installMacUpdateNow.mockImplementation(() => {
        throw new Error('installer broke')
      })
      await expect(installUpdate()).rejects.toThrow('installer broke')
      expect(failed).toHaveBeenCalledTimes(1)
      quitAndInstall.mockReset()
      installMacUpdateNow.mockReset()
      failed.mockClear()
      await installUpdate()
      expect(failed).not.toHaveBeenCalled()
    })
  }
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => '/nonexistent', getVersion: () => '1.0.0', on: () => undefined },
  powerMonitor: { on: () => undefined },
}))
vi.mock('../src/main/settings', () => ({ getSettings: () => ({}) }))
vi.mock('../src/main/managed', () => ({ managedConfig: () => undefined }))

const { STORE_URL, canAutoUpdate, checkForUpdates, checkNow } = await import('../src/main/updates')

const fetchMock = vi.fn(async () => new Response(JSON.stringify({ tag_name: 'v9.0.0', html_url: 'https://github.com/x' })))

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockClear()
})
afterEach(() => {
  vi.unstubAllGlobals()
  Object.defineProperty(process, 'windowsStore', { value: undefined, configurable: true })
})

describe('Microsoft Store installs', () => {
  it('never announce a GitHub release and point Check for Updates to the Store', async () => {
    Object.defineProperty(process, 'windowsStore', { value: true, configurable: true })
    const notify = vi.fn()
    await checkForUpdates(notify)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(canAutoUpdate()).toBe(false)
    expect(await checkNow(() => {})).toEqual({ state: 'store', url: STORE_URL })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('other installs that cannot update themselves still learn about a new release', async () => {
    const notify = vi.fn()
    await checkForUpdates(notify)
    expect(notify).toHaveBeenCalledWith({ version: '9.0.0', url: 'https://github.com/x' })
  })
})

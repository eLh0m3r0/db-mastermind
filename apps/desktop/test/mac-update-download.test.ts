import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const data = mkdtempSync(join(tmpdir(), 'dbm-macdl-'))
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => data, on: () => undefined } }))

const { downloadMacUpdate } = await import('../src/main/mac-update')

afterAll(() => rmSync(data, { recursive: true, force: true }))

const newer = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true }) > 0
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
const yml = `version: 9.0.0\nfiles:\n  - url: DB-Mastermind-9.0.0-mac-${arch}.zip\n    sha512: AAAA\n    size: 3\n`

describe('downloadMacUpdate', () => {
  it('tells the version before the zip is downloaded, and a second check joins the same download', async () => {
    let failZip: (err: Error) => void = () => {}
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('latest-mac.yml')) return new Response(yml)
      // The zip never finishes until the test fails it.
      return new Response(new ReadableStream({ start: (c) => void (failZip = (err) => c.error(err)) }))
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const log = () => {}
      const found: string[] = []
      const first = downloadMacUpdate('1.0.0', newer, log, (v) => found.push(`first ${v}`))
      const second = downloadMacUpdate('1.0.0', newer, log, (v) => found.push(`second ${v}`))
      await vi.waitFor(() => expect(found).toEqual(['first 9.0.0', 'second 9.0.0']))
      expect(second).toBe(first)
      expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('.zip'))).toHaveLength(1)
      failZip(new Error('network down'))
      await expect(first).rejects.toThrow()
      // Finished (here: failed): the next check starts over.
      fetchMock.mockImplementation(async () => new Response('version: 1.0.0\n'))
      await expect(downloadMacUpdate('1.0.0', newer, log)).resolves.toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

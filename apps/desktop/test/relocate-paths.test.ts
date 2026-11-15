import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/nonexistent', on: () => undefined }, safeStorage: {} }))

const { relocatePaths } = await import('../src/main/connections')

describe('relocatePaths', () => {
  it('moves paths into the old data folder to the new one (a portable copy on another drive letter)', () => {
    const list = [
      { id: 'a', filePath: 'E:\\DBM\\data\\sample\\shop.sqlite', knowledgeBasePath: 'e:\\dbm\\data\\knowledge\\Shop-abc' },
      { id: 'b', filePath: 'C:\\Projects\\app.sqlite', knowledgeBasePath: 'C:\\Projects\\notes' },
    ]
    const { list: out, changed } = relocatePaths(list, 'E:\\DBM\\data', 'F:\\DBM\\data', true)
    expect(changed).toBe(true)
    expect(out[0]).toEqual({ id: 'a', filePath: 'F:\\DBM\\data\\sample\\shop.sqlite', knowledgeBasePath: 'F:\\DBM\\data\\knowledge\\Shop-abc' })
    expect(out[1]).toBe(list[1])
  })

  it('leaves everything alone when the folder did not move, or for a folder that only starts the same', () => {
    const list = [{ id: 'a', filePath: '/home/me/.config/DB Mastermind/sample/shop.sqlite' }, { id: 'b', filePath: '/home/me/.config/DB Mastermind-old/x.sqlite' }]
    expect(relocatePaths(list, '/home/me/.config/DB Mastermind', '/home/me/.config/DB Mastermind', false).changed).toBe(false)
    const moved = relocatePaths(list, '/home/me/.config/DB Mastermind', '/mnt/usb/data', false)
    expect(moved.list.map((c) => c.filePath)).toEqual(['/mnt/usb/data/sample/shop.sqlite', '/home/me/.config/DB Mastermind-old/x.sqlite'])
  })

  it('never moves a path that only spells the folder but leads out of it', () => {
    const list = [{ id: 'a', filePath: 'E:\\DBM\\data\\..\\private.sqlite' }, { id: 'b', filePath: '/data/../etc/x.sqlite' }]
    expect(relocatePaths([list[0]!], 'E:\\DBM\\data', 'F:\\DBM\\data', true).changed).toBe(false)
    expect(relocatePaths([list[1]!], '/data', '/mnt/data', false).changed).toBe(false)
  })
})

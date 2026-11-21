import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { NotAFileError, readCapped, readCappedSync } from '../src/index.js'

const dir = mkdtempSync(join(tmpdir(), 'dbm-capped-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe.skipIf(process.platform === 'win32')('reading a stranger\'s file (review M2)', () => {
  const o = { limit: 1024, what: 'a model' }
  it('reads a plain file up to the limit and refuses one byte more', async () => {
    writeFileSync(join(dir, 'ok'), 'x'.repeat(1024))
    writeFileSync(join(dir, 'big'), 'x'.repeat(1025))
    expect(readCappedSync(join(dir, 'ok'), o).length).toBe(1024)
    expect((await readCapped(join(dir, 'ok'), o)).length).toBe(1024)
    expect(() => readCappedSync(join(dir, 'big'), o)).toThrow(/larger than/)
    await expect(readCapped(join(dir, 'big'), o)).rejects.toThrow(/larger than/)
  })

  it('refuses a FIFO and a device without waiting, and a link when told not to follow', async () => {
    execFileSync('mkfifo', [join(dir, 'fifo')])
    symlinkSync('/dev/zero', join(dir, 'zero'))
    writeFileSync(join(dir, 'target'), 'x')
    symlinkSync(join(dir, 'target'), join(dir, 'link'))
    expect(() => readCappedSync(join(dir, 'fifo'), o)).toThrow(NotAFileError)
    await expect(readCapped(join(dir, 'fifo'), o)).rejects.toThrow(NotAFileError)
    expect(() => readCappedSync(join(dir, 'zero'), o)).toThrow(NotAFileError)
    await expect(readCapped(join(dir, 'zero'), o)).rejects.toThrow(NotAFileError)
    expect(readCappedSync(join(dir, 'link'), o).toString()).toBe('x')
    expect(() => readCappedSync(join(dir, 'link'), { ...o, follow: false })).toThrow(NotAFileError)
  })
})

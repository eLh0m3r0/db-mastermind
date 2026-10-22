import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/nonexistent', on: () => undefined } }))

const { SWAP_SCRIPT } = await import('../src/main/mac-update')

// ditto exists only on macOS; cp -R does the same for these plain folders.
const script = process.platform === 'darwin' ? SWAP_SCRIPT : SWAP_SCRIPT.replaceAll('/usr/bin/ditto', 'cp -R')
const dirs: string[] = []

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dbm-swap-'))
  dirs.push(dir)
  const app = join(dir, 'Applications', 'DB Mastermind.app')
  mkdirSync(app, { recursive: true })
  writeFileSync(join(app, 'version'), 'old')
  const download = join(dir, 'download')
  const update = join(download, 'app', 'DB Mastermind.app')
  mkdirSync(update, { recursive: true })
  writeFileSync(join(update, 'version'), 'new')
  return { dir, app, download, update }
}

// A pid above any real one: the "wait for the app to exit" loop ends at once.
const swap = (app: string, update: string, download: string) => execFileSync('/bin/sh', ['-c', script, 'dbm-update', '99999999', app, update, download, '0'])
const leftovers = (app: string) => [`${app}.old`, `${app}.new`].filter((p) => existsSync(p))

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    if (process.platform === 'darwin') execFileSync('chflags', ['-R', 'nouchg', dir])
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('macOS update swap', () => {
  it('replaces the app and cleans up', () => {
    const { app, download, update } = setup()
    swap(app, update, download)
    expect(readFileSync(join(app, 'version'), 'utf8')).toBe('new')
    expect(leftovers(app)).toEqual([])
    expect(existsSync(download)).toBe(false)
  })

  it('keeps the installed app when copying the update fails', () => {
    const { app, download } = setup()
    swap(app, join(download, 'missing.app'), download)
    expect(readFileSync(join(app, 'version'), 'utf8')).toBe('old')
    expect(leftovers(app)).toEqual([])
  })

  it.skipIf(process.platform !== 'darwin')('keeps the installed app when it cannot be moved aside', () => {
    const { app, download, update } = setup()
    execFileSync('chflags', ['uchg', app])
    swap(app, update, download)
    expect(readFileSync(join(app, 'version'), 'utf8')).toBe('old')
    expect(leftovers(app)).toEqual([])
  })

  it('puts back the app an interrupted swap left aside, then updates it', () => {
    const { app, download, update } = setup()
    execFileSync('mv', [app, `${app}.old`])
    swap(app, update, download)
    expect(readFileSync(join(app, 'version'), 'utf8')).toBe('new')
    expect(leftovers(app)).toEqual([])
  })
})

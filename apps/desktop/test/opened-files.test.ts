import { mkdtempSync as makeTemp, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { deliverOpenedFilesTo, filesFromArgs, openFileInApp, takeOpenedFiles } from '../src/main/opened-files'

// Folders made here go when the file's tests are done.
const made: string[] = []
const mkdtempSync = (prefix: string) => {
  const dir = makeTemp(prefix)
  made.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

describe('files handed to the app', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dbm-open-'))
  const model = join(dir, 'shop.dez')
  writeFileSync(model, '')
  writeFileSync(join(dir, 'notes.txt'), '')

  it('finds existing model and data files among command-line arguments', () => {
    expect(filesFromArgs(['apps/desktop', '--inspect=5858', model, join(dir, 'missing.dbml'), join(dir, 'notes.txt')])).toEqual([model])
    expect(filesFromArgs(['shop.dez'], dir)).toEqual([model])
  })

  it('keeps files for the window until it listens, then hands new ones over directly', () => {
    openFileInApp(model)
    openFileInApp(join(dir, 'notes.txt'))
    expect(takeOpenedFiles()).toEqual([model])
    expect(takeOpenedFiles()).toEqual([])
    const got: string[] = []
    deliverOpenedFilesTo((path) => got.push(path))
    openFileInApp(model)
    expect(got).toEqual([model])
    expect(takeOpenedFiles()).toEqual([])
    deliverOpenedFilesTo(undefined)
  })
})

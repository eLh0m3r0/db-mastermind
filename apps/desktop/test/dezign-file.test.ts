import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const data = mkdtempSync(join(tmpdir(), 'dbm-dezfile-data-'))
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => data, getLocale: () => 'en', on: () => undefined } }))

const { exportDezignModel, openDezignModel, saveDezignModel } = await import('../src/main/dezign-file')

const work = mkdtempSync(join(tmpdir(), 'dbm-dezfile-'))
afterAll(() => {
  for (const dir of [data, work]) rmSync(dir, { recursive: true, force: true })
})

const MODEL = 'Table shop.customer {\n  id bigint [pk]\n  name varchar(100)\n}\n\nTable shop.invoice {\n  id bigint [pk]\n  customer_id bigint [ref: > shop.customer.id]\n}\n'
const files = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {}
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(p)
      else out[p] = readFileSync(join(dir, p), 'latin1')
    }
  }
  walk('')
  return out
}

describe('saving into a DeZign project', () => {
  it('leaves a folder project as it was when a file cannot be written, and says so', async () => {
    const project = await exportDezignModel(join(work, 'team.dezproj'), MODEL)
    const folder = join(work, 'team')
    const opened = await openDezignModel(project)
    const before = files(folder)
    // The edit touches the customer's file; its folder refuses new files.
    const entities = join(folder, 'data dictionary', 'entities')
    chmodSync(entities, 0o555)
    try {
      const text = opened.text.replace('name varchar(100)', 'name varchar(100)\n  email varchar(200)')
      await expect(saveDezignModel({ path: project, text, hash: opened.imported!.hash })).rejects.toThrow(/left as it was/)
    } finally {
      chmodSync(entities, 0o755)
    }
    expect(files(folder)).toEqual(before)
  })

  it('keeps every backup in a folder of its own, also two saves in the same second', async () => {
    const path = await exportDezignModel(join(work, 'shop.dez'), MODEL)
    let opened = await openDezignModel(path)
    const first = await saveDezignModel({ path, text: opened.text.replace('name varchar(100)', 'name varchar(120)'), hash: opened.imported!.hash })
    opened = await openDezignModel(path)
    const second = await saveDezignModel({ path, text: opened.text.replace('name varchar(120)', 'name varchar(140)'), hash: opened.imported!.hash })
    expect(first.backup).toBeTruthy()
    expect(second.backup).not.toBe(first.backup)
    expect(existsSync(join(first.backup!, 'shop.dez')) && existsSync(join(second.backup!, 'shop.dez'))).toBe(true)
    expect(readFileSync(join(first.backup!, 'shop.dez'), 'latin1')).not.toBe(readFileSync(join(second.backup!, 'shop.dez'), 'latin1'))
  })

  it('refuses to save over a change made on disk to more than the tables (a note, a diagram)', async () => {
    const path = await exportDezignModel(join(work, 'notes.dez'), MODEL)
    const opened = await openDezignModel(path)
    // Somebody renames the diagram in DeZign meanwhile; the tables stay the same.
    const text = readFileSync(path, 'latin1')
    const renamed = text.replace(/(<DIAGRAM>[\s\S]*?<NAME>)([^<]*)(<\/NAME>)/, '$1Renamed elsewhere$3')
    expect(renamed).not.toBe(text)
    writeFileSync(path, renamed, 'latin1')
    await expect(saveDezignModel({ path, text: opened.text.replace('name varchar(100)', 'name varchar(120)'), hash: opened.imported!.hash })).rejects.toThrow(/changed on disk/)
    expect(readFileSync(path, 'latin1')).toBe(renamed)
  })
})

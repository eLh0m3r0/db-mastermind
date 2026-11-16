import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const data = mkdtempSync(join(tmpdir(), 'dbm-dezfile-data-'))
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => data, getLocale: () => 'en', on: () => undefined } }))
// A file DeZign or a virus scanner holds open: moving the new file over it fails (Windows: EBUSY).
const renames = vi.hoisted(() => ({ failAt: -1, count: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (renames.failAt >= 0 && renames.count++ === renames.failAt) throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${to}'`), { code: 'EBUSY' })
      return actual.rename(from, to)
    },
  }
})

const { archiveModelVersion, exportDezignModel, openDezignModel, saveDezignModel } = await import('../src/main/dezign-file')

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

  it('puts back the files it already moved when a later one cannot be moved, and backs up the subfolders (review finding)', async () => {
    const project = await exportDezignModel(join(work, 'locked.dezproj'), MODEL)
    const folder = join(work, 'locked')
    const opened = await openDezignModel(project)
    const before = files(folder)
    // Both tables change: two files in data dictionary/entities. The second one's move fails.
    const text = opened.text.replace('name varchar(100)', 'name varchar(100)\n  email varchar(200)').replace('customer_id bigint\n}', 'customer_id bigint\n  total numeric(10,2)\n}')
    Object.assign(renames, { failAt: 1, count: 0 })
    try {
      await expect(saveDezignModel({ path: project, text, hash: opened.imported!.hash })).rejects.toThrow(/left as it was/)
    } finally {
      renames.failAt = -1
    }
    expect(files(folder)).toEqual(before)
    // A save that goes through keeps a copy of every file it replaced, also those in subfolders.
    const saved = await saveDezignModel({ path: project, text, hash: opened.imported!.hash })
    const changed = Object.keys(before).filter((rel) => before[rel] !== files(folder)[rel])
    expect(changed.some((rel) => rel.startsWith('data dictionary/'))).toBe(true)
    for (const rel of changed) expect(readFileSync(join(saved.backup!, rel), 'latin1')).toBe(before[rel])
  })

  it('reads the labels of a folder project and archives a version with all of its parts (review findings)', async () => {
    const project = await exportDezignModel(join(work, 'labelled.dezproj'), MODEL)
    const folder = join(work, 'labelled')
    mkdirSync(join(folder, 'labels'))
    writeFileSync(join(folder, 'labels', 'L1.xml'), '<?xml version="1.0" encoding="iso-8859-1"?>\n<LABEL>\n<NAME>PII</NAME>\n<ID>L1</ID>\n<POSNR>0</POSNR>\n<ISTREELABEL>1</ISTREELABEL>\n<PARENTLABELID></PARENTLABELID>\n</LABEL>\n', 'latin1')
    const opened = await openDezignModel(project)
    expect(opened.imported!.labels!.map((l) => l.name)).toEqual(['PII'])
    // The table takes the label: saved into its file.
    const text = opened.text.replace('name varchar(100)\n}', 'name varchar(100)\n\n  Labels: \'["PII"]\'\n}')
    const saved = await saveDezignModel({ path: project, text, hash: opened.imported!.hash })
    expect(saved.written).toBeGreaterThan(0)
    expect((await openDezignModel(project)).text).toContain('PII')
    await archiveModelVersion(project, { label: 'v1', hash: saved.hash })
    const archived = readdirSync(join(folder, 'archived versions')).map((name) => readFileSync(join(folder, 'archived versions', name), 'latin1'))
    expect(archived).toHaveLength(1)
    expect(archived[0]).toMatch(/<LABELS>\s*<LABEL>\s*<NAME>PII<\/NAME>/)
    const ddp = readdirSync(folder).find((name) => name.toLowerCase().endsWith('.ddp'))
    if (ddp) expect(archived[0]).toContain('<DisplayPreferences')
  })

  it('an empty list of triggers, procedures and sequences removes the last one (review finding)', async () => {
    const path = await exportDezignModel(join(work, 'sequences.dez'), MODEL)
    let opened = await openDezignModel(path)
    const sequence = { kind: 'sequence' as const, name: 'invoice_no', schema: 'shop', sql: '', sequence: { start: '1' } }
    const added = await saveDezignModel({ path, text: opened.text, hash: opened.imported!.hash, sqlObjects: [sequence] })
    expect(added.written).toBe(1)
    opened = await openDezignModel(path)
    expect(opened.imported!.sqlObjects!.filter((o) => o.kind === 'sequence').map((o) => o.name)).toEqual(['invoice_no'])
    const removed = await saveDezignModel({ path, text: opened.text, hash: opened.imported!.hash, sqlObjects: [] })
    expect(removed.changes.map((c) => c.kind)).toEqual(['drop_sequence'])
    expect((await openDezignModel(path)).imported!.sqlObjects!.filter((o) => o.kind === 'sequence')).toEqual([])
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

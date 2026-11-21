import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { growth, LINEAR } from './growth.js'
import { FILE_LIMITS, mwbDocument, parseDbml, parseDotenv, readModelFile, servicesFromCompose, projectConnections, tablesFromMermaid, tablesFromPrisma } from '../src/index.js'

/**
 * Files from strangers (docs/specs/launch.md, wave 3): a model somebody mailed, a repository cloned from the
 * internet. Each reader is limited in size, nesting and time, and cleans what it hands on.
 */
const timed = <T,>(f: () => T): { value?: T; error?: Error; ms: number } => {
  const start = performance.now()
  try {
    return { value: f(), ms: performance.now() - start }
  } catch (error) {
    return { error: error as Error, ms: performance.now() - start }
  }
}
const long = (n: number, s: string) => s.repeat(Math.ceil(n / s.length)).slice(0, n)

describe('size limits', () => {
  it('refuses a model file over its limit before reading it, and says the limit', () => {
    const big = new Uint8Array(FILE_LIMITS.model + 1)
    expect(() => readModelFile('huge.mmd', big)).toThrow(/huge\.mmd is larger than 32 MB/)
    expect(() => readModelFile('huge.mwb', new Uint8Array(FILE_LIMITS.mwb + 1))).toThrow(/larger than 64 MB/)
  })

  // Cheap by construction (CI runners are several times slower than a Mac): a document of 2 MB that compresses
  // about tenfold against a limit of 256 KB, so a lying header is caught a few 16 KB slices in; what is asserted is
  // the bytes inflated, never the time.
  it('inflates nothing but document.mwb.xml, and stops a zip bomb at the limit even when its header lies', { timeout: 30_000 }, () => {
    const text = Array.from({ length: 70_000 }, (_, i) => `<value key="k${i % 997}">${(i * 7919) % 100_003}</value>\n`).join('')
    const document = strToU8(text)
    const honest = zipSync({ 'document.mwb.xml': document, 'other.bin': new Uint8Array(1024) }, { level: 9 })
    const limit = 256 * 1024
    expect(document.length).toBeGreaterThan(8 * limit)
    const a = { inflated: 0 }
    expect(() => mwbDocument(honest, limit, a)).toThrow(/document is larger than 0\.3 MB|document is larger than/)
    // A header that claims 100 bytes: inflating is still counted, and stopped.
    const lying = honest.slice()
    const view = new DataView(lying.buffer)
    for (let i = 0; i < lying.length - 4; i++) {
      const sig = view.getUint32(i, true)
      if (sig === 0x04034b50) view.setUint32(i + 22, 100, true)
      if (sig === 0x02014b50) view.setUint32(i + 24, 100, true)
    }
    const b = { inflated: 0 }
    expect(() => mwbDocument(lying, limit, b)).toThrow(/document is larger than/)
    // An honest header is refused before anything is inflated; a lying one stops at the limit and a slice more
    // (16 KB deflated inflates to 16 KB × the ratio), long before the end of the document.
    const slice = 16 * 1024 * (document.length / honest.length)
    expect(a.inflated).toBe(0)
    expect(b.inflated).toBeGreaterThan(limit)
    expect(b.inflated).toBeLessThanOrEqual(limit + 2 * slice)
    expect(b.inflated).toBeLessThan(document.length / 2)
  })

  it('reads a Workbench document nested deeper than any model as no model, without running out of stack', { timeout: 30_000 }, () => {
    const depth = 100_000
    const xml = `<?xml version="1.0"?><data><value type="object" struct-name="workbench.Document" id="d">${'<value type="list" key="x">'.repeat(depth)}${'</value>'.repeat(depth)}</value></data>`
    const r = timed(() => readModelFile('deep.mwb', zipSync({ 'document.mwb.xml': strToU8(xml) })))
    expect(r.error?.message).toMatch(/nested too deeply/)
  })
})

describe('nesting, aliases and long lines', () => {
  it('a drawDB file of 100,000 nested arrays or with fields that are not fields is refused or read', { timeout: 30_000 }, () => {
    const deep = `{"tables":[{"name":"t","fields":${'['.repeat(100_000)}${']'.repeat(100_000)}}],"relationships":[]}`
    const r = timed(() => readModelFile('deep.json', strToU8(deep)))
    // (Fields that aren't objects with a name and a type are left out; the table stays.)
    expect(r.error ?? r.value?.tables.length).toBe(1)
    const odd = JSON.stringify({ tables: [{ id: 1, name: 't', x: 'a', y: null, fields: [{ id: 1, name: 'ok', type: 'INT' }, { id: 2, name: { $gt: 1 }, type: 7 }, null, 5], indices: 'x' }], relationships: [{ startTableId: 1 }, null] })
    const m = readModelFile('odd.json', strToU8(odd))
    expect(m.tables[0]!.columns.map((c) => c.name)).toEqual(['ok'])
    expect(m.positions).toEqual({})
  })

  // (Spelled out, the aliases would never end: finishing at all is the check; the timeout is only a backstop.)
  it('a compose file of aliases that would spell out billions of entries, or nested 100,000 deep, is read', { timeout: 30_000 }, () => {
    const laughs = ['a: &a ["x","x","x","x","x","x","x","x","x","x"]', ...Array.from({ length: 8 }, (_, i) => `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [${Array(10).fill(`*${String.fromCharCode(97 + i)}`).join(',')}]`)].join('\n')
    const bomb = `${laughs}\nservices:\n  db:\n    image: postgres:16\n    environment: *i\n    ports: [*i, "5432:5432"]\n  other:\n    <<: *i\n`
    const r = timed(() => servicesFromCompose(bomb, {}, 'p'))
    expect(r.error).toBeUndefined()
    expect(r.value!.map((s) => [s.service, s.published])).toEqual([['db', 5432]])
    const deep = timed(() => servicesFromCompose(`services: ${'['.repeat(100_000)}${']'.repeat(100_000)}`, {}, 'p'))
    expect(deep.error?.message ?? '').toMatch(/^$|Not a readable compose file/)
  })

  // Linear, measured as growth from 25,000 to 100,000 characters (or lines): the time itself differs by machine.
  it('adversarial lines grow linearly, not quadratically', { timeout: 60_000 }, () => {
    const lines: [string, (n: number) => () => unknown][] = [
      ['Mermaid relationship-like', (n) => {
        const input = `erDiagram\n  A ||--o{ ${long(n, 'B ')}`
        return () => tablesFromMermaid(input)
      }],
      ['Mermaid worded', (n) => {
        const input = `erDiagram\n  A ${long(n, 'one or more to ')} B`
        return () => tablesFromMermaid(input)
      }],
      ['Mermaid attribute', (n) => {
        const input = `erDiagram\n  A {\n    ${long(n, 'a ')}\n  }`
        return () => tablesFromMermaid(input)
      }],
      ['Mermaid attribute with keys', (n) => {
        const input = `erDiagram\n  A {\n    int x ${long(n, 'PK, ')}"\n  }`
        return () => tablesFromMermaid(input)
      }],
      ['DBML column', (n) => {
        const input = `Table t {\n  ${long(n, 'a ')}[\n}`
        return () => parseDbml(input)
      }],
      ['DBML one-line block', (n) => {
        const input = `Table t {\n  id int\n  indexes { ${long(n, '(a, ')} }\n}`
        return () => parseDbml(input)
      }],
      ['DBML unclosed settings', (n) => {
        const input = `Table t {\n  id int [${'\n  x'.repeat(n / 2)}\n}`
        return () => parseDbml(input)
      }],
      ['DBML Ref', (n) => {
        const input = `Ref: ${long(n, 'a.')} > b.c`
        return () => parseDbml(input)
      }],
      ['.env value', (n) => {
        const input = `A=${long(n, '${B:-${C')}`
        return () => parseDotenv(input)
      }],
      ['.env unclosed quote', (n) => {
        const input = `A="x${'\nB=y'.repeat(n / 2)}`
        return () => parseDotenv(input)
      }],
      ['.env many variables', (n) => {
        const input = Array.from({ length: n / 2 }, (_, i) => `V${i}=\${V${i - 1}:-x}`).join('\n')
        return () => parseDotenv(input)
      }],
      ['Prisma unclosed models', (n) => {
        const input = Array.from({ length: n / 5 }, (_, i) => `model m${i} {\n  id Int @id`).join('\n')
        return () => tablesFromPrisma(input)
      }],
      ['Prisma attribute', (n) => {
        const input = `model m {\n  id Int ${long(n, '@default(')}\n}`
        return () => tablesFromPrisma(input)
      }],
    ]
    const report: string[] = []
    for (const [label, run] of lines) {
      const g = growth(run, 25_000)
      report.push(`${label} ×${g.ratio.toFixed(1)} (${g.small.toFixed(1)} → ${g.large.toFixed(1)} ms)`)
      expect(g.ratio, label).toBeLessThan(LINEAR)
    }
    console.log(report.join(' · '))
  })

  it('a 30 MB single line is no model and is said to be none', { timeout: 30_000 }, () => {
    const line = long(30 * 1024 * 1024, 'x')
    const r = timed(() => readModelFile('one.mmd', strToU8(line)))
    expect(r.error?.message).toMatch(/erDiagram|longer than 64 KB/)
  })
})

describe('what a file names is cleaned', () => {
  it('table, column and note names lose control characters and are bounded', () => {
    const m = readModelFile('x.mmd', strToU8(`erDiagram\n  "Evil\u0007\u202eTable" {\n    int ${long(500, 'n')} PK "a\u0000comment"\n  }\n`))
    expect(m.tables[0]!.name).toBe('EvilTable')
    expect(m.tables[0]!.columns[0]!.name).toHaveLength(128)
    expect(m.tables[0]!.columns[0]!.comment).toBe('acomment')
    const d = readModelFile('d.json', strToU8(JSON.stringify({ tables: [{ id: 1, name: 'a\nTable b {', x: 1e300, y: -1e300, fields: [{ id: 1, name: 'id', type: 'INT' }] }], relationships: [], notes: [{ id: 1, x: 0, y: 0, title: 'T\u001b[31m', content: 'line one\nline two\u0008' }] })))
    expect(d.tables[0]!.name).toBe('aTable b {')
    expect(d.positions['.aTable b {']).toEqual({ x: 1e7, y: -1e7 })
    expect(d.notes[0]!.text).toBe('T[31m\nline one\nline two')
  })

  it("connections from a project: names and settings on one line and bounded, the password as written", () => {
    const found = projectConnections({ '.env': `DATABASE_URL=postgres://u:p%0Aw@${long(300, 'h')}:5432/db\n` }, `pro\u0000ject\u001b${long(200, 'x')}`)
    expect(found).toHaveLength(1)
    expect(found[0]!.name).toHaveLength(100)
    expect(found[0]!.name).not.toMatch(/[\u0000-\u001f]/)
    expect(found[0]!.host).toHaveLength(255)
    expect(found[0]!.password).toBe('p\nw')
  })
})

describe('names cleaning makes alike', () => {
  it('get a number, references follow them, and the notice counts them', () => {
    const long = 'x'.repeat(200)
    const draw = {
      tables: [
        { id: 1, name: 'ab', x: 0, y: 0, fields: [{ id: 1, name: 'id', type: 'INT', primary: true }, { id: 2, name: 'v\u0007al', type: 'INT' }, { id: 3, name: 'val', type: 'INT' }] },
        { id: 2, name: 'a\u0007b', x: 10, y: 0, fields: [{ id: 4, name: 'id', type: 'INT', primary: true }, { id: 5, name: `${long}1`, type: 'INT' }, { id: 6, name: `${long}2`, type: 'INT' }] },
      ],
      relationships: [{ id: 1, startTableId: 2, startFieldId: 6, endTableId: 1, endFieldId: 3 }],
    }
    const m = readModelFile('m.json', strToU8(JSON.stringify(draw)))
    expect(m.tables.map((t) => t.name)).toEqual(['ab', 'ab_2'])
    expect(m.tables[0]!.columns.map((c) => c.name)).toEqual(['id', 'val', 'val_2'])
    expect(m.tables[1]!.columns.map((c) => c.name)).toEqual(['id', 'x'.repeat(128), `${'x'.repeat(126)}_2`])
    expect(m.tables[1]!.foreignKeys.map((f) => [f.columns, f.refTable, f.refColumns])).toEqual([[[`${'x'.repeat(126)}_2`], 'ab', ['val_2']]])
    expect(Object.keys(m.positions).sort()).toEqual(['.ab', '.ab_2'])
    expect(m.leftOut.renamed).toBe(3)
  })
})

import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
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

  it('inflates nothing but document.mwb.xml, and stops a zip bomb at the limit even when its header lies', () => {
    // 256 MB of zeros, which deflate to about 256 KB; the limit here is 8 MB.
    const zeros = new Uint8Array(256 * 1024 * 1024)
    const honest = zipSync({ 'document.mwb.xml': zeros, 'other.bin': new Uint8Array(1024) }, { level: 9 })
    expect(honest.length).toBeLessThan(1024 * 1024)
    const limit = 8 * 1024 * 1024
    const before = process.memoryUsage().arrayBuffers
    const a = timed(() => mwbDocument(honest, limit))
    expect(a.error?.message).toMatch(/document is larger than 8 MB/)
    // A header that claims 100 bytes: inflating is still counted, and stopped.
    const lying = honest.slice()
    const view = new DataView(lying.buffer)
    for (let i = 0; i < lying.length - 4; i++) {
      const sig = view.getUint32(i, true)
      if (sig === 0x04034b50) view.setUint32(i + 22, 100, true)
      if (sig === 0x02014b50) view.setUint32(i + 24, 100, true)
    }
    const b = timed(() => mwbDocument(lying, limit))
    expect(b.error?.message).toMatch(/document is larger than 8 MB/)
    expect(a.ms + b.ms).toBeLessThan(2000)
    // Far less than the 256 MB the bomb holds was ever allocated: the limit and a slice or two (a slice of 16 KB
    // deflated inflates to about 16 MB).
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(128 * 1024 * 1024)
  })

  it('reads a Workbench document nested deeper than any model as no model, without running out of stack', () => {
    const depth = 100_000
    const xml = `<?xml version="1.0"?><data><value type="object" struct-name="workbench.Document" id="d">${'<value type="list" key="x">'.repeat(depth)}${'</value>'.repeat(depth)}</value></data>`
    const r = timed(() => readModelFile('deep.mwb', zipSync({ 'document.mwb.xml': strToU8(xml) })))
    expect(r.error?.message).toMatch(/nested too deeply/)
    expect(r.ms).toBeLessThan(3000)
  })
})

describe('nesting, aliases and long lines', () => {
  it('a drawDB file of 100,000 nested arrays or with fields that are not fields is refused or read, quickly', () => {
    const deep = `{"tables":[{"name":"t","fields":${'['.repeat(100_000)}${']'.repeat(100_000)}}],"relationships":[]}`
    const r = timed(() => readModelFile('deep.json', strToU8(deep)))
    expect(r.ms).toBeLessThan(2000)
    // (Fields that aren't objects with a name and a type are left out; the table stays.)
    expect(r.error ?? r.value?.tables.length).toBe(1)
    const odd = JSON.stringify({ tables: [{ id: 1, name: 't', x: 'a', y: null, fields: [{ id: 1, name: 'ok', type: 'INT' }, { id: 2, name: { $gt: 1 }, type: 7 }, null, 5], indices: 'x' }], relationships: [{ startTableId: 1 }, null] })
    const m = readModelFile('odd.json', strToU8(odd))
    expect(m.tables[0]!.columns.map((c) => c.name)).toEqual(['ok'])
    expect(m.positions).toEqual({})
  })

  it('a compose file of aliases that would spell out billions of entries, or nested 100,000 deep, is read quickly', () => {
    const laughs = ['a: &a ["x","x","x","x","x","x","x","x","x","x"]', ...Array.from({ length: 8 }, (_, i) => `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [${Array(10).fill(`*${String.fromCharCode(97 + i)}`).join(',')}]`)].join('\n')
    const bomb = `${laughs}\nservices:\n  db:\n    image: postgres:16\n    environment: *i\n    ports: [*i, "5432:5432"]\n  other:\n    <<: *i\n`
    const r = timed(() => servicesFromCompose(bomb, {}, 'p'))
    expect(r.error).toBeUndefined()
    expect(r.value!.map((s) => [s.service, s.published])).toEqual([['db', 5432]])
    expect(r.ms).toBeLessThan(1000)
    const deep = timed(() => servicesFromCompose(`services: ${'['.repeat(100_000)}${']'.repeat(100_000)}`, {}, 'p'))
    expect(deep.ms).toBeLessThan(2000)
    expect(deep.error?.message ?? '').toMatch(/^$|Not a readable compose file/)
  })

  it('adversarial lines of 100,000 characters take a moment, not minutes', () => {
    const lines: [string, () => unknown][] = [
      ['Mermaid relationship-like', () => tablesFromMermaid(`erDiagram\n  A ||--o{ ${long(100_000, 'B ')}`)],
      ['Mermaid worded', () => tablesFromMermaid(`erDiagram\n  A ${long(100_000, 'one or more to ')} B`)],
      ['Mermaid attribute', () => tablesFromMermaid(`erDiagram\n  A {\n    ${long(100_000, 'a ')}\n  }`)],
      ['Mermaid attribute with keys', () => tablesFromMermaid(`erDiagram\n  A {\n    int x ${long(100_000, 'PK, ')}"\n  }`)],
      ['DBML column', () => parseDbml(`Table t {\n  ${long(100_000, 'a ')}[\n}`)],
      ['DBML one-line block', () => parseDbml(`Table t {\n  id int\n  indexes { ${long(100_000, '(a, ')} }\n}`)],
      ['DBML unclosed settings', () => parseDbml(`Table t {\n  id int [${'\n  x'.repeat(50_000)}\n}`)],
      ['DBML Ref', () => parseDbml(`Ref: ${long(100_000, 'a.')} > b.c`)],
      ['.env value', () => parseDotenv(`A=${long(100_000, '${B:-${C')}`)],
      ['.env unclosed quote over 50,000 lines', () => parseDotenv(`A="x${'\nB=y'.repeat(50_000)}`)],
      ['.env many variables', () => parseDotenv(Array.from({ length: 50_000 }, (_, i) => `V${i}=\${V${i - 1}:-x}`).join('\n'))],
      ['Prisma unclosed models', () => tablesFromPrisma(Array.from({ length: 20_000 }, (_, i) => `model m${i} {\n  id Int @id`).join('\n'))],
      ['Prisma attribute', () => tablesFromPrisma(`model m {\n  id Int ${long(100_000, '@default(')}\n}`)],
    ]
    const times: string[] = []
    for (const [label, run] of lines) {
      const r = timed(run)
      times.push(`${label} ${Math.round(r.ms)} ms`)
      expect(r.ms, label).toBeLessThan(1500)
    }
    console.log(times.join(' · '))
  })

  it('a 30 MB single line is no model and is said to be none, quickly', () => {
    const line = long(30 * 1024 * 1024, 'x')
    const r = timed(() => readModelFile('one.mmd', strToU8(line)))
    expect(r.error?.message).toMatch(/erDiagram/)
    expect(r.ms).toBeLessThan(3000)
  })
})

describe('what a file names is cleaned', () => {
  it('table, column and note names lose control characters and are bounded', () => {
    const m = readModelFile('x.mmd', strToU8(`erDiagram\n  "Evil\u0007‮Table" {\n    int ${long(500, 'n')} PK "a\u0000comment"\n  }\n`))
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

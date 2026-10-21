import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { ForeignKeyInfo } from './types.js'

/**
 * A knowledge base is a folder of Markdown files describing a database: business meaning of tables,
 * relationships the schema doesn't declare, gotchas, example queries. Files may start with front matter:
 *
 * ---
 * tables: [orders, order_items]
 * relations:
 *   - orders.customer_ref -> customers.code
 * ---
 */

export interface KnowledgeFile {
  path: string
  title: string
  size: number
  modifiedAt: string
  tables: string[]
}

export interface KnowledgeDoc extends KnowledgeFile {
  content: string
  body: string
  relations: VirtualRelation[]
}

export interface VirtualRelation {
  fromTable: string
  fromColumns: string[]
  toTable: string
  toColumns: string[]
  source: string
}

const MAX_FILE_BYTES = 512 * 1024
const MAX_FILES = 2000

export class KnowledgeError extends Error {
  override name = 'KnowledgeError'
}

/** Resolves a path inside the knowledge base, refusing anything that escapes it. */
export function resolveInside(root: string, path: string): string {
  const base = resolve(root)
  const target = resolve(base, path)
  if (target !== base && !target.startsWith(base + sep)) throw new KnowledgeError('Path is outside the knowledge base')
  return target
}

export function parseFrontMatter(content: string): { data: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  if (!m) return { data: {}, body: content }
  const data: Record<string, unknown> = {}
  let currentKey: string | null = null
  for (const rawLine of m[1]!.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '')
    if (!line.trim()) continue
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && currentKey) {
      const list = (data[currentKey] as unknown[] | undefined) ?? []
      list.push(unquote(item[1]!))
      data[currentKey] = list
      continue
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    currentKey = kv[1]!
    const value = kv[2]!.trim()
    if (value === '') data[currentKey] = []
    else if (value.startsWith('[') && value.endsWith(']'))
      data[currentKey] = value
        .slice(1, -1)
        .split(',')
        .map((v) => unquote(v.trim()))
        .filter(Boolean)
    else data[currentKey] = unquote(value)
  }
  return { data, body: content.slice(m[0].length) }
}

function unquote(v: string): string {
  return v.replace(/^(['"])(.*)\1$/, '$2')
}

function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'string' && v) return [v]
  return []
}

/** `orders.customer_id -> customers.id` or `orders(a, b) -> customers(x, y)`. */
export function parseRelation(text: string, source: string): VirtualRelation | null {
  const m = /^\s*([\w.]+?)(?:\.(\w+)|\(([^)]*)\))\s*(?:->|→|=>)\s*([\w.]+?)(?:\.(\w+)|\(([^)]*)\))\s*$/.exec(text)
  if (!m) return null
  const cols = (single?: string, list?: string) => (single ? [single] : (list ?? '').split(',').map((c) => c.trim()).filter(Boolean))
  return { fromTable: m[1]!, fromColumns: cols(m[2], m[3]), toTable: m[4]!, toColumns: cols(m[5], m[6]), source }
}

function titleOf(path: string, body: string, data: Record<string, unknown>): string {
  if (typeof data.title === 'string') return data.title
  const h = /^#\s+(.+)$/m.exec(body)
  return h ? h[1]!.trim() : path.replace(/\.md$/i, '').split('/').pop()!
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const full = join(dir, e.name)
    if (e.isDirectory()) await walk(root, full, out)
    else if (/\.(md|markdown|mdx)$/i.test(e.name)) out.push(full)
  }
}

export class KnowledgeBase {
  constructor(readonly root: string) {}

  async list(): Promise<KnowledgeFile[]> {
    const files: string[] = []
    await walk(this.root, this.root, files)
    const out: KnowledgeFile[] = []
    for (const full of files) {
      const info = await stat(full)
      const rel = relative(this.root, full).split(sep).join('/')
      const head = info.size > MAX_FILE_BYTES ? '' : await readFile(full, 'utf8')
      const { data, body } = parseFrontMatter(head)
      out.push({ path: rel, title: titleOf(rel, body, data), size: info.size, modifiedAt: info.mtime.toISOString(), tables: toList(data.tables) })
    }
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  async read(path: string): Promise<KnowledgeDoc> {
    const full = resolveInside(this.root, path)
    const info = await stat(full)
    if (info.size > MAX_FILE_BYTES) throw new KnowledgeError('File is too large')
    const content = await readFile(full, 'utf8')
    const { data, body } = parseFrontMatter(content)
    const rel = relative(this.root, full).split(sep).join('/')
    return {
      path: rel,
      title: titleOf(rel, body, data),
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      tables: toList(data.tables),
      content,
      body,
      relations: toList(data.relations)
        .map((r) => parseRelation(r, rel))
        .filter((r): r is VirtualRelation => r !== null),
    }
  }

  async write(path: string, content: string): Promise<string> {
    if (!/\.(md|markdown)$/i.test(path)) path = `${path}.md`
    const full = resolveInside(this.root, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content, 'utf8')
    return relative(this.root, full).split(sep).join('/')
  }

  /** Keyword search: scores files by term frequency, boosting titles and declared tables. */
  async search(query: string, limit = 8): Promise<{ path: string; title: string; score: number; excerpt: string }[]> {
    const terms = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((t) => t.length > 1)
    if (!terms.length) return []
    const results: { path: string; title: string; score: number; excerpt: string }[] = []
    for (const f of await this.list()) {
      let doc: KnowledgeDoc
      try {
        doc = await this.read(f.path)
      } catch {
        continue
      }
      const hay = doc.content.toLowerCase()
      let score = 0
      let firstHit = -1
      for (const t of terms) {
        let idx = hay.indexOf(t)
        while (idx !== -1) {
          score += 1
          if (firstHit === -1 || idx < firstHit) firstHit = idx
          idx = hay.indexOf(t, idx + t.length)
        }
        if (doc.title.toLowerCase().includes(t)) score += 5
        if (doc.tables.some((x) => x.toLowerCase() === t)) score += 8
      }
      if (score > 0) {
        const start = Math.max(0, firstHit - 120)
        results.push({ path: doc.path, title: doc.title, score, excerpt: doc.content.slice(start, start + 400).trim() })
      }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  /** Notes that mention a table, by front matter or by name in the text. */
  async forTable(table: string): Promise<KnowledgeDoc[]> {
    const lower = table.toLowerCase()
    const out: KnowledgeDoc[] = []
    for (const f of await this.list()) {
      const doc = await this.read(f.path).catch(() => null)
      if (!doc) continue
      if (doc.tables.some((t) => t.toLowerCase() === lower) || new RegExp(`\\b${escapeRegex(lower)}\\b`, 'i').test(doc.body)) out.push(doc)
    }
    return out
  }

  async relations(): Promise<VirtualRelation[]> {
    const out: VirtualRelation[] = []
    for (const f of await this.list()) {
      const doc = await this.read(f.path).catch(() => null)
      if (doc) out.push(...doc.relations)
    }
    return out
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Converts knowledge-base relations to foreign keys on the matching table, for diagrams and navigation. */
export function relationToForeignKey(r: VirtualRelation): { table: string; fk: ForeignKeyInfo } {
  const split = (name: string) => {
    const parts = name.split('.')
    return parts.length > 1 ? { schema: parts.slice(0, -1).join('.'), name: parts.at(-1)! } : { schema: undefined, name }
  }
  const to = split(r.toTable)
  return {
    table: r.fromTable,
    fk: {
      name: `kb:${r.fromTable}.${r.fromColumns.join('_')}`,
      columns: r.fromColumns,
      refSchema: to.schema,
      refTable: to.name,
      refColumns: r.toColumns,
      virtual: true,
    },
  }
}

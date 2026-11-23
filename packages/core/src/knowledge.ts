import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { readCapped } from './read-capped.js'
import { findTable } from './schema-utils.js'
import type { ForeignKeyInfo, SchemaSnapshot } from './types.js'

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

/** Resolves a path inside the knowledge base, refusing anything that escapes it (lexically: see realInside too). */
export function resolveInside(root: string, path: string): string {
  const base = resolve(root)
  const target = resolve(base, path)
  if (target !== base && !target.startsWith(base + sep)) throw new KnowledgeError('Path is outside the knowledge base')
  return target
}

/**
 * The same, on the real path: a shared or cloned knowledge base can carry links. The deepest part of the path that
 * exists, its links resolved, must be inside the real root (the root itself may be a link the user chose); for a
 * write or a delete no part between the root and the file may be a link at all. Opening then refuses a link in the
 * last place (O_NOFOLLOW), which closes the gap between this check and the use where the platform allows.
 */
export async function realInside(root: string, path: string, options: { write?: boolean } = {}): Promise<string> {
  const full = resolveInside(root, path)
  const base = resolve(root)
  const realRoot = await realpath(base)
  let existing = full
  for (;;) {
    try {
      await lstat(existing)
      break
    } catch {
      if (existing === base) break
      existing = dirname(existing)
    }
  }
  const real = await realpath(existing).catch(() => undefined)
  if (!real || (real !== realRoot && !real.startsWith(realRoot + sep))) throw new KnowledgeError('Path is outside the knowledge base (through a link)')
  if (options.write) {
    for (let part = full; part !== base && part.startsWith(base + sep); part = dirname(part)) {
      const info = await lstat(part).catch(() => undefined)
      if (info?.isSymbolicLink()) throw new KnowledgeError('A link inside the knowledge base is not written through')
    }
  }
  return full
}

export function parseFrontMatter(content: string): { data: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  if (!m) return { data: {}, body: content }
  const data: Record<string, unknown> = {}
  let currentKey: string | null = null
  for (const rawLine of m[1]!.split(/\r?\n/)) {
    const line = rawLine.replace(/(?<!\s)\s+#.*$/, '')
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

async function walk(root: string, dir: string, out: string[], kind: RegExp = /\.(md|markdown|mdx)$/i): Promise<void> {
  if (out.length >= MAX_FILES) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    // (Links are not followed: a shared folder could link to anywhere.)
    if (e.isSymbolicLink()) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) await walk(root, full, out, kind)
    else if (e.isFile() && kind.test(e.name)) out.push(full)
  }
}

export class KnowledgeBase {
  constructor(readonly root: string) {}

  async list(): Promise<KnowledgeFile[]> {
    const files: string[] = []
    await walk(this.root, this.root, files)
    const out: KnowledgeFile[] = []
    for (const full of files) {
      const info = await lstat(full)
      const rel = relative(this.root, full).split(sep).join('/')
      const head = info.size > MAX_FILE_BYTES ? '' : await readNote(full).catch(() => '')
      const { data, body } = parseFrontMatter(head)
      out.push({ path: rel, title: titleOf(rel, body, data), size: info.size, modifiedAt: info.mtime.toISOString(), tables: toList(data.tables) })
    }
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  async read(path: string): Promise<KnowledgeDoc> {
    const full = await realInside(this.root, path)
    const info = await lstat(full)
    if (info.size > MAX_FILE_BYTES) throw new KnowledgeError('File is too large')
    const content = await readNote(full)
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
    let full = await realInside(this.root, path, { write: true })
    await mkdir(dirname(full), { recursive: true })
    // (Again after the folders exist: one of them could have been a link made meanwhile.)
    full = await realInside(this.root, path, { write: true })
    const handle = await open(full, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0)).catch((err: NodeJS.ErrnoException) => {
      throw err.code === 'ELOOP' ? new KnowledgeError('A link inside the knowledge base is not written through') : err
    })
    try {
      await handle.writeFile(content, 'utf8')
    } finally {
      await handle.close()
    }
    return relative(this.root, full).split(sep).join('/')
  }

  /**
   * SQL files under a folder of the knowledge base (`queries/`, `tools/`): path, size and time. The same walk as notes
   * (no links, no hidden folders, at most MAX_FILES).
   */
  async listSql(folder: string): Promise<{ path: string; size: number; modifiedAt: string }[]> {
    // (A folder that is a link is not followed, as in the walk.)
    const start = resolveInside(this.root, folder)
    const isFolder = await lstat(start).then((i) => i.isDirectory(), () => false)
    if (!isFolder) return []
    const files: string[] = []
    await walk(this.root, start, files, /\.sql$/i)
    const out = []
    for (const full of files) {
      const info = await lstat(full)
      out.push({ path: relative(this.root, full).split(sep).join('/'), size: info.size, modifiedAt: info.mtime.toISOString() })
    }
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  /** A text file of the knowledge base (an .sql file): inside it, never through a link, capped like notes. */
  async readText(path: string): Promise<string> {
    const full = await realInside(this.root, path)
    if ((await lstat(full)).size > MAX_FILE_BYTES) throw new KnowledgeError('File is too large')
    return readNote(full)
  }

  /** Writes a text file other than a note (an .sql file), with the same checks as `write`. */
  async writeText(path: string, content: string): Promise<string> {
    if (!/\.sql$/i.test(path)) throw new KnowledgeError('Only .sql files are written this way')
    let full = await realInside(this.root, path, { write: true })
    await mkdir(dirname(full), { recursive: true })
    full = await realInside(this.root, path, { write: true })
    const handle = await open(full, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0)).catch((err: NodeJS.ErrnoException) => {
      throw err.code === 'ELOOP' ? new KnowledgeError('A link inside the knowledge base is not written through') : err
    })
    try {
      await handle.writeFile(content, 'utf8')
    } finally {
      await handle.close()
    }
    return relative(this.root, full).split(sep).join('/')
  }

  /** Deletes a note (never through a link). */
  async remove(path: string): Promise<void> {
    await rm(await realInside(this.root, path, { write: true }))
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

export interface KnowledgeIssue {
  path: string
  message: string
}

/** Notes that mention tables, columns or relationships the database no longer has. */
export async function staleKnowledge(kb: KnowledgeBase, snapshot: SchemaSnapshot): Promise<KnowledgeIssue[]> {
  const issues: KnowledgeIssue[] = []
  const table = (name: string) => {
    const parts = name.split('.')
    return findTable(snapshot, parts.length > 1 ? { schema: parts[0], name: parts.slice(1).join('.') } : { name })
  }
  for (const file of await kb.list()) {
    for (const name of file.tables) if (!table(name)) issues.push({ path: file.path, message: `Table ${name} no longer exists` })
  }
  for (const r of await kb.relations()) {
    const from = table(r.fromTable)
    const to = table(r.toTable)
    if (!from || !to) {
      issues.push({ path: r.source, message: `Relationship ${r.fromTable} → ${r.toTable}: table ${!from ? r.fromTable : r.toTable} no longer exists` })
      continue
    }
    const missing = [
      ...r.fromColumns.filter((c) => !from.columns.some((x) => x.name.toLowerCase() === c.toLowerCase())).map((c) => `${r.fromTable}.${c}`),
      ...r.toColumns.filter((c) => !to.columns.some((x) => x.name.toLowerCase() === c.toLowerCase())).map((c) => `${r.toTable}.${c}`),
    ]
    if (missing.length) issues.push({ path: r.source, message: `Relationship ${r.fromTable} → ${r.toTable}: column ${missing.join(', ')} no longer exists` })
  }
  return issues
}

/** A note's text: a plain file only (O_NOFOLLOW: a link swapped in after the check is refused), capped. */
async function readNote(full: string): Promise<string> {
  try {
    return (await readCapped(full, { limit: MAX_FILE_BYTES, what: 'a note', follow: false })).toString('utf8')
  } catch (err) {
    throw err instanceof Error && /not a plain file/.test(err.message) ? new KnowledgeError('A link inside the knowledge base is not read') : err
  }
}

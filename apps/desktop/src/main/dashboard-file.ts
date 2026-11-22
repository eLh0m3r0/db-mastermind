/**
 * A dashboard kept in a knowledge base: `dashboards/<name>.md`, Markdown a person reads on GitHub and edits by hand,
 * and that the assistant and agents read as any note.
 *
 *     ---
 *     dashboard: true
 *     refresh: 60
 *     ---
 *     # Sales overview
 *
 *     ## Orders per month
 *
 *     ```sql chart=line x=month y=orders wide
 *     select date_trunc('month', ordered_at) as month, count(*) as orders from orders group by 1 order by 1
 *     ```
 *
 * One `##` heading and one fenced `sql` block per tile; chart columns by name (`#2` is the second column, for a
 * result column without a name); no `chart=` is a table or a single big number; `wide` spans both columns. Text
 * between tiles is kept as it is. No ids or timestamps: a tile is its place and heading, the dashboard its file. The
 * file is untrusted input (a teammate's, a cloned repository's): names and headings are only text, and the SQL runs
 * as a guarded read (lib/dashboards.ts tileRequest).
 */
import type { DashboardTile } from '@shared/api'

export interface DashboardFile {
  name: string
  refreshSeconds: number
  /** Text between the title and the first tile. */
  intro?: string
  tiles: Omit<DashboardTile, 'id'>[]
}

/** More than this many tiles: the file is listed with what is wrong (nothing runs). */
export const MAX_TILES = 60
const KINDS = new Set(['bar', 'line', 'scatter'])

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim()

/** `key=value` and bare words of a fence's info string; values may be quoted ("order month"). */
function infoTokens(info: string): Map<string, string> {
  const out = new Map<string, string>()
  // (A value runs to the next space outside quotes: y=orders,"open orders".)
  for (const m of info.matchAll(/([A-Za-z]+)(?:=((?:"(?:[^"\\]|\\.)*"|[^\s"])*))?/g)) out.set(m[1]!.toLowerCase(), m[2] ?? '')
  return out
}

/** Column list `a,"b c",#3`. */
function columns(value: string): string[] {
  return [...value.matchAll(/"((?:[^"\\]|\\.)*)"|([^,]+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]!.trim())).filter(Boolean)
}

const column = (ref: string): { name?: string; index?: number } => {
  const m = /^#(\d{1,3})$/.exec(ref)
  return m ? { index: Math.max(0, Number(m[1]) - 1) } : { name: ref }
}

function chartOf(info: Map<string, string>): DashboardTile['chart'] {
  const kind = info.get('chart')
  if (!kind || !KINDS.has(kind)) return null
  const x = column(columns(info.get('x') ?? '')[0] ?? '#1')
  const ys = (columns(info.get('y') ?? '').length ? columns(info.get('y')!) : ['#2']).map(column)
  return {
    kind: kind as 'bar' | 'line' | 'scatter',
    x: x.index ?? 0,
    ys: ys.map((y, i) => y.index ?? i + 1),
    ...(x.name ? { xName: x.name } : {}),
    ...(ys.some((y) => y.name) ? { yNames: ys.map((y) => y.name ?? '') } : {}),
  }
}

/** Blank lines around a text block removed; `undefined` when nothing is left. */
const block = (lines: string[]) => {
  let a = 0
  let b = lines.length
  while (a < b && !lines[a]!.trim()) a++
  while (b > a && !lines[b - 1]!.trim()) b--
  return a < b ? lines.slice(a, b).join('\n') : undefined
}

/** Reads a dashboard file. Throws a sentence saying what is wrong when it can't be one. */
export function parseDashboard(content: string, fallbackName: string): DashboardFile {
  const text = content.replace(/\r\n?/g, '\n')
  let body = text
  let refreshSeconds = 0
  const front = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (front) {
    body = text.slice(front[0].length)
    for (const line of front[1]!.split('\n')) {
      const m = /^refresh:\s*(\d{1,6})\s*$/.exec(line)
      if (m) refreshSeconds = Number(m[1])
    }
  }
  const lines = body.split('\n')
  let name: string | undefined
  const intro: string[] = []
  const sections: { title: string; lines: string[] }[] = []
  let fence: { char: string; length: number } | null = null
  for (const line of lines) {
    const opens = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (opens && opens[1]![0] === fence.char && opens[1]!.length >= fence.length && !line.slice(opens[0].length).trim()) fence = null
    } else if (opens) {
      fence = { char: opens[1]![0]!, length: opens[1]!.length }
    } else if (/^## /.test(line)) {
      sections.push({ title: oneLine(line.slice(3)), lines: [] })
      continue
    } else if (!name && !sections.length && /^# /.test(line)) {
      name = oneLine(line.slice(2))
      continue
    }
    if (sections.length) sections.at(-1)!.lines.push(line)
    else intro.push(line)
  }
  const tiles: Omit<DashboardTile, 'id'>[] = []
  let introText = block(intro)
  for (const section of sections) {
    // The section's first ```sql block is the tile; everything else in it is kept as text around it.
    let start = -1
    let end = -1
    let info = new Map<string, string>()
    for (let i = 0; i < section.lines.length && end < 0; i++) {
      const m = /^ {0,3}(`{3,}|~{3,})\s*sql\b(.*)$/i.exec(section.lines[i]!)
      if (start < 0 && m) {
        start = i
        info = infoTokens(m[2] ?? '')
        const char = m[1]![0]!
        const length = m[1]!.length
        for (let j = i + 1; j < section.lines.length; j++) {
          const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(section.lines[j]!)
          if (close && close[1]![0] === char && close[1]!.length >= length) {
            end = j
            break
          }
        }
        if (end < 0) start = -1
        break
      }
    }
    if (start < 0) {
      // A section without SQL is text: it stays with the tile before it (or the intro).
      const kept = [`## ${section.title}`, ...section.lines]
      const prev = tiles.at(-1)
      if (prev) prev.after = block([...(prev.after ? prev.after.split('\n') : []), '', ...kept])
      else introText = block([...(introText ? introText.split('\n') : []), '', ...kept])
      continue
    }
    const sql = section.lines.slice(start + 1, end).join('\n')
    tiles.push({
      title: section.title || `Tile ${tiles.length + 1}`,
      sql,
      chart: chartOf(info),
      span: info.has('wide') ? 2 : 1,
      ...(block(section.lines.slice(0, start)) ? { before: block(section.lines.slice(0, start)) } : {}),
      ...(block(section.lines.slice(end + 1)) ? { after: block(section.lines.slice(end + 1)) } : {}),
    })
  }
  if (fence) throw new Error('A code block is not closed')
  if (tiles.length > MAX_TILES) throw new Error(`It has ${tiles.length} tiles; a dashboard shows at most ${MAX_TILES}`)
  return { name: name || fallbackName, refreshSeconds, ...(introText ? { intro: introText } : {}), tiles }
}

const quoteRef = (name: string) => (/^[^\s",#=]+$/.test(name) ? name : `"${name.replace(/(["\\])/g, '\\$1')}"`)

function chartInfo(chart: DashboardTile['chart']): string {
  if (!chart) return ''
  const x = chart.xName ? quoteRef(chart.xName) : `#${chart.x + 1}`
  const ys = chart.ys.map((y, i) => (chart.yNames?.[i] ? quoteRef(chart.yNames[i]!) : `#${y + 1}`)).join(',')
  return ` chart=${chart.kind} x=${x} y=${ys}`
}

/** Writes a dashboard file. The same dashboard always gives the same text (Git shows only real changes). */
export function writeDashboard(d: DashboardFile): string {
  const out = ['---', 'dashboard: true', ...(d.refreshSeconds ? [`refresh: ${d.refreshSeconds}`] : []), '---', `# ${oneLine(d.name) || 'Dashboard'}`, '']
  if (d.intro?.trim()) out.push(d.intro, '')
  for (const tile of d.tiles) {
    const sql = tile.sql.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
    // A fence longer than any run of backticks in the SQL.
    const longest = Math.max(2, ...[...sql.matchAll(/`+/g)].map((m) => m[0].length))
    const fence = '`'.repeat(longest + 1)
    out.push(`## ${oneLine(tile.title) || 'Tile'}`, '')
    if (tile.before?.trim()) out.push(tile.before, '')
    out.push(`${fence}sql${chartInfo(tile.chart)}${tile.span === 2 ? ' wide' : ''}`, sql, fence, '')
    if (tile.after?.trim()) out.push(tile.after, '')
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`
}

/** A file name for a dashboard's name: readable, without characters file systems refuse. */
export function dashboardFileName(name: string): string {
  const base = oneLine(name)
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
    .replace(/^[.\s-]+|[.\s]+$/g, '')
    .slice(0, 80)
  return `${base || 'Dashboard'}.md`
}

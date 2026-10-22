import { strFromU8, unzipSync } from 'fflate'
import { qualify, type Dialect } from './dialect.js'
import type { BuiltQuery } from './filters.js'
import type { TableRef } from './types.js'

/** Guesses the delimiter of a CSV-like text from its first lines (outside quotes). */
export function detectDelimiter(sample: string): string {
  const candidates = [',', ';', '\t', '|']
  const lines = sample.split(/\r?\n/).slice(0, 10).filter((l) => l.trim())
  let best = ','
  let bestScore = -1
  for (const d of candidates) {
    const counts = lines.map((l) => {
      let n = 0
      let quoted = false
      for (const ch of l) {
        if (ch === '"') quoted = !quoted
        else if (ch === d && !quoted) n++
      }
      return n
    })
    if (!counts.length || counts[0] === 0) continue
    // Consistent counts across lines beat a high count on one line.
    const consistent = counts.filter((c) => c === counts[0]).length
    const score = consistent * 100 + (counts[0] ?? 0)
    if (score > bestScore) {
      bestScore = score
      best = d
    }
  }
  return best
}

/** RFC 4180 parser: quoted fields, doubled quotes, newlines inside quotes, BOM. */
export function parseDelimited(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  for (; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"' && field === '') quoted = true
    else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  // Drop trailing empty lines.
  while (rows.length && rows.at(-1)!.every((c) => c === '')) rows.pop()
  return rows
}

const xmlText = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => {
    const map: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
    if (map[e.toLowerCase()]) return map[e.toLowerCase()]!
    return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)))
  })

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** Excel serial date → ISO date (time kept when present). */
function excelDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000)
  const iso = new Date(ms).toISOString()
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ')
}

/** Reads the first worksheet of an .xlsx file into rows of text. */
export function parseXlsx(data: Uint8Array): string[][] {
  const files = unzipSync(data)
  const shared: string[] = []
  const sst = files['xl/sharedStrings.xml']
  if (sst) {
    for (const si of strFromU8(sst).matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push(xmlText([...si[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')))
    }
  }
  // Styles: which cell formats are dates (so serial numbers become dates).
  const dateStyles = new Set<number>()
  const styles = files['xl/styles.xml']
  if (styles) {
    const xml = strFromU8(styles)
    const custom = new Map<number, string>()
    for (const m of xml.matchAll(/<numFmt numFmtId="(\d+)" formatCode="([^"]*)"/g)) custom.set(Number(m[1]), m[2]!)
    const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? ''
    ;[...xfs.matchAll(/<xf [^>]*numFmtId="(\d+)"/g)].forEach((m, i) => {
      const id = Number(m[1])
      const code = custom.get(id) ?? ''
      if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || /[dmy]{2}|h{1,2}:mm/i.test(code.replace(/"[^"]*"/g, ''))) dateStyles.add(i)
    })
  }
  const sheetName = Object.keys(files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort()[0]
  if (!sheetName) throw new Error('The workbook has no worksheets')
  const sheet = strFromU8(files[sheetName]!)
  const rows: string[][] = []
  for (const r of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = []
    for (const c of r[1]!.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]!
      const body = c[2] ?? ''
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1]
      const type = /t="(\w+)"/.exec(attrs)?.[1]
      const style = Number(/s="(\d+)"/.exec(attrs)?.[1] ?? -1)
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
      let value = ''
      if (type === 's') value = shared[Number(v)] ?? ''
      else if (type === 'inlineStr') value = xmlText([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''))
      else if (type === 'b') value = v === '1' ? 'true' : 'false'
      else if (v !== undefined) value = dateStyles.has(style) && !Number.isNaN(Number(v)) ? excelDate(Number(v)) : xmlText(v)
      const index = ref ? columnIndex(ref) : row.length
      while (row.length < index) row.push('')
      row[index] = value
    }
    rows.push(row)
  }
  while (rows.length && rows.at(-1)!.every((c) => c === '')) rows.pop()
  return rows
}

/** Maximum bind parameters per statement, per database. */
const PARAM_LIMIT: Record<string, number> = { mssql: 2000, postgres: 30_000, mysql: 30_000, mariadb: 30_000, sqlite: 30_000 }

/**
 * Multi-row INSERTs, chunked so no statement exceeds the database's parameter limit.
 * Empty strings become NULL when `emptyAsNull`.
 */
export function buildBatchInserts(
  table: TableRef,
  columns: string[],
  rows: (string | null)[][],
  dialect: Dialect,
  options: { emptyAsNull?: boolean; maxRowsPerStatement?: number } = {},
): BuiltQuery[] {
  if (!columns.length) return []
  const perStatement = Math.max(1, Math.min(options.maxRowsPerStatement ?? 500, Math.floor((PARAM_LIMIT[dialect.id] ?? 2000) / columns.length)))
  const target = qualify(dialect, table)
  const cols = columns.map((c) => dialect.quoteIdent(c)).join(', ')
  const out: BuiltQuery[] = []
  for (let start = 0; start < rows.length; start += perStatement) {
    const chunk = rows.slice(start, start + perStatement)
    const params: unknown[] = []
    const tuples = chunk.map((row) => {
      const values = columns.map((_, i) => {
        const v = row[i] ?? null
        if (v === null || (options.emptyAsNull && v === '')) return 'NULL'
        params.push(v)
        return dialect.placeholder(params.length)
      })
      return `(${values.join(', ')})`
    })
    out.push({ sql: `INSERT INTO ${target} (${cols}) VALUES ${tuples.join(', ')}`, params })
  }
  return out
}

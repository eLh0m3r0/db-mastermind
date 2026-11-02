import { cellToText, getDialect, isBinaryValue, qualify, type CellValue, type DriverId, type ResultField, type TableRef } from '@dbmastermind/core/browser'
import type { ExportFormat } from '@shared/api'

export const EXPORT_FORMATS: { id: ExportFormat; label: string }[] = [
  { id: 'csv', label: 'CSV' },
  { id: 'xlsx', label: 'Excel (.xlsx)' },
  { id: 'json', label: 'JSON' },
  { id: 'jsonl', label: 'JSON Lines' },
  { id: 'sql', label: 'SQL INSERT' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'tsv', label: 'TSV' },
]

function jsonValue(v: CellValue): unknown {
  if (isBinaryValue(v)) return `0x${v.$binary}`
  return v
}

/** Formats offered by the Copy button of query results: TSV pastes into Excel, JSON and Markdown into an AI chat. */
export type ResultCopyFormat = 'tsv' | 'json' | 'markdown'

export interface NamedResult {
  name: string
  /** The statement that produced it, kept with JSON/Markdown so a reader (or an LLM) knows what the rows are. */
  sql?: string
  fields: ResultField[]
  rows: CellValue[][]
}

function tsv(fields: ResultField[], rows: CellValue[][]): string {
  const esc = (v: string) => (/[\t\n\r"]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v)
  return [fields.map((f) => esc(f.name)).join('\t'), ...rows.map((r) => fields.map((_, i) => (r[i] == null ? '' : esc(cellToText(r[i]!)))).join('\t'))].join('\n')
}

/**
 * One result: just its rows. Several: TSV blocks separated by an empty line under the result's name (pasted into
 * Excel they land one below the other), a JSON array of `{ result, rows }`, Markdown sections.
 * `withSql` adds each statement (JSON/Markdown only); off by default, a long script's SQL can dwarf a one-row result.
 */
export function copyResultsAs(format: ResultCopyFormat, results: NamedResult[], { withSql = false } = {}): string {
  const sqlOf = (r: NamedResult) => (withSql && r.sql?.trim()) || undefined
  const objects = (r: NamedResult) => r.rows.map((row) => Object.fromEntries(r.fields.map((f, i) => [f.name, jsonValue(row[i] ?? null)])))
  if (results.length === 1) {
    const [r] = results as [NamedResult]
    const sql = sqlOf(r)
    if (format === 'tsv') return tsv(r.fields, r.rows)
    if (!sql) return copyRowsAs(format, r.fields, r.rows, undefined)
    return format === 'json' ? JSON.stringify({ sql, rows: objects(r) }, null, 2) : ['```sql', sql, '```', '', copyRowsAs('markdown', r.fields, r.rows, undefined)].join('\n')
  }
  switch (format) {
    case 'tsv':
      return results.map((r) => `${r.name}\n${tsv(r.fields, r.rows)}`).join('\n\n')
    case 'json':
      return JSON.stringify(
        results.map((r) => ({ result: r.name, ...(sqlOf(r) ? { sql: sqlOf(r) } : {}), rows: objects(r) })),
        null,
        2,
      )
    case 'markdown':
      return results
        .map((r) => {
          const sql = sqlOf(r)
          return [`## ${r.name}`, ...(sql ? ['```sql', sql, '```'] : []), '', copyRowsAs('markdown', r.fields, r.rows, undefined)].join('\n')
        })
        .join('\n\n')
  }
}

export function copyRowsAs(
  format: 'json' | 'csv' | 'markdown' | 'sql',
  fields: ResultField[],
  rows: CellValue[][],
  driver: DriverId | undefined,
  /** The source table (quoted per dialect in INSERTs); results of a query have none. */
  table: TableRef = { name: 'my_table' },
): string {
  const names = fields.map((f) => f.name)
  switch (format) {
    case 'json':
      return JSON.stringify(
        rows.map((r) => Object.fromEntries(names.map((n, i) => [n, jsonValue(r[i] ?? null)]))),
        null,
        2,
      )
    case 'csv': {
      const cell = (v: CellValue | string) => {
        if (v === null) return ''
        const t = typeof v === 'string' ? v : cellToText(v)
        return /[",\r\n]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t
      }
      return [names.map(cell).join(','), ...rows.map((r) => r.map((v) => cell(v)).join(','))].join('\n')
    }
    case 'markdown': {
      const esc = (t: string) => t.replaceAll('|', '\\|').replace(/\r?\n/g, ' ')
      return [
        `| ${names.map(esc).join(' | ')} |`,
        `|${names.map(() => ' --- ').join('|')}|`,
        ...rows.map((r) => `| ${r.map((v) => esc(cellToText(v ?? null))).join(' | ')} |`),
      ].join('\n')
    }
    case 'sql': {
      const dialect = getDialect(driver ?? 'postgres')
      const lit = (v: CellValue) => {
        if (v === null) return 'NULL'
        if (typeof v === 'number') return String(v)
        if (typeof v === 'boolean') return v ? dialect.trueLiteral : dialect.falseLiteral
        const t = cellToText(v).replaceAll("'", "''")
        return dialect.id === 'mssql' ? `N'${t}'` : `'${t}'`
      }
      const cols = names.map((n) => dialect.quoteIdent(n)).join(', ')
      const target = qualify(dialect, table)
      return rows.map((r) => `INSERT INTO ${target} (${cols}) VALUES (${r.map((v) => lit(v ?? null)).join(', ')});`).join('\n')
    }
  }
}

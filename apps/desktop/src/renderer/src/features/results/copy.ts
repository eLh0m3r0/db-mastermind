import { cellToText, getDialect, isBinaryValue, type CellValue, type DriverId, type ResultField } from '@dbmastermind/core/browser'
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

export function copyRowsAs(
  format: 'json' | 'csv' | 'markdown' | 'sql',
  fields: ResultField[],
  rows: CellValue[][],
  driver: DriverId | undefined,
  tableName = 'my_table',
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
      return rows.map((r) => `INSERT INTO ${tableName} (${cols}) VALUES (${r.map((v) => lit(v ?? null)).join(', ')});`).join('\n')
    }
  }
}

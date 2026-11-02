import { createWriteStream, writeFileSync, type WriteStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { cellToText, isBinaryValue, type CellValue, type Dialect, type ResultField } from '@dbmastermind/core'
import type { ExportFormat } from '@shared/api'

export const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
  csv: 'csv',
  tsv: 'tsv',
  json: 'json',
  jsonl: 'jsonl',
  sql: 'sql',
  markdown: 'md',
  xlsx: 'xlsx',
}

function csvCell(value: CellValue, separator: string): string {
  if (value === null) return ''
  const text = cellToText(value)
  return text.includes(separator) || /["\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** Column types holding decimal numbers. */
function isNumericType(type?: string): boolean {
  return !!type && /^(numeric|decimal|number|real|float|double|money|smallmoney|dec|fixed)/i.test(type.trim())
}

function jsonCell(value: CellValue): unknown {
  if (isBinaryValue(value)) return `0x${value.$binary}`
  return value
}

function sqlLiteral(value: CellValue, dialect?: Dialect): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? (dialect?.trueLiteral ?? 'TRUE') : (dialect?.falseLiteral ?? 'FALSE')
  if (isBinaryValue(value)) return dialect?.id === 'postgres' ? `'\\x${value.$binary}'` : `0x${value.$binary}`
  const text = cellToText(value).replaceAll("'", "''")
  return dialect?.id === 'mssql' ? `N'${text}'` : `'${text}'`
}

function markdownCell(value: CellValue): string {
  return cellToText(value).replaceAll('|', '\\|').replace(/\r?\n/g, '<br>')
}

/** Streaming writer: header → batches of rows → footer. Lets table exports page through millions of rows. */
export interface ExportWriter {
  writeRows(rows: CellValue[][]): Promise<void>
  close(): Promise<void>
}

export function createExportWriter(
  path: string,
  format: ExportFormat,
  fields: ResultField[],
  options: { tableName?: string; dialect?: Dialect; csvDelimiter?: string } = {},
): ExportWriter {
  const sep = options.csvDelimiter ?? ','
  // Semicolon CSV is what Excel uses where the decimal separator is a comma (Czech): numbers follow, else Excel reads
  // 10.5 as a date or text.
  // Exact decimals often arrive as strings (PostgreSQL numeric): those only in columns typed as numbers.
  const decimalComma = sep === ';' ? fields.map((f) => isNumericType(f.dataType)) : []
  const csvValue = (v: CellValue, i: number): CellValue =>
    sep === ';' && (typeof v === 'number' || (decimalComma[i] && typeof v === 'string' && /^-?\d+\.\d+$/.test(v))) ? String(v).replace('.', ',') : v
  if (format === 'xlsx') return createXlsxWriter(path, fields)

  const out: WriteStream = createWriteStream(path, { encoding: 'utf8' })
  let streamError: Error | undefined
  out.on('error', (err) => (streamError = err))
  const write = async (chunk: string) => {
    if (streamError) throw streamError
    if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', resolve))
  }
  const names = fields.map((f) => f.name)
  let first = true

  const header = (): string => {
    switch (format) {
      case 'csv':
        // BOM so Excel opens UTF-8 (accented characters) correctly.
        return '﻿' + names.map((n) => csvCell(n, sep)).join(sep) + '\r\n'
      case 'tsv':
        return names.map((n) => csvCell(n, '\t')).join('\t') + '\n'
      case 'json':
        return '[\n'
      case 'markdown':
        return `| ${names.map((n) => markdownCell(n)).join(' | ')} |\n|${names.map(() => ' --- ').join('|')}|\n`
      default:
        return ''
    }
  }

  const quote = options.dialect?.quoteIdent ?? ((n: string) => `"${n.replaceAll('"', '""')}"`)
  const target = options.tableName ?? 'exported_rows'
  const columnList = names.map((n) => quote(n)).join(', ')

  const row = (r: CellValue[]): string => {
    switch (format) {
      case 'csv':
        return r.map((v, i) => csvCell(csvValue(v, i), sep)).join(sep) + '\r\n'
      case 'tsv':
        return r.map((v) => csvCell(v, '\t')).join('\t') + '\n'
      case 'json': {
        const obj = Object.fromEntries(names.map((n, i) => [n, jsonCell(r[i] ?? null)]))
        const text = `${first ? '' : ',\n'}  ${JSON.stringify(obj)}`
        first = false
        return text
      }
      case 'jsonl':
        return JSON.stringify(Object.fromEntries(names.map((n, i) => [n, jsonCell(r[i] ?? null)]))) + '\n'
      case 'sql':
        return `INSERT INTO ${target} (${columnList}) VALUES (${r.map((v) => sqlLiteral(v, options.dialect)).join(', ')});\n`
      case 'markdown':
        return `| ${r.map(markdownCell).join(' | ')} |\n`
      default:
        return ''
    }
  }

  let started = false
  return {
    async writeRows(rows) {
      if (!started) {
        started = true
        await write(header())
      }
      if (rows.length) await write(rows.map(row).join(''))
    },
    async close() {
      if (!started) await write(header())
      if (format === 'json') await write(first ? ']\n' : '\n]\n')
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
    },
  }
}

const xmlEscape = (s: string) =>
  s
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
    // Characters not allowed in XML 1.0, and halves of broken surrogate pairs (they'd become invalid UTF-8).
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')

function columnLetter(index: number): string {
  let n = index + 1
  let s = ''
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** One worksheet: inline strings, bold frozen header with a filter. */
function sheetXml(fields: ResultField[], rows: CellValue[][], selected: boolean): { xml: string; absolute: string } {
  const rowsXml: string[] = []
  let rowIndex = 0
  const cell = (value: CellValue, col: number, row: number, style = 0): string => {
    const ref = `${columnLetter(col)}${row}`
    const s = style ? ` s="${style}"` : ''
    if (value === null) return ''
    if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`
    if (typeof value === 'boolean') return `<c r="${ref}" t="b"${s}><v>${value ? 1 : 0}</v></c>`
    // Excel cells hold at most 32767 characters.
    const text = cellToText(value).slice(0, 32767)
    return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`
  }
  const addRow = (values: CellValue[], style = 0) => {
    rowIndex++
    rowsXml.push(`<row r="${rowIndex}">${values.map((v, i) => cell(v, i, rowIndex, style)).join('')}</row>`)
  }
  addRow(
    fields.map((f) => f.name),
    1,
  )
  for (const r of rows) addRow(r)
  const lastCol = columnLetter(Math.max(0, fields.length - 1))
  const range = `A1:${lastCol}${rowIndex}`
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="${range}"/><sheetViews><sheetView${selected ? ' tabSelected="1"' : ''} workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>${rowsXml.join('')}</sheetData><autoFilter ref="${range}"/><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`
  return { xml, absolute: `$A$1:$${lastCol}$${rowIndex}` }
}

/** Excel sheet names: at most 31 characters, none of []:*?/\, no apostrophe at either end, unique ignoring case. */
export function sheetNames(names: string[]): string[] {
  const used = new Set<string>()
  return names.map((name, i) => {
    const base = (name.replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim() || `Sheet${i + 1}`).slice(0, 31).trim()
    let candidate = base
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${base.slice(0, 31 - ` (${n})`.length)} (${n})`
    used.add(candidate.toLowerCase())
    return candidate
  })
}

/**
 * Office Open XML workbook, one sheet per result. The parts follow what Excel writes itself (a Normal cell style,
 * a dimension, the filter's defined name, document properties), so strict readers open it without repairs.
 */
export function xlsxWorkbook(sheets: { name: string; fields: ResultField[]; rows: CellValue[][] }[]): Uint8Array {
  const names = sheetNames(sheets.map((s) => s.name))
  const built = sheets.map((s, i) => sheetXml(s.fields, s.rows, i === 0))
  // Excel quotes names in references only when it has to: spaces, punctuation, or something that reads as a cell (A1).
  const quoted = (name: string) => (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) ? name : `'${name.replaceAll("'", "''")}'`)
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${built.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${names.map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><definedNames>${built.map((b, i) => `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${xmlEscape(quoted(names[i]!))}!${b.absolute}</definedName>`).join('')}</definedNames></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${built.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${built.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    'xl/styles.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`,
    ),
    'docProps/core.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>DB Mastermind</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`,
    ),
    'docProps/app.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>DB Mastermind</Application></Properties>`,
    ),
  }
  built.forEach((b, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(b.xml)))
  return zipSync(files, { level: 6 })
}

function createXlsxWriter(path: string, fields: ResultField[]): ExportWriter {
  const rows: CellValue[][] = []
  return {
    async writeRows(batch) {
      for (const r of batch) rows.push(r)
    },
    async close() {
      writeFileSync(path, xlsxWorkbook([{ name: 'Data', fields, rows }]))
    },
  }
}

/**
 * Several results in one file: an Excel workbook with a sheet per result; other formats a ZIP with a file per result
 * (named after the result, e.g. `Result 2.csv`).
 */
export async function exportResultSet(
  path: string,
  format: ExportFormat,
  results: { name: string; fields: ResultField[]; rows: CellValue[][] }[],
  options: { dialect?: Dialect; csvDelimiter?: string } = {},
): Promise<void> {
  if (format === 'xlsx') {
    writeFileSync(path, xlsxWorkbook(results))
    return
  }
  const dir = await mkdtemp(join(tmpdir(), 'dbm-export-'))
  try {
    const names = sheetNames(results.map((r) => r.name.replace(/[\\/:*?"<>|]/g, '_')))
    const files: Record<string, Uint8Array> = {}
    for (const [i, r] of results.entries()) {
      const file = join(dir, String(i))
      const writer = createExportWriter(file, format, r.fields, options)
      await writer.writeRows(r.rows)
      await writer.close()
      files[`${names[i]}.${EXPORT_EXTENSIONS[format]}`] = await readFile(file)
    }
    writeFileSync(path, zipSync(files, { level: 6 }))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

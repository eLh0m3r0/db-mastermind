import { useEffect, useMemo, useState } from 'react'
import { FileUp } from 'lucide-react'
import type { ColumnInfo, TableRef } from '@dbmastermind/core/browser'
import type { ImportPreview } from '@shared/api'
import { Button } from '@/components/ui/Button'
import { Checkbox, Select } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { api } from '@/lib/api'
import { cn, errorMessage, formatCount } from '@/lib/utils'
import { toast } from '@/store/ui'

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '')

const DELIMITERS = [
  { value: ',', label: 'Comma ,' },
  { value: ';', label: 'Semicolon ;' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe |' },
]

export function ImportModal({
  open,
  onClose,
  connectionId,
  table,
  columns,
  onImported,
}: {
  open: boolean
  onClose: () => void
  connectionId: string
  table: TableRef
  columns: ColumnInfo[]
  onImported: () => void
}) {
  const [path, setPath] = useState<string | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [delimiter, setDelimiter] = useState<string | undefined>()
  const [hasHeader, setHasHeader] = useState(true)
  const [mapping, setMapping] = useState<(string | null)[]>([])
  const [emptyAsNull, setEmptyAsNull] = useState(true)
  const [replace, setReplace] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) {
      setPath(null)
      setPreview(null)
      setDelimiter(undefined)
      setReplace(false)
    }
  }, [open])

  const load = async (file: string, d?: string) => {
    try {
      const p = await api.importPreview(file, d)
      setPreview(p)
      setDelimiter(p.delimiter)
      // Auto-map by header name (case, accents and punctuation ignored); skip identity columns.
      const header = p.rows[0] ?? []
      setMapping(
        header.map((h) => {
          const match = columns.find((c) => norm(c.name) === norm(h))
          return match && !(match.isIdentity && !hasHeader) ? match.name : null
        }),
      )
    } catch (err) {
      toast({ kind: 'error', message: 'Could not read the file', detail: errorMessage(err) })
    }
  }

  const choose = async () => {
    const file = await api.pickFile({
      title: 'Import data',
      filters: [
        { name: 'Data files', extensions: ['csv', 'tsv', 'txt', 'xlsx'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (!file) return
    setPath(file)
    await load(file)
  }

  const width = preview ? Math.max(...preview.rows.slice(0, 20).map((r) => r.length)) : 0
  const dataRows = useMemo(() => (preview ? preview.rows.slice(hasHeader ? 1 : 0, (hasHeader ? 1 : 0) + 20) : []), [preview, hasHeader])
  const total = preview ? preview.totalRows - (hasHeader ? 1 : 0) : 0
  const mapped = mapping.filter(Boolean).length
  const duplicates = mapping.filter((m, i) => m && mapping.indexOf(m) !== i)
  const missingRequired = columns.filter((c) => !c.nullable && !c.defaultValue && !c.isIdentity && !c.isGenerated && !mapping.includes(c.name))

  const run = async () => {
    if (!path) return
    if (replace && !window.confirm(`Delete all existing rows of ${table.name} before importing?`)) return
    setBusy(true)
    try {
      const n = await api.importFile({ connectionId, table, path, delimiter, hasHeader, mapping, emptyAsNull, replace })
      toast({ kind: 'success', message: `Imported ${formatCount(n)} rows into ${table.name}` })
      onImported()
      onClose()
    } catch (err) {
      toast({ kind: 'error', message: 'Import failed: nothing was changed', detail: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Import into ${table.name}`}
      width={900}
      footer={
        preview ? (
          <>
            <span className="text-[12px] text-fg-muted">
              {formatCount(total)} rows · {mapped} of {width} columns mapped · one transaction
            </span>
            <div className="flex-1" />
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!mapped || duplicates.length > 0} onClick={() => void run()}>
              Import {formatCount(total)} rows
            </Button>
          </>
        ) : undefined
      }
    >
      {!preview ? (
        <button
          type="button"
          onClick={() => void choose()}
          className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong p-10 text-fg-muted hover:border-accent hover:text-fg"
        >
          <FileUp size={26} />
          <span className="text-[14px] font-medium">Choose a CSV, TSV or Excel file</span>
          <span className="text-[12px] text-fg-faint">UTF-8 or Windows-1250 · delimiter detected automatically · first sheet of .xlsx</span>
        </button>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-4">
            <span className="max-w-[340px] truncate font-mono text-[12px] text-fg-muted" title={path ?? ''}>
              {path}
            </span>
            {preview.format === 'csv' && (
              <Select
                inputSize="sm"
                className="w-36"
                value={delimiter}
                onChange={(e) => {
                  setDelimiter(e.target.value)
                  if (path) void load(path, e.target.value)
                }}
              >
                {DELIMITERS.map((d) => (
                  <option key={d.label} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </Select>
            )}
            {preview.encoding && preview.encoding !== 'utf-8' && <span className="text-[11.5px] text-fg-faint">{preview.encoding}</span>}
            <Checkbox checked={hasHeader} onChange={setHasHeader} label="First row is a header" />
            <Checkbox checked={emptyAsNull} onChange={setEmptyAsNull} label="Empty values as NULL" />
            <Checkbox checked={replace} onChange={setReplace} label="Replace existing rows" />
          </div>
          {(missingRequired.length > 0 || duplicates.length > 0) && (
            <div className="rounded-md bg-warning-soft px-3 py-2 text-[12px] text-warning">
              {duplicates.length > 0 && <div>Each table column can be mapped once: {[...new Set(duplicates)].join(', ')}.</div>}
              {missingRequired.length > 0 && <div>Required columns without a mapping: {missingRequired.map((c) => c.name).join(', ')}. The import will fail unless they have values.</div>}
            </div>
          )}
          <div className="max-h-[50vh] overflow-auto rounded-md border border-line">
            <table className="border-collapse text-[12px]">
              <thead className="sticky top-0 bg-subtle">
                <tr>
                  {Array.from({ length: width }, (_, i) => (
                    <th key={i} className="min-w-[140px] border-r border-b border-line p-1.5 text-left align-top">
                      <div className="mb-1 truncate font-medium">{hasHeader ? (preview.rows[0]?.[i] ?? '') : `Column ${i + 1}`}</div>
                      <Select
                        inputSize="sm"
                        className={cn('h-6 text-[11.5px]', !mapping[i] && 'text-fg-faint')}
                        value={mapping[i] ?? ''}
                        onChange={(e) => setMapping((m) => Object.assign([...m], { [i]: e.target.value || null }))}
                      >
                        <option value="">— skip —</option>
                        {columns.map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.name} ({c.dataType})
                          </option>
                        ))}
                      </Select>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="font-mono">
                {dataRows.map((r, ri) => (
                  <tr key={ri}>
                    {Array.from({ length: width }, (_, i) => (
                      <td key={i} className={cn('max-w-[240px] truncate border-r border-b border-line px-1.5 py-1', !mapping[i] && 'text-fg-faint')}>
                        {r[i] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  )
}

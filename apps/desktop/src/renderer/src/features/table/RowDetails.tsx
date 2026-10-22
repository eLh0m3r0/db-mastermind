import { useState } from 'react'
import { Copy, KeyRound, X } from 'lucide-react'
import { cellToText, type CellValue, type ColumnInfo, type ResultField } from '@dbmastermind/core/browser'
import { IconButton } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { copyText, cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'

function pretty(value: CellValue): string {
  if (value === null) return ''
  const text = cellToText(value)
  if (/^\s*[[{]/.test(text)) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      return text
    }
  }
  return text
}

/** Vertical record view of the focused row: easier to read wide rows and long values. */
export function RowDetails({
  fields,
  row,
  columns,
  editable,
  onEdit,
  onClose,
}: {
  fields: ResultField[]
  row: CellValue[] | null
  columns: ColumnInfo[]
  editable: boolean
  onEdit: (col: number, value: string | null) => void
  onClose: () => void
}) {
  const [search, setSearch] = useState('')
  const t = useT()
  const needle = search.trim().toLowerCase()
  return (
    <div className="flex w-[340px] shrink-0 flex-col border-l border-line bg-subtle">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line pr-1.5 pl-3">
        <span className="text-[12px] font-semibold">{t('Row details')}</span>
        <div className="flex-1" />
        <IconButton label={t('Copy row as JSON')} disabled={!row} onClick={() => row && void copyText(JSON.stringify(Object.fromEntries(fields.map((f, i) => [f.name, row[i] ?? null])), null, 2))}>
          <Copy size={13} />
        </IconButton>
        <IconButton label={t('Close')} onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
      <div className="border-b border-line p-2">
        <Input inputSize="sm" placeholder={t('Find field…')} value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {!row ? (
        <div className="p-4 text-[12px] text-fg-faint">{t('Select a row to see its values.')}</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {fields.map((f, i) => {
            if (needle && !f.name.toLowerCase().includes(needle)) return null
            const col = columns.find((c) => c.name === f.name)
            const value = row[i] ?? null
            const text = pretty(value)
            const multiline = text.includes('\n') || text.length > 60
            return (
              <div key={f.name} className="mb-2">
                <div className="mb-0.5 flex items-center gap-1 text-[11.5px]">
                  {col?.isPrimaryKey && <KeyRound size={10} className="text-warning" />}
                  <span className="font-medium">{f.name}</span>
                  <span className="truncate text-fg-faint">{col?.dataType ?? f.dataType}</span>
                  <div className="flex-1" />
                  {editable && col?.nullable && value !== null && (
                    <button type="button" className="text-[10.5px] text-fg-faint hover:text-accent" onClick={() => onEdit(i, null)}>
                      {t('set NULL')}
                    </button>
                  )}
                </div>
                {editable ? (
                  <textarea
                    key={`${f.name}:${text}`}
                    defaultValue={text}
                    placeholder={value === null ? 'NULL' : ''}
                    rows={multiline ? Math.min(12, text.split('\n').length + 1) : 1}
                    onBlur={(e) => {
                      if (e.target.value !== text || (value === null && e.target.value !== '')) onEdit(i, e.target.value)
                    }}
                    className={cn(
                      'w-full resize-y rounded-md border border-line bg-bg px-2 py-1 font-mono text-[12px] leading-snug',
                      'focus:border-accent focus:outline-none',
                      value === null && 'placeholder:text-null placeholder:italic',
                    )}
                  />
                ) : (
                  <div
                    className={cn(
                      'rounded-md border border-line bg-bg px-2 py-1 font-mono text-[12px] break-all whitespace-pre-wrap select-text',
                      value === null && 'text-null italic',
                    )}
                  >
                    {value === null ? 'NULL' : text}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

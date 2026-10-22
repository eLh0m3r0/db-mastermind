import { useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import { Copy } from 'lucide-react'
import { cellToText, isBinaryValue, type CellValue } from '@dbmastermind/core/browser'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { useT } from '@/lib/i18n'
import { copyText, formatCount } from '@/lib/utils'
import { toast } from '@/store/ui'

interface ViewerState {
  value?: CellValue
  title?: string
  dataType?: string
  /** Set for editable cells: stores the new value (null for NULL). */
  onSave?: (value: string | null) => void
  open(value: CellValue, title: string, dataType?: string, onSave?: (value: string | null) => void): void
  close(): void
}

export const useCellViewer = create<ViewerState>((set) => ({
  open: (value, title, dataType, onSave) => set({ value, title, dataType, onSave }),
  close: () => set({ value: undefined, title: undefined, dataType: undefined, onSave: undefined }),
}))

export const openCellViewer = (value: CellValue, title: string, dataType?: string, onSave?: (value: string | null) => void) =>
  useCellViewer.getState().open(value, title, dataType, onSave)

const IMAGE_MAGIC: [string, string][] = [
  ['89504e47', 'image/png'],
  ['ffd8ff', 'image/jpeg'],
  ['47494638', 'image/gif'],
  ['424d', 'image/bmp'],
]

/** A data URL when the bytes are a complete PNG/JPEG/GIF/BMP/WebP image. */
export function imageDataUrl(hex: string, length: number): string | null {
  if (hex.length < length * 2) return null
  const h = hex.toLowerCase()
  const mime = IMAGE_MAGIC.find(([magic]) => h.startsWith(magic))?.[1] ?? (h.startsWith('52494646') && h.slice(16, 24) === '57454250' ? 'image/webp' : null)
  if (!mime) return null
  const bytes = new Uint8Array(h.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${mime};base64,${btoa(bin)}`
}

function jsonError(text: string): string | null {
  try {
    JSON.parse(text)
    return null
  } catch (err) {
    return (err as Error).message
  }
}

function hexDump(hex: string): string {
  const lines: string[] = []
  for (let i = 0; i < hex.length; i += 32) {
    const chunk = hex.slice(i, i + 32)
    const bytes = chunk.match(/../g) ?? []
    const ascii = bytes.map((b) => {
      const c = Number.parseInt(b, 16)
      return c >= 32 && c < 127 ? String.fromCharCode(c) : '.'
    })
    lines.push(`${(i / 2).toString(16).padStart(8, '0')}  ${bytes.join(' ').padEnd(47)}  ${ascii.join('')}`)
  }
  return lines.join('\n')
}

/** Full view of one cell: pretty JSON, long text with wrapping, binary as a hex dump. */
export function CellViewer() {
  const t = useT()
  const { value, title, dataType, onSave, close } = useCellViewer()
  const [mode, setMode] = useState<'pretty' | 'raw'>('pretty')
  const [draft, setDraft] = useState<string | null>(null)
  const open = value !== undefined
  const view = useMemo(() => {
    if (value === undefined || value === null) return { kind: 'null' as const, text: 'NULL' }
    if (isBinaryValue(value)) return { kind: 'binary' as const, text: hexDump(value.$binary), size: value.length, image: imageDataUrl(value.$binary, value.length) }
    const text = cellToText(value)
    if (/^\s*[[{]/.test(text)) {
      try {
        return { kind: 'json' as const, text: JSON.stringify(JSON.parse(text), null, 2), raw: text }
      } catch {
        // Not JSON after all.
      }
    }
    return { kind: 'text' as const, text }
  }, [value])

  const shown = view.kind === 'json' && mode === 'raw' ? view.raw : view.text
  const editing = !!onSave && view.kind !== 'binary'
  // Declared JSON columns must hold valid JSON; text that merely looks like JSON only gets a warning.
  const isJsonType = /json/i.test(dataType ?? '')
  const jsonLike = isJsonType || view.kind === 'json' || /^\s*[[{]/.test(draft ?? '')
  useEffect(() => {
    setDraft(value === undefined || value === null || isBinaryValue(value) ? (value === null ? '' : null) : shown ?? '')
    // Reset only when another cell opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  const draftError = editing && jsonLike && draft?.trim() ? jsonError(draft) : null
  const blocking = isJsonType && !!draftError
  const save = (next: string | null) => {
    onSave?.(next)
    close()
  }
  const reformat = (indent: number | undefined) => {
    if (draft === null || jsonError(draft)) return
    setDraft(JSON.stringify(JSON.parse(draft), null, indent))
  }
  return (
    <Modal
      open={open}
      onClose={close}
      title={
        <span>
          {title} {dataType && <span className="font-normal text-fg-faint">{dataType}</span>}
        </span>
      }
      width={760}
      footer={
        <>
          <span className="text-[12px] text-fg-muted">
            {view.kind === 'binary' ? t('{n} bytes', { n: formatCount(view.size ?? 0) }) : t('{n} characters', { n: formatCount((editing ? draft : shown)?.length ?? 0) })}
          </span>
          <div className="flex-1" />
          {editing && draftError && <span className={`truncate text-[12px] ${blocking ? 'text-danger' : 'text-warning'}`}>{t('Invalid JSON: {error}', { error: draftError })}</span>}
          {editing && jsonLike && (
            <>
              <Button size="sm" variant="ghost" disabled={!!draftError} onClick={() => reformat(2)}>
                {t('Format')}
              </Button>
              <Button size="sm" variant="ghost" disabled={!!draftError} onClick={() => reformat(undefined)}>
                {t('Minify')}
              </Button>
            </>
          )}
          {!editing && view.kind === 'json' && (
            <Segmented
              size="xs"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'pretty', label: t('Formatted') },
                { value: 'raw', label: t('Raw') },
              ]}
            />
          )}
          <Button
            icon={<Copy size={13} />}
            onClick={() => {
              void copyText(view.kind === 'json' && mode === 'pretty' ? view.text : (view.kind === 'json' ? view.raw : view.text) ?? '')
              toast({ kind: 'success', message: t('Copied') })
            }}
          >
            {t('Copy')}
          </Button>
          {editing && (
            <>
              <Button variant="ghost" onClick={() => save(null)}>
                {t('Set NULL')}
              </Button>
              <Button variant="primary" disabled={blocking} onClick={() => save(draft ?? '')}>
                {t('Apply')}
              </Button>
            </>
          )}
        </>
      }
    >
      {editing ? (
        <textarea
          autoFocus
          spellCheck={false}
          value={draft ?? ''}
          placeholder={value === null ? 'NULL' : ''}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !blocking) {
              e.preventDefault()
              save(draft ?? '')
            }
          }}
          className="h-[60vh] w-full resize-none rounded-md border border-line bg-subtle p-3 font-mono text-[12px] leading-relaxed focus:border-accent focus:outline-none placeholder:text-null placeholder:italic"
        />
      ) : (
        <>
          {view.kind === 'binary' && view.image && (
            <div className="mb-3 flex justify-center rounded-md bg-subtle p-3">
              <img src={view.image} alt={title} className="max-h-[40vh] max-w-full object-contain" />
            </div>
          )}
          <pre className={`max-h-[60vh] overflow-auto rounded-md bg-subtle p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all select-text ${view.kind === 'null' ? 'text-null italic' : ''}`}>
            {shown}
          </pre>
        </>
      )}
    </Modal>
  )
}

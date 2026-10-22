import { useMemo, useState } from 'react'
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
  open(value: CellValue, title: string, dataType?: string): void
  close(): void
}

export const useCellViewer = create<ViewerState>((set) => ({
  open: (value, title, dataType) => set({ value, title, dataType }),
  close: () => set({ value: undefined, title: undefined, dataType: undefined }),
}))

export const openCellViewer = (value: CellValue, title: string, dataType?: string) => useCellViewer.getState().open(value, title, dataType)

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
  const { value, title, dataType, close } = useCellViewer()
  const [mode, setMode] = useState<'pretty' | 'raw'>('pretty')
  const open = value !== undefined
  const view = useMemo(() => {
    if (value === undefined || value === null) return { kind: 'null' as const, text: 'NULL' }
    if (isBinaryValue(value)) return { kind: 'binary' as const, text: hexDump(value.$binary), size: value.length }
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
            {view.kind === 'binary' ? t('{n} bytes', { n: formatCount(view.size ?? 0) }) : t('{n} characters', { n: formatCount(shown?.length ?? 0) })}
          </span>
          <div className="flex-1" />
          {view.kind === 'json' && (
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
        </>
      }
    >
      <pre className={`max-h-[60vh] overflow-auto rounded-md bg-subtle p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all select-text ${view.kind === 'null' ? 'text-null italic' : ''}`}>
        {shown}
      </pre>
    </Modal>
  )
}

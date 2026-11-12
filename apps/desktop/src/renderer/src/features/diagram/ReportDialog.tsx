import { useState } from 'react'
import type { DictionaryReport } from '@dbmastermind/core/browser'
import { Button } from '@/components/ui/Button'
import { Checkbox, Input, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { useT } from '@/lib/i18n'

const PARTS = [
  ['referencedBy', 'Referenced by'],
  ['indexes', 'Indexes'],
  ['checks', 'Checks'],
  ['remarks', 'Notes'],
  ['properties', 'Properties'],
  ['labels', 'Labels'],
  ['todo', 'To do'],
  ['definition', 'Definitions of views'],
] as const

/** Remembered between reports (per computer): what a report holds and its title page facts. */
const KEY = 'dbm.report'
const remembered = (): Partial<DictionaryReport & { title: string; image: boolean }> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
}

/**
 * A report of the model as DeZign makes one (HTML): the title page (title, author, company, version, a
 * description), which parts each table's chapter holds, an image of the diagram, the report's color and order.
 */
export function ReportDialog({
  title: initialTitle,
  onClose,
  onExport,
}: {
  title: string
  onClose: () => void
  onExport: (title: string, report: DictionaryReport, image: boolean) => void
}) {
  const t = useT()
  const saved = remembered()
  const [title, setTitle] = useState(initialTitle)
  const [report, setReport] = useState<DictionaryReport>({
    author: saved.author,
    company: saved.company,
    version: saved.version,
    include: saved.include ?? {},
    accent: saved.accent ?? '#5b4fe0',
    modelOrder: saved.modelOrder,
  })
  const [image, setImage] = useState(saved.image ?? true)
  const set = (patch: Partial<DictionaryReport>) => setReport((r) => ({ ...r, ...patch }))
  const field = (label: string, key: 'author' | 'company' | 'version') => (
    <label className="flex flex-col gap-1">
      <span className="text-[11.5px] font-medium text-fg-muted">{t(label)}</span>
      <Input
        inputSize="sm"
        value={report[key] ?? ''}
        onChange={(e) => set({ [key]: e.target.value || undefined })}
        data-testid={`report-${key}`}
      />
    </label>
  )
  return (
    <Modal
      open
      onClose={onClose}
      title={t('Report')}
      width={620}
      footer={
        <>
          <div className="flex-1" />
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button
            variant="primary"
            disabled={!title.trim()}
            onClick={() => {
              try {
                localStorage.setItem(KEY, JSON.stringify({ ...report, description: undefined, image }))
              } catch {
                // (Remembering is a convenience.)
              }
              onExport(title.trim(), report, image)
            }}
            data-testid="report-export"
          >
            {t('Export')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11.5px] font-medium text-fg-muted">{t('Title')}</span>
          <Input
            inputSize="sm"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            data-testid="report-title"
          />
        </label>
        <div className="grid grid-cols-3 gap-2">
          {field('Author', 'author')}
          {field('Company', 'company')}
          {field('Version', 'version')}
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-[11.5px] font-medium text-fg-muted">{t('Description')}</span>
          <Textarea
            rows={3}
            className="text-[12.5px]"
            value={report.description ?? ''}
            onChange={(e) => set({ description: e.target.value || undefined })}
            data-testid="report-description"
          />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-[11.5px] font-medium text-fg-muted">
            {t('Each table shows its columns and')}
          </span>
          <div className="grid grid-cols-3 gap-1.5">
            {PARTS.map(([key, label]) => (
              <Checkbox
                key={key}
                checked={report.include?.[key] !== false}
                onChange={(on) => set({ include: { ...report.include, [key]: on } })}
                label={<span className="text-[12px]">{t(label)}</span>}
              />
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Checkbox
            checked={image}
            onChange={setImage}
            label={<span className="text-[12px]">{t('Image of the diagram')}</span>}
          />
          <Checkbox
            checked={!!report.modelOrder}
            onChange={(on) => set({ modelOrder: on || undefined })}
            label={<span className="text-[12px]">{t('In the model’s order (not by name)')}</span>}
          />
          <label className="flex items-center gap-1.5 text-[12px]">
            {t('Color')}
            <input
              type="color"
              value={report.accent ?? '#5b4fe0'}
              onChange={(e) => set({ accent: e.target.value })}
              className="h-6 w-8 cursor-pointer rounded border border-line bg-transparent"
            />
          </label>
        </div>
      </div>
    </Modal>
  )
}

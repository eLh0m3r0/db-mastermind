import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { useT } from '@/lib/i18n'

export type Around = { create: [string, string]; alter: [string, string] }

/**
 * The scripts a DeZign project puts before and after the SQL it generates (DeZign's project settings: begin and
 * end of the CREATE script and of the ALTER script). They go into the scripts made here and back into the project.
 */
export function ProjectScriptsModal({ around, onClose, onApply }: { around?: Around; onClose: () => void; onApply: (around: Around) => void }) {
  const t = useT()
  const [value, setValue] = useState<Around>(around ?? { create: ['', ''], alter: ['', ''] })
  const field = (kind: 'create' | 'alter', i: 0 | 1, label: string, testId: string) => (
    <label className="flex flex-col gap-1">
      <span className="text-[11.5px] font-medium text-fg-muted">{label}</span>
      <Textarea
        rows={4}
        className="font-mono text-[12px]"
        value={value[kind][i]}
        onChange={(e) => setValue({ ...value, [kind]: (i === 0 ? [e.target.value, value[kind][1]] : [value[kind][0], e.target.value]) as [string, string] })}
        data-testid={testId}
      />
    </label>
  )
  return (
    <Modal
      open
      onClose={onClose}
      title={t('Project scripts')}
      width={720}
      footer={
        <>
          <div className="flex-1" />
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" onClick={() => onApply(value)} data-testid="project-scripts-ok">
            OK
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[12px] text-fg-muted">{t('SQL the project puts before and after the scripts generated from it. Saved into the project.')}</p>
      <div className="grid grid-cols-2 gap-3">
        {field('create', 0, t('Before the CREATE script'), 'script-create-begin')}
        {field('create', 1, t('After the CREATE script'), 'script-create-end')}
        {field('alter', 0, t('Before an ALTER script'), 'script-alter-begin')}
        {field('alter', 1, t('After an ALTER script'), 'script-alter-end')}
      </div>
    </Modal>
  )
}

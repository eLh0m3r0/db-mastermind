import { useMemo, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { batchRename, type BatchRename, type TableInfo } from '@dbmastermind/core/browser'
import { Button } from '@/components/ui/Button'
import { Checkbox, Input, Segmented } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/**
 * DeZign's batch renaming tool: a text or a regular expression replaced in the names of tables, columns or both,
 * with every rename shown before it is done. Keys, indexes, relationships and checks follow the new names.
 */
export function BatchRenameModal({
  tables,
  onClose,
  onApply,
}: {
  tables: TableInfo[]
  onClose: () => void
  onApply: (tables: TableInfo[], renames: BatchRename[]) => void
}) {
  const t = useT()
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')
  const [regex, setRegex] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [scope, setScope] = useState<'tables' | 'columns' | 'both'>('both')
  const result = useMemo(
    () => batchRename(tables, { find, replace, regex, caseSensitive, scope }),
    [tables, find, replace, regex, caseSensitive, scope],
  )
  const done = result.renames.filter((r) => !r.skipped)
  return (
    <Modal
      open
      onClose={onClose}
      title={t('Rename tables and columns')}
      width={720}
      footer={
        <>
          <span className="text-[12px] text-fg-muted">{t('{n} renames', { n: String(done.length) })}</span>
          <div className="flex-1" />
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button
            variant="primary"
            disabled={!done.length}
            onClick={() => onApply(result.tables, done)}
            data-testid="batch-rename-ok"
          >
            {t('Rename')}
          </Button>
        </>
      }
    >
      <div className="mb-3 grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[11.5px] font-medium text-fg-muted">{t('Find')}</span>
          <Input
            inputSize="sm"
            className="font-mono"
            value={find}
            onChange={(e) => setFind(e.target.value)}
            placeholder={regex ? '^tbl_' : 'tbl_'}
            data-testid="batch-find"
            autoFocus
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11.5px] font-medium text-fg-muted">{t('Replace with')}</span>
          <Input
            inputSize="sm"
            className="font-mono"
            value={replace}
            onChange={(e) => setReplace(e.target.value)}
            data-testid="batch-replace"
          />
        </label>
      </div>
      <div className="mb-3 flex items-center gap-4">
        <Segmented<'tables' | 'columns' | 'both'>
          value={scope}
          onChange={setScope}
          options={[
            { value: 'both', label: t('Tables and columns') },
            { value: 'tables', label: t('Tables') },
            { value: 'columns', label: t('Columns') },
          ]}
        />
        <Checkbox
          checked={regex}
          onChange={setRegex}
          label={<span className="text-[12px]">{t('Regular expression')}</span>}
        />
        <Checkbox
          checked={caseSensitive}
          onChange={setCaseSensitive}
          label={<span className="text-[12px]">{t('Match case')}</span>}
        />
      </div>
      <div className="h-[40vh] overflow-auto rounded-md border border-line" data-testid="batch-preview">
        {!find && (
          <div className="p-3 text-[12px] text-fg-faint">
            {t('Type what to find: the renames show here before anything changes.')}
          </div>
        )}
        {find && !result.renames.length && (
          <div className="p-3 text-[12px] text-fg-faint">{t('No name matches.')}</div>
        )}
        {result.renames.map((r, i) => (
          <div
            key={i}
            className={cn(
              'flex items-center gap-2 border-b border-line px-2 py-1 font-mono text-[12px]',
              r.skipped && 'text-fg-faint line-through',
            )}
          >
            <span className="w-14 shrink-0 font-sans text-[11px] text-fg-muted">
              {r.kind === 'table' ? t('table') : t('column')}
            </span>
            <span className="truncate">{r.kind === 'column' ? `${r.table}.${r.from}` : r.from}</span>
            <ArrowRight size={11} className="shrink-0 text-fg-faint" />
            <span className="truncate">{r.to || '∅'}</span>
            {r.skipped && (
              <span className="ml-auto shrink-0 font-sans text-[11px] no-underline">
                {r.skipped === 'taken' ? t('name taken') : t('empty name')}
              </span>
            )}
          </div>
        ))}
      </div>
    </Modal>
  )
}

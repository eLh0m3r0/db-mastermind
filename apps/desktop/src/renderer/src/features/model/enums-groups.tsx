import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { TableInfo } from '@dbmastermind/core/browser'
import { Button, IconButton } from '@/components/ui/Button'
import { Checkbox, Input, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/**
 * The model's enums (named lists of values a column may hold), edited without typing DBML. A renamed enum renames
 * the type of the columns that use it; an enum columns use can't be removed.
 */
export function EnumsModal({ enums, tables, onClose, onApply }: { enums: Record<string, string[]>; tables: TableInfo[]; onClose: () => void; onApply: (enums: Record<string, string[]>, renamed: Record<string, string>) => void }) {
  const t = useT()
  const [rows, setRows] = useState(Object.entries(enums).map(([name, values]) => ({ was: name, name, values: values.join('\n') })))
  const used = (name: string) => tables.some((x) => x.columns.some((c) => c.dataType === name))
  const names = rows.map((r) => r.name.trim().toLowerCase())
  const invalid = rows.some((r, i) => !/^[A-Za-z_][\w$]*$/.test(r.name.trim()) || !r.values.trim() || names.indexOf(r.name.trim().toLowerCase()) !== i)
  return (
    <Modal
      open
      onClose={onClose}
      title={t('Enums')}
      width={620}
      footer={
        <>
          <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={() => setRows([...rows, { was: '', name: `enum_${rows.length + 1}`, values: '' }])} data-testid="enum-add">
            {t('New enum')}
          </Button>
          <div className="flex-1" />
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button
            variant="primary"
            disabled={invalid}
            onClick={() =>
              onApply(
                Object.fromEntries(rows.map((r) => [r.name.trim(), r.values.split(/[\n,]/).map((v) => v.trim()).filter(Boolean)])),
                Object.fromEntries(rows.filter((r) => r.was && r.was !== r.name.trim()).map((r) => [r.was, r.name.trim()])),
              )
            }
            data-testid="enums-ok"
          >
            OK
          </Button>
        </>
      }
    >
      <p className="mb-2 text-[12px] text-fg-muted">{t('A list of values a column may hold, used as its type. One value per line.')}</p>
      <div className="flex max-h-[55vh] flex-col gap-2 overflow-auto">
        {rows.map((row, i) => (
          <div key={i} className="flex items-start gap-2 rounded-md border border-line p-2">
            <Input inputSize="sm" className="w-44 font-mono text-[12px]" value={row.name} placeholder={t('Name')} onChange={(e) => setRows(rows.map((r, k) => (k === i ? { ...r, name: e.target.value } : r)))} data-testid={`enum-name-${i}`} />
            <Textarea rows={3} className="flex-1 font-mono text-[12px]" value={row.values} placeholder={t('Values, one per line')} onChange={(e) => setRows(rows.map((r, k) => (k === i ? { ...r, values: e.target.value } : r)))} data-testid={`enum-values-${i}`} />
            <IconButton label={row.was && used(row.was) ? t('Columns use this enum') : t('Remove')} disabled={!!row.was && used(row.was)} onClick={() => setRows(rows.filter((_, k) => k !== i))}>
              <Trash2 size={12} />
            </IconButton>
          </div>
        ))}
        {!rows.length && <div className="text-[12px] text-fg-faint">{t('The model has no enums yet.')}</div>}
      </div>
    </Modal>
  )
}

/** The model's table groups (DBML `TableGroup`, shown as areas of the diagram), edited without typing DBML. */
export function GroupsModal({ groups, tables, onClose, onApply }: { groups: Record<string, string[]>; tables: TableInfo[]; onClose: () => void; onApply: (groups: Record<string, string[]>) => void }) {
  const t = useT()
  const [rows, setRows] = useState(Object.entries(groups).map(([name, members]) => ({ name, members: new Set(members) })))
  const [open, setOpen] = useState(0)
  const names = rows.map((r) => r.name.trim().toLowerCase())
  const invalid = rows.some((r, i) => !r.name.trim() || names.indexOf(r.name.trim().toLowerCase()) !== i)
  const all = [...new Set(tables.filter((x) => x.type !== 'view').map((x) => x.name))].sort()
  return (
    <Modal
      open
      onClose={onClose}
      title={t('Table groups')}
      width={620}
      footer={
        <>
          <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={() => { setRows([...rows, { name: `group_${rows.length + 1}`, members: new Set() }]); setOpen(rows.length) }} data-testid="group-add">
            {t('New group')}
          </Button>
          <div className="flex-1" />
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={invalid} onClick={() => onApply(Object.fromEntries(rows.map((r) => [r.name.trim(), all.filter((n) => r.members.has(n))])))} data-testid="groups-ok">
            OK
          </Button>
        </>
      }
    >
      <div className="flex h-[50vh] gap-2">
        <div className="flex w-48 shrink-0 flex-col gap-1 overflow-auto">
          {rows.map((r, i) => (
            <div key={i} className={cn('flex items-center gap-1 rounded-md border p-1', i === open ? 'border-accent bg-accent-soft' : 'border-line')} onClick={() => setOpen(i)}>
              <Input inputSize="sm" className="h-6 min-w-0 flex-1 text-[12px]" value={r.name} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} data-testid={`group-name-${i}`} />
              <IconButton label={t('Remove')} onClick={() => setRows(rows.filter((_, k) => k !== i))}>
                <Trash2 size={12} />
              </IconButton>
            </div>
          ))}
          {!rows.length && <div className="text-[12px] text-fg-faint">{t('The model has no table groups yet.')}</div>}
        </div>
        {rows[open] && (
          <div className="min-w-0 flex-1 overflow-auto rounded-md border border-line p-2">
            {all.map((name) => (
              <div key={name} className="py-0.5">
                <Checkbox
                  checked={rows[open]!.members.has(name)}
                  onChange={(on) => setRows(rows.map((x, k) => (k === open ? { ...x, members: new Set(on ? [...x.members, name] : [...x.members].filter((m) => m !== name)) } : x)))}
                  label={<span className="font-mono text-[12px]">{name}</span>}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

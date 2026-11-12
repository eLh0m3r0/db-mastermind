import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button, IconButton } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { useT } from '@/lib/i18n'
import { dezignDomainsOfModel, withDezignDomains } from '@dbmastermind/core/browser'

/** A domain of a DeZign project: a named type that columns follow (`[domain: 'name']`). */
export interface ModelDomainDef {
  name: string
  dataType: string
}

// The model's domains note is its list of domains (core: dezignDomainsOfModel).
export const domainsOfText = (text: string): ModelDomainDef[] => dezignDomainsOfModel(text)
export const withDomains = (text: string, domains: ModelDomainDef[]): string => withDezignDomains(text, domains)

/**
 * The project's domains: a new type for one of them goes to every column that follows it (as DeZign propagates
 * it), and new domains can be made. Domains are not removed here: a column may still follow one in DeZign.
 */
export function DomainsModal({ open, domains, onClose, onApply }: { open: boolean; domains: ModelDomainDef[]; onClose: () => void; onApply: (domains: ModelDomainDef[]) => void }) {
  const t = useT()
  const [rows, setRows] = useState<(ModelDomainDef & { known: boolean })[]>([])
  const [shown, setShown] = useState(false)
  // Set during render when the dialog opens, so it starts from the model's current domains.
  if (open !== shown) {
    setShown(open)
    if (open) setRows(domains.map((d) => ({ ...d, known: true })))
  }
  const names = rows.map((r) => r.name.trim().toLowerCase())
  const invalid = rows.some((r, i) => !r.name.trim() || !r.dataType.trim() || names.indexOf(r.name.trim().toLowerCase()) !== i)
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('Domains')}
      width={560}
      footer={
        <>
          <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={() => setRows([...rows, { name: '', dataType: 'varchar(50)', known: false }])} data-testid="domain-add">
            {t('New domain')}
          </Button>
          <div className="flex-1" />
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={invalid} onClick={() => onApply(rows.map(({ name, dataType }) => ({ name: name.trim(), dataType: dataType.trim() })))} data-testid="domain-apply">
            {t('Apply')}
          </Button>
        </>
      }
    >
      <p className="mb-2 text-[12px] text-fg-muted">{t('A domain is a named type columns follow. A new type here changes every column that follows the domain, as in DeZign.')}</p>
      <div className="flex max-h-[50vh] flex-col gap-1 overflow-auto">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input inputSize="sm" className="flex-1 font-mono text-[12px]" value={row.name} disabled={row.known} placeholder={t('Name')} onChange={(e) => setRows(rows.map((r, k) => (k === i ? { ...r, name: e.target.value } : r)))} data-testid={`domain-name-${i}`} />
            <Input inputSize="sm" className="w-48 font-mono text-[12px]" value={row.dataType} onChange={(e) => setRows(rows.map((r, k) => (k === i ? { ...r, dataType: e.target.value } : r)))} data-testid={`domain-type-${i}`} />
            {!row.known ? (
              <IconButton label={t('Remove')} onClick={() => setRows(rows.filter((_, k) => k !== i))}>
                <Trash2 size={12} />
              </IconButton>
            ) : (
              <span className="w-6" />
            )}
          </div>
        ))}
        {!rows.length && <div className="text-[12px] text-fg-faint">{t('The project has no domains yet.')}</div>}
      </div>
    </Modal>
  )
}

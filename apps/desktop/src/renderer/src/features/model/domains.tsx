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
  /** The name it had in the project: a domain renamed. */
  was?: string
}

// The model's domains note is its list of domains (core: dezignDomainsOfModel).
export const domainsOfText = (text: string): ModelDomainDef[] => dezignDomainsOfModel(text)
export const withDomains = (text: string, domains: ModelDomainDef[]): string => withDezignDomains(text, domains)

/**
 * The project's domains: a new type for one of them goes to every column that follows it (as DeZign propagates
 * it), domains are renamed (the columns follow) and made; one no column follows can be removed.
 */
export function DomainsModal({ open, domains, used, onClose, onApply }: { open: boolean; domains: ModelDomainDef[]; /** Domains columns follow (they can't be removed). */ used?: Set<string>; onClose: () => void; onApply: (domains: ModelDomainDef[], removed: string[]) => void }) {
  const t = useT()
  const [rows, setRows] = useState<(ModelDomainDef & { known: boolean })[]>([])
  const [removed, setRemoved] = useState<string[]>([])
  const [shown, setShown] = useState(false)
  // Set during render when the dialog opens, so it starts from the model's current domains.
  if (open !== shown) {
    setShown(open)
    if (open) {
      setRows(domains.map((d) => ({ ...d, was: d.name, known: true })))
      setRemoved([])
    }
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
          <Button variant="primary" disabled={invalid} onClick={() => onApply(rows.map(({ name, dataType, was }) => ({ name: name.trim(), dataType: dataType.trim(), ...(was && was !== name.trim() ? { was } : {}) })), removed)} data-testid="domain-apply">
            {t('Apply')}
          </Button>
        </>
      }
    >
      <p className="mb-2 text-[12px] text-fg-muted">{t('A domain is a named type columns follow. A new type here changes every column that follows the domain.')}</p>
      <div className="flex max-h-[50vh] flex-col gap-1 overflow-auto">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input inputSize="sm" className="flex-1 font-mono text-[12px]" value={row.name} placeholder={t('Name')} onChange={(e) => setRows(rows.map((r, k) => (k === i ? { ...r, name: e.target.value } : r)))} data-testid={`domain-name-${i}`} />
            <Input inputSize="sm" className="w-48 font-mono text-[12px]" value={row.dataType} onChange={(e) => setRows(rows.map((r, k) => (k === i ? { ...r, dataType: e.target.value } : r)))} data-testid={`domain-type-${i}`} />
            {/* A domain columns follow stays: remove the columns' domain first. */}
            <IconButton
              label={row.known && used?.has((row.was ?? row.name).toLowerCase()) ? t('Columns follow this domain') : t('Remove')}
              disabled={row.known && !!used?.has((row.was ?? row.name).toLowerCase())}
              onClick={() => {
                if (row.known && row.was) setRemoved([...removed, row.was])
                setRows(rows.filter((_, k) => k !== i))
              }}
              data-testid={`domain-remove-${i}`}
            >
              <Trash2 size={12} />
            </IconButton>
          </div>
        ))}
        {!rows.length && <div className="text-[12px] text-fg-faint">{t('The project has no domains yet.')}</div>}
      </div>
    </Modal>
  )
}

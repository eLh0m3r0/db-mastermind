import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Copy, Info, ShieldAlert, TerminalSquare, XCircle } from 'lucide-react'
import { generateMigration, getDialect, impactChecks, migrationScript, type DriverId, type SchemaChange, type TableInfo } from '@dbmastermind/core/browser'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { api } from '@/lib/api'
import { cn, copyText, errorMessage, formatCount, uid } from '@/lib/utils'
import { toast } from '@/store/ui'
import { tp, useT } from '@/lib/i18n'

type CheckResult = { label: string; count?: number; error?: string }

export function MigrationModal({
  open,
  onClose,
  changes,
  driver,
  tables,
  connectionId,
  onOpenInEditor,
}: {
  open: boolean
  onClose: () => void
  changes: SchemaChange[]
  driver: DriverId
  tables: TableInfo[]
  connectionId: string
  onOpenInEditor: (sql: string) => void
}) {
  const dialect = getDialect(driver)
  const migration = useMemo(() => generateMigration(changes, dialect, tables), [changes, dialect, tables])
  const script = useMemo(() => migrationScript(migration, dialect), [migration, dialect])
  const rollback = useMemo(() => migration.rollback.map((s) => `${s};`).join('\n'), [migration])
  const [view, setView] = useState<'forward' | 'rollback'>('forward')
  const [checks, setChecks] = useState<CheckResult[] | null>(null)
  const [checking, setChecking] = useState(false)
  const t = useT()

  const runChecks = async () => {
    setChecking(true)
    const results: CheckResult[] = []
    for (const check of impactChecks(changes, dialect)) {
      try {
        const [outcome] = await api.runQuery({ connectionId, sql: check.sql, runId: uid('check') })
        if (outcome?.error) results.push({ label: check.label, error: outcome.error.message })
        else results.push({ label: check.label, count: Number(outcome?.results?.[0]?.rows[0]?.[0] ?? 0) })
      } catch (err) {
        results.push({ label: check.label, error: errorMessage(err) })
      }
    }
    setChecks(results)
    setChecking(false)
  }

  useEffect(() => {
    if (open) {
      setChecks(null)
      void runChecks()
    }
    // Re-run whenever the dialog opens with a new change set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, changes])

  const icon = { danger: <ShieldAlert size={13} className="text-danger" />, warning: <AlertTriangle size={13} className="text-warning" />, info: <Info size={13} className="text-info" /> }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${t('Migration')} · ${tp(changes.length, { one: '{n} change', many: '{n} changes' })}`}
      width={860}
      footer={
        <>
          <span className="text-[12px] text-fg-muted">
            {migration.transactional ? t('Runs in one transaction: if anything fails, nothing changes.') : t('MySQL/MariaDB apply DDL statement by statement.')}
          </span>
          <div className="flex-1" />
          <Button icon={<Copy size={13} />} onClick={() => void copyText(view === 'forward' ? script : rollback).then(() => toast({ kind: 'success', message: t('Copied') }))}>
            {t('Copy')}
          </Button>
          <Button variant="primary" icon={<TerminalSquare size={13} />} onClick={() => onOpenInEditor(script)} data-autofocus>
            {t('Open in SQL editor')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {migration.warnings.length > 0 && (
          <div className="flex flex-col gap-1 rounded-md border border-line p-2.5">
            {migration.warnings.map((w, i) => (
              <div key={i} className="flex items-start gap-2 text-[12px]">
                <span className="mt-px shrink-0">{icon[w.level]}</span>
                <span>{w.message}</span>
              </div>
            ))}
          </div>
        )}
        <div className="rounded-md border border-line p-2.5">
          <div className="mb-1.5 flex items-center gap-2 text-[12px] font-semibold">
            {t('Checks against current data')} {checking && <Spinner size={12} />}
          </div>
          {checks && checks.length === 0 && <div className="text-[12px] text-fg-faint">{t('Nothing to check for these changes.')}</div>}
          {checks?.map((c) => (
            <div key={c.label} className="flex items-center gap-2 text-[12px]">
              {c.error ? <XCircle size={13} className="text-fg-faint" /> : c.count === 0 ? <CheckCircle2 size={13} className="text-success" /> : <AlertTriangle size={13} className="text-danger" />}
              <span className="flex-1">{c.label}</span>
              <span className={cn('font-mono tabular-nums', c.count ? 'font-semibold text-danger' : 'text-fg-muted')}>{c.error ? t('could not check') : formatCount(c.count ?? 0)}</span>
            </div>
          ))}
        </div>
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'forward', label: t('Migration') },
            { value: 'rollback', label: t('Rollback') },
          ]}
        />
        <pre className="max-h-[42vh] overflow-auto rounded-md bg-subtle p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap select-text">
          {view === 'forward' ? script || `-- ${t('No changes')}` : rollback || `-- ${t('Nothing to roll back')}`}
        </pre>
      </div>
    </Modal>
  )
}

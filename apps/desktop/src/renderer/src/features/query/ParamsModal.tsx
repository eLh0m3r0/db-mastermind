import { useEffect, useState } from 'react'
import type { QueryParameter } from '@dbmastermind/core/browser'
import { Button } from '@/components/ui/Button'
import { Checkbox, Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { useT } from '@/lib/i18n'

export type ParamValues = Record<string, string | null>

export const paramKey = (p: QueryParameter) => (p.kind === 'named' ? p.name : `$${p.name}`)

/** Asks for values of `:name` / `?` parameters before running; remembers the last values per tab. */
export function ParamsModal({
  params,
  initial,
  onRun,
  onCancel,
}: {
  params: QueryParameter[] | null
  initial: ParamValues
  onRun: (values: ParamValues) => void
  onCancel: () => void
}) {
  const t = useT()
  const [values, setValues] = useState<ParamValues>({})
  useEffect(() => {
    if (params) setValues(Object.fromEntries(params.map((p) => [paramKey(p), initial[paramKey(p)] ?? ''])))
  }, [params, initial])

  return (
    <Modal
      open={!!params}
      onClose={onCancel}
      title={t('Query parameters')}
      width={460}
      footer={
        <>
          <div className="flex-1" />
          <Button onClick={onCancel}>{t('Cancel')}</Button>
          <Button variant="primary" onClick={() => onRun(values)}>
            {t('Run')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          onRun(values)
        }}
      >
        {params?.map((p) => {
          const key = paramKey(p)
          const isNull = values[key] === null
          return (
            <div key={key} className="flex items-end gap-3">
              <label className="flex flex-1 flex-col gap-1">
                <span className="font-mono text-[12px] font-medium text-fg-muted">{p.kind === 'named' ? `:${p.name}` : `#${p.name}`}</span>
                <Input
                  className="font-mono text-[12px]"
                  value={isNull ? '' : (values[key] ?? '')}
                  placeholder={isNull ? 'NULL' : ''}
                  disabled={isNull}
                  onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                />
              </label>
              <div className="pb-1.5">
                <Checkbox checked={isNull} onChange={(on) => setValues((v) => ({ ...v, [key]: on ? null : '' }))} label="NULL" />
              </div>
            </div>
          )
        })}
        <p className="text-[11.5px] text-fg-faint">{t('Values are sent as bound parameters, never pasted into the SQL.')}</p>
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

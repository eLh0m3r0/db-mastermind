import type { DezignUserProperty } from '@dbmastermind/core/browser'
import { Input, Select } from '@/components/ui/Input'
import { useT } from '@/lib/i18n'

/**
 * The custom properties a project defines for a kind of object (DeZign's user defined properties: `Entity`,
 * `Attribute`…), edited as DeZign shows them: text, a number, yes/no, or a value from the property's list.
 */
export function PropertiesEditor({
  definitions,
  objectType,
  values,
  onChange,
  compact,
}: {
  definitions: DezignUserProperty[]
  objectType: string
  values: Record<string, string> | undefined
  onChange: (values: Record<string, string> | undefined) => void
  compact?: boolean
}) {
  const t = useT()
  const mine = definitions.filter((d) =>
    d.objectTypes.some((x) => x.toLowerCase() === objectType.toLowerCase()),
  )
  if (!mine.length) return null
  const set = (name: string, value: string) => {
    const next = { ...(values ?? {}) }
    if (value === '') delete next[name]
    else next[name] = value
    onChange(Object.keys(next).length ? next : undefined)
  }
  const groups = [...new Set(mine.map((d) => d.group ?? ''))]
  return (
    <div
      className={compact ? 'flex flex-col gap-1' : 'flex flex-col gap-3'}
      data-testid={`properties-${objectType.toLowerCase()}`}
    >
      {groups.map((g) => (
        <div key={g} className="flex flex-col gap-1">
          {g && !compact && (
            <span className="text-[11px] font-semibold tracking-wide text-fg-muted uppercase">{g}</span>
          )}
          {mine
            .filter((d) => (d.group ?? '') === g)
            .map((d) => {
              const value = values?.[d.name] ?? ''
              const type = d.type.toLowerCase()
              return (
                <label key={d.id} className="grid grid-cols-[minmax(0,10rem)_1fr] items-center gap-2">
                  <span className="truncate text-[12px] text-fg-muted" title={d.name}>
                    {d.name}
                  </span>
                  {type === 'value from list' || type === 'yes/no' ? (
                    <Select
                      inputSize="sm"
                      className="h-7 text-[12px]"
                      value={value}
                      onChange={(e) => set(d.name, e.target.value)}
                      data-testid={`property-${d.name}`}
                    >
                      <option value="">{t('(not set)')}</option>
                      {(type === 'yes/no'
                        ? ['Yes', 'No']
                        : [...d.values, ...(value && !d.values.includes(value) ? [value] : [])]
                      ).map((v) => (
                        <option key={v} value={v}>
                          {type === 'yes/no' ? t(v) : v}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      inputSize="sm"
                      className="h-7 text-[12px]"
                      type={type === 'number' ? 'number' : 'text'}
                      value={value}
                      onChange={(e) => set(d.name, e.target.value)}
                      data-testid={`property-${d.name}`}
                    />
                  )}
                </label>
              )
            })}
        </div>
      ))}
    </div>
  )
}

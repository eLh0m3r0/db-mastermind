import { Tag } from 'lucide-react'
import type { DezignLabel } from '@dbmastermind/core/browser'
import { cn } from '@/lib/utils'

/** DeZign's label colors: a Delphi name or `$00BBGGRR`, as a CSS color. */
const NAMED: Record<string, string> = {
  clred: '#d64545',
  clgreen: '#2f9e44',
  clblue: '#3b6fd8',
  clyellow: '#e0b100',
  clmaroon: '#8b2b2b',
  clnavy: '#24407a',
  clpurple: '#7b3fa0',
  clteal: '#13877c',
  clolive: '#7a7a1f',
  clfuchsia: '#c2389e',
  claqua: '#1fa7c4',
  cllime: '#5cb82e',
  clgray: '#7a7a7a',
  clblack: '#333333',
}
export const labelColor = (color?: string) => {
  if (!color) return undefined
  const hex = /^\$00([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color)
  return hex ? `#${hex[3]}${hex[2]}${hex[1]}` : NAMED[color.toLowerCase()]
}

/**
 * The labels a project defines (DeZign's labels, e.g. "PII"), put on an object or taken off with a click. Labels
 * themselves are made in DeZign.
 */
export function LabelsPicker({
  labels,
  value,
  onChange,
  testId,
}: {
  labels: DezignLabel[]
  value: string[] | undefined
  onChange: (value: string[] | undefined) => void
  testId?: string
}) {
  if (!labels.length) return null
  const on = new Set((value ?? []).map((v) => v.toLowerCase()))
  const toggle = (name: string) => {
    const next = on.has(name.toLowerCase())
      ? (value ?? []).filter((v) => v.toLowerCase() !== name.toLowerCase())
      : [...(value ?? []), name]
    onChange(next.length ? next : undefined)
  }
  return (
    <div className="flex flex-wrap gap-1" data-testid={testId}>
      {labels.map((l) => {
        const active = on.has(l.name.toLowerCase())
        return (
          <button
            key={l.id}
            type="button"
            onClick={() => toggle(l.name)}
            className={cn(
              'flex h-6 items-center gap-1 rounded-full border px-2 text-[11.5px]',
              active ? 'border-accent bg-accent-soft text-fg' : 'border-line text-fg-muted hover:bg-subtle',
            )}
            aria-pressed={active}
            data-testid={`label-${l.name}`}
          >
            <Tag size={10} style={{ color: labelColor(l.color) }} />
            {l.name}
          </button>
        )
      })}
    </div>
  )
}

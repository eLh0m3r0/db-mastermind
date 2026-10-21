import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const field =
  'w-full rounded-md border border-line bg-bg px-2.5 text-[13px] text-fg placeholder:text-fg-faint ' +
  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft disabled:opacity-60'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  leading?: ReactNode
  trailing?: ReactNode
  inputSize?: 'sm' | 'md'
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, leading, trailing, inputSize = 'md', ...rest },
  ref,
) {
  const height = inputSize === 'sm' ? 'h-7' : 'h-8'
  if (!leading && !trailing) return <input ref={ref} className={cn(field, height, className)} {...rest} />
  return (
    <div className={cn('relative flex items-center', className)}>
      {leading && <span className="pointer-events-none absolute left-2 flex text-fg-faint">{leading}</span>}
      <input ref={ref} className={cn(field, height, leading && 'pl-7', trailing && 'pr-7')} {...rest} />
      {trailing && <span className="absolute right-1.5 flex">{trailing}</span>}
    </div>
  )
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={cn(field, 'py-1.5 leading-snug', className)} {...rest} />
})

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { inputSize?: 'sm' | 'md' }>(
  function Select({ className, children, inputSize = 'md', ...rest }, ref) {
    return (
      <select ref={ref} className={cn(field, inputSize === 'sm' ? 'h-7' : 'h-8', 'pr-6', className)} {...rest}>
        {children}
      </select>
    )
  },
)

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: ReactNode
  hint?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <label className={cn('flex flex-col gap-1', className)}>
      <span className="text-[12px] font-medium text-fg-muted">{label}</span>
      {children}
      {hint && <span className="text-[11.5px] text-fg-faint">{hint}</span>}
    </label>
  )
}

export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  hint?: ReactNode
  disabled?: boolean
}) {
  return (
    <label className={cn('flex items-start gap-2', disabled && 'opacity-60')}>
      <input
        type="checkbox"
        className="mt-[2px] h-3.5 w-3.5 accent-[var(--accent)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="flex flex-col">
        <span className="text-[13px]">{label}</span>
        {hint && <span className="text-[11.5px] text-fg-faint">{hint}</span>}
      </span>
    </label>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line bg-subtle px-1 font-sans text-[10.5px] text-fg-muted">
      {children}
    </kbd>
  )
}

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'warning' | 'danger' | 'success'; className?: string }) {
  const tones = {
    neutral: 'bg-muted text-fg-muted',
    accent: 'bg-accent-soft text-accent',
    warning: 'bg-warning-soft text-warning',
    danger: 'bg-danger-soft text-danger',
    success: 'bg-success-soft text-success',
  }
  return (
    <span className={cn('inline-flex h-[18px] items-center rounded px-1.5 text-[11px] font-medium', tones[tone], className)}>
      {children}
    </span>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'sm',
}: {
  value: T
  options: { value: T; label: ReactNode; title?: string }[]
  onChange: (value: T) => void
  size?: 'xs' | 'sm'
}) {
  return (
    <div className="inline-flex rounded-md bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-[5px] px-2 font-medium transition-colors',
            size === 'xs' ? 'h-5 text-[11px]' : 'h-6 text-[12px]',
            value === o.value ? 'bg-elevated text-fg shadow-sm' : 'text-fg-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

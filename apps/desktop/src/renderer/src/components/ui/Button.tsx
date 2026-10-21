import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Spinner } from './Spinner'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle'
type Size = 'xs' | 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  icon?: ReactNode
  loading?: boolean
}

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover border-transparent shadow-sm',
  secondary: 'bg-elevated text-fg border-line hover:bg-hover shadow-[0_1px_1px_rgba(0,0,0,0.04)]',
  ghost: 'bg-transparent text-fg-muted border-transparent hover:bg-hover hover:text-fg',
  subtle: 'bg-muted text-fg border-transparent hover:bg-active',
  danger: 'bg-danger text-white border-transparent hover:opacity-90',
}

const sizes: Record<Size, string> = {
  xs: 'h-6 px-2 text-[11.5px] gap-1 rounded',
  sm: 'h-7 px-2.5 text-[12.5px] gap-1.5 rounded-md',
  md: 'h-8 px-3.5 text-[13px] gap-2 rounded-md',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'sm', icon, loading, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center justify-center border font-medium whitespace-nowrap transition-colors select-none',
        'disabled:pointer-events-none disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={13} /> : icon}
      {children}
    </button>
  )
})

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  active?: boolean
  size?: 'sm' | 'md'
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, active, className, children, size = 'sm', type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors',
        'hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40',
        size === 'sm' ? 'h-6 w-6' : 'h-7 w-7',
        active && 'bg-active text-fg',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
})

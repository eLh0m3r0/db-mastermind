import { useCallback, useRef } from 'react'
import { cn } from '@/lib/utils'

/**
 * Drag handle that resizes a neighbouring panel. `onResize` receives the new size in px,
 * computed from the size at drag start plus the pointer delta (negated when `reverse`).
 */
export function Splitter({
  direction,
  size,
  onResize,
  min = 120,
  max = 1200,
  reverse = false,
  className,
}: {
  direction: 'horizontal' | 'vertical'
  size: number
  onResize: (size: number) => void
  min?: number
  max?: number
  reverse?: boolean
  className?: string
}) {
  const start = useRef<{ pos: number; size: number } | null>(null)
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      start.current = { pos: direction === 'horizontal' ? e.clientX : e.clientY, size }
      document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize'
    },
    [direction, size],
  )
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!start.current) return
      const pos = direction === 'horizontal' ? e.clientX : e.clientY
      const delta = (pos - start.current.pos) * (reverse ? -1 : 1)
      onResize(Math.min(max, Math.max(min, start.current.size + delta)))
    },
    [direction, reverse, min, max, onResize],
  )
  const onPointerUp = useCallback(() => {
    start.current = null
    document.body.style.cursor = ''
  }, [])
  return (
    <div
      role="separator"
      aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className={cn(
        'group relative z-10 shrink-0',
        direction === 'horizontal' ? '-mx-[3px] w-[7px] cursor-col-resize' : '-my-[3px] h-[7px] cursor-row-resize',
        className,
      )}
    >
      <div
        className={cn(
          'absolute bg-transparent transition-colors group-hover:bg-accent/60 group-active:bg-accent',
          direction === 'horizontal' ? 'inset-y-0 left-[3px] w-px' : 'inset-x-0 top-[3px] h-px',
        )}
      />
    </div>
  )
}

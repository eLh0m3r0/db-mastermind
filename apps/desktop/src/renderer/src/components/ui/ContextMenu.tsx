import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

export type MenuItem =
  | {
      label: string
      icon?: ReactNode
      shortcut?: string
      onClick?: () => void
      disabled?: boolean
      danger?: boolean
      checked?: boolean
      submenu?: MenuItem[]
    }
  | 'separator'

interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

const useMenu = create<{ menu?: MenuState; open(m: MenuState): void; close(): void }>((set) => ({
  open: (menu) => set({ menu }),
  close: () => set({ menu: undefined }),
}))

/** Opens a context menu at the pointer (or below an element when given one). */
export function openMenu(event: { clientX: number; clientY: number; preventDefault?: () => void } | HTMLElement, items: MenuItem[]) {
  if (event instanceof HTMLElement) {
    const r = event.getBoundingClientRect()
    useMenu.getState().open({ x: r.left, y: r.bottom + 4, items })
    return
  }
  event.preventDefault?.()
  useMenu.getState().open({ x: event.clientX, y: event.clientY, items })
}

function MenuList({ items, x, y, onDone, level = 0 }: { items: MenuItem[]; x: number; y: number; onDone: () => void; level?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [sub, setSub] = useState<{ index: number; x: number; y: number } | null>(null)
  const [focus, setFocus] = useState(-1)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: x + r.width > window.innerWidth - 4 ? Math.max(4, (level ? x - r.width - 180 : window.innerWidth - r.width - 4)) : x,
      y: y + r.height > window.innerHeight - 4 ? Math.max(4, window.innerHeight - r.height - 4) : y,
    })
  }, [x, y, level])

  useEffect(() => {
    if (level !== 0) return
    const onKey = (e: KeyboardEvent) => {
      const selectable = items.map((it, i) => (it !== 'separator' && !it.disabled ? i : -1)).filter((i) => i >= 0)
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const current = selectable.indexOf(focus)
        const next = e.key === 'ArrowDown' ? (current + 1) % selectable.length : (current - 1 + selectable.length) % selectable.length
        setFocus(selectable[next] ?? -1)
      } else if (e.key === 'Enter' && focus >= 0) {
        e.preventDefault()
        const item = items[focus]
        if (item && item !== 'separator' && !item.submenu) {
          onDone()
          item.onClick?.()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, focus, onDone, level])

  return (
    <div
      ref={ref}
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-[60] min-w-[190px] rounded-lg border border-line bg-elevated p-1 shadow-pop"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item === 'separator' ? (
          <div key={i} className="my-1 h-px bg-line" />
        ) : (
          <button
            key={i}
            type="button"
            disabled={item.disabled}
            onMouseEnter={(e) => {
              setFocus(i)
              if (item.submenu) {
                const r = e.currentTarget.getBoundingClientRect()
                setSub({ index: i, x: r.right + 2, y: r.top - 4 })
              } else setSub(null)
            }}
            onClick={() => {
              if (item.submenu) return
              onDone()
              item.onClick?.()
            }}
            className={cn(
              'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px]',
              'disabled:opacity-40',
              focus === i && 'bg-hover',
              item.danger ? 'text-danger' : 'text-fg',
            )}
          >
            <span className="flex w-4 justify-center text-fg-muted">{item.checked ? '✓' : item.icon}</span>
            <span className="flex-1 truncate">{item.label}</span>
            {item.shortcut && <span className="pl-4 text-[11px] text-fg-faint">{item.shortcut}</span>}
            {item.submenu && <ChevronRight size={13} className="text-fg-faint" />}
          </button>
        ),
      )}
      {sub && items[sub.index] !== 'separator' && (items[sub.index] as { submenu?: MenuItem[] }).submenu && (
        <MenuList items={(items[sub.index] as { submenu: MenuItem[] }).submenu} x={sub.x} y={sub.y} onDone={onDone} level={level + 1} />
      )}
    </div>
  )
}

export function ContextMenuHost() {
  const { menu, close } = useMenu()
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.fixed.z-\\[60\\]')) close()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    const t = setTimeout(() => {
      window.addEventListener('mousedown', onDown)
      window.addEventListener('blur', close)
      window.addEventListener('resize', close)
    })
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(t)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [menu, close])
  if (!menu) return null
  return createPortal(<MenuList items={menu.items} x={menu.x} y={menu.y} onDone={close} />, document.body)
}

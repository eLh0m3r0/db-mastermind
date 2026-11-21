import { useLayoutEffect, useRef, useState } from 'react'

/** Extra room needed before a toolbar shows its labels again, so a width at the threshold doesn't flip it back and forth. */
const HYSTERESIS = 24

/**
 * The width a one-line flex row needs for its content: its fixed children, gaps and padding. Children that grow
 * (spacers) count with their minimum width, so the row's own width doesn't feed back into the answer.
 */
export function rowContentWidth(el: HTMLElement): number {
  const cs = getComputedStyle(el)
  const gap = parseFloat(cs.columnGap) || 0
  let width = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
  let count = 0
  for (const child of el.children) {
    const c = getComputedStyle(child)
    if (c.display === 'none' || c.position === 'absolute' || c.position === 'fixed') continue
    const margins = (parseFloat(c.marginLeft) || 0) + (parseFloat(c.marginRight) || 0)
    width += (parseFloat(c.flexGrow) > 0 ? parseFloat(c.minWidth) || 0 : (child as HTMLElement).getBoundingClientRect().width) + margins
    count++
  }
  return width + gap * Math.max(0, count - 1)
}

/**
 * How compact a one-line toolbar has to be: 0 shows every label, each higher level hides more of them (the caller
 * decides which). A level is left only when the row would overflow, and taken back only when the labels it hid fit
 * again with room to spare, as measured when they were last shown.
 */
export function useFitLevel<T extends HTMLElement>(maxLevel: number) {
  const ref = useRef<T>(null)
  const [level, setLevel] = useState(0)
  const levelRef = useRef(0)
  // saved[l]: what going from level l to l + 1 saved, in px; switching: the content width just before a switch.
  const saved = useRef<number[]>([])
  const switching = useRef<{ from: number; width: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => {
      const current = levelRef.current
      const need = rowContentWidth(el)
      const room = el.clientWidth
      const s = switching.current
      if (s && s.from === current - 1) {
        saved.current[s.from] = Math.max(0, s.width - need)
        switching.current = null
      }
      let next = current
      if (need > room + 0.5 && current < maxLevel) next = current + 1
      else if (current > 0 && saved.current[current - 1] !== undefined && need + saved.current[current - 1]! + HYSTERESIS <= room) next = current - 1
      if (next !== current) {
        if (next > current) switching.current = { from: current, width: need }
        levelRef.current = next
        setLevel(next)
      }
    }
    const resize = new ResizeObserver(check)
    const watch = () => {
      resize.disconnect()
      resize.observe(el)
      for (const child of el.children) resize.observe(child)
    }
    watch()
    // Buttons that come and go (Cancel for Run, the AI button) are watched too.
    const mutations = new MutationObserver(() => {
      watch()
      check()
    })
    mutations.observe(el, { childList: true })
    check()
    return () => {
      resize.disconnect()
      mutations.disconnect()
    }
  }, [maxLevel])

  return [ref, level] as const
}

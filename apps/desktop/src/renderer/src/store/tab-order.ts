const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The next numbered title from a template such as "Query {n}": one more than the highest number in use, so a new
 * tab never repeats the name of one still open (counting the tabs did after one in the middle was closed).
 */
export function nextNumberedTitle(titles: string[], template: string): string {
  const [before = '', after = ''] = template.split('{n}')
  const pattern = new RegExp(`^${escape(before)}(\\d+)${escape(after)}$`)
  let highest = 0
  for (const title of titles) {
    const m = pattern.exec(title)
    if (m) highest = Math.max(highest, Number(m[1]))
  }
  return `${before}${highest + 1}${after}`
}

/** Where a reopened tab goes back: its old place when it is still there to take, else the end. */
export function reopenIndex(index: number | undefined, length: number): number {
  if (index === undefined || !Number.isFinite(index)) return length
  return Math.min(Math.max(0, index), length)
}

/** The tabs on one side of `id`, in the strip's order (none when `id` is not there). */
export function tabsBeside(order: string[], id: string, side: 'left' | 'right'): string[] {
  const i = order.indexOf(id)
  if (i === -1) return []
  return side === 'left' ? order.slice(0, i) : order.slice(i + 1)
}

/**
 * Closing several tabs at once: the rightmost goes first, so each one's recorded place is right for reopening them
 * one by one with ⇧⌘T (the leftmost comes back first and every later one finds its place filled up to it). The
 * selected tab stays unless it was closed; then `keep` (the tab that was right-clicked) is selected.
 */
export function closeTabsPlan(order: string[], ids: string[], active: string | undefined, keep: string): { remaining: string[]; closed: { id: string; index: number }[]; active: string | undefined } {
  let remaining = [...order]
  const closed: { id: string; index: number }[] = []
  for (const id of [...ids].filter((x) => order.includes(x)).sort((a, b) => order.indexOf(b) - order.indexOf(a))) {
    closed.push({ id, index: remaining.indexOf(id) })
    remaining = remaining.filter((x) => x !== id)
  }
  return { remaining, closed, active: active && remaining.includes(active) ? active : keep }
}

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

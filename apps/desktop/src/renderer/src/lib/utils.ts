import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Joins class names; later Tailwind utilities override earlier conflicting ones (w-full vs w-24). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

let counter = 0
export function uid(prefix = 'id'): string {
  counter += 1
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function formatDuration(ms: number): string {
  if (ms < 1) return '<1 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m ${s}s`
}

/** 1.4 MB, 820 kB… */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['kB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US').replaceAll(',', ' ')
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${formatCount(n)} ${n === 1 ? word : pluralWord}`
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined
  const debounced = (...args: A) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
  debounced.flush = (...args: A) => {
    clearTimeout(t)
    fn(...args)
  }
  return debounced
}

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
}

/** Simple fuzzy matcher: all query characters appear in order. Returns a score (higher is better) or -1. */
export function fuzzyScore(text: string, query: string): number {
  if (!query) return 0
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  const direct = t.indexOf(q)
  if (direct === 0) return 1000 - t.length
  if (direct > 0) return 800 - direct - t.length / 10
  let ti = 0
  let score = 0
  let streak = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found === -1) return -1
    streak = found === ti ? streak + 1 : 0
    score += 10 + streak * 5 - (found - ti)
    ti = found + 1
  }
  return score - t.length / 10
}

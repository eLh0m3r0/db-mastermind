import { useSettings } from '@/store/settings'
import { formatCount } from './utils'
import { cs } from './i18n-cs'

type Vars = Record<string, string | number>

function fill(text: string, vars?: Vars): string {
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}

function isCzech(): boolean {
  return useSettings.getState().settings?.language === 'cs'
}

/** Translates an English source string; `{name}` placeholders are filled from vars. */
export function t(text: string, vars?: Vars): string {
  return fill((isCzech() && cs[text]) || text, vars)
}

export interface PluralForms {
  one: string
  /** Dictionary key of the Czech 2–4 form; defaults to `${many}|few`. Never shown in English. */
  few?: string
  many: string
}

/**
 * Plural-aware translation; `{n}` is filled with the count. English forms are the dictionary keys:
 * English uses one/many, Czech 1 → one, 2–4 → few, otherwise many.
 */
export function tp(count: number, forms: PluralForms, vars?: Vars): string {
  const all = { n: formatCount(count), ...vars }
  const base = count === 1 ? forms.one : forms.many
  if (!isCzech()) return fill(base, all)
  const abs = Math.abs(count)
  if (abs >= 2 && abs <= 4) {
    const few = cs[forms.few ?? `${forms.many}|few`]
    if (few) return fill(few, all)
  }
  return fill(cs[base] ?? base, all)
}

/** Subscribes the component to language changes and returns `t`. */
export function useT(): typeof t {
  useSettings((s) => s.settings?.language)
  return t
}

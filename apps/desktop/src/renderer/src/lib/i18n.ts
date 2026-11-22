import { useSettings } from '@/store/settings'
import { formatCount } from './utils'
import { cs, csParts, csPatterns } from './i18n-cs'

type Vars = Record<string, string | number>

function fill(text: string, vars?: Vars): string {
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}

function isCzech(): boolean {
  return useSettings.getState().settings?.language === 'cs'
}

function fromPatterns(text: string, patterns: [RegExp, string][]): string | undefined {
  for (const [pattern, czech] of patterns) {
    const m = pattern.exec(text)
    if (m) return czech.replace(/([$%])(\d)/g, (_, kind: string, i: string) => (kind === '$' ? m[Number(i)] ?? '' : csPart(m[Number(i)] ?? '')))
  }
  return undefined
}

/** A run-time part of a message in Czech (as it is when it has none). */
export function csPart(text: string): string {
  return cs[text] ?? fromPatterns(text, csParts) ?? text
}

/** Czech for a text with parts made at run time (an error naming a statement's first word), if it has one. */
export function csFromPattern(text: string): string | undefined {
  return fromPatterns(text, csPatterns)
}

/** Translates an English source string; `{name}` placeholders are filled from vars. */
export function t(text: string, vars?: Vars): string {
  return fill((isCzech() && (cs[text] ?? csFromPattern(text))) || text, vars)
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

/**
 * A date and/or time in the app's language: Czech dates in the Czech UI even on an English system. English follows
 * the system's own format.
 */
export function formatDate(value: string | number | Date, part: 'date' | 'time' | 'both' = 'both'): string {
  const date = new Date(value)
  const locale = isCzech() ? 'cs-CZ' : undefined
  if (part === 'date') return date.toLocaleDateString(locale)
  if (part === 'time') return date.toLocaleTimeString(locale)
  return date.toLocaleString(locale)
}

/** Subscribes the component to language changes and returns `t`. */
export function useT(): typeof t {
  useSettings((s) => s.settings?.language)
  return t
}

// Translation strings for the language voting feature
export const languageStrings = {
  'Language Requests': 'Language Requests',
  'Suggest a language or vote for existing requests to help prioritize translations.': 'Suggest a language or vote for existing requests to help prioritize translations.',
  'Suggest a new language...': 'Suggest a new language...',
  'Submit': 'Submit',
  'Vote': 'Vote',
  'votes': 'votes'
}

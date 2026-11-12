import type { TableInfo } from './types.js'

/**
 * DeZign's conditional generation: parts of code written for some situations only, between `{$IFDEF name}` (or
 * `{$IFNOTDEF name}`) and `{$ENDIF name}`, nested as needed. A script is made with the directives that apply; in
 * trigger, view and procedure code, check constraints and the scripts around a project's scripts.
 */
const TOKEN = /\{\$(IFDEF|IFNOTDEF|ENDIF)\s+([^}]*?)\s*\}/gi

/** The directives a text names (as written, the first spelling of each). */
export function generationDirectivesIn(...texts: (string | undefined | null)[]): string[] {
  const found = new Map<string, string>()
  for (const text of texts)
    for (const m of (text ?? '').matchAll(TOKEN))
      if (m[1]!.toUpperCase() !== 'ENDIF' && m[2])
        found.set(m[2].toLowerCase(), found.get(m[2].toLowerCase()) ?? m[2])
  return [...found.values()]
}

/** The text with the parts its directives leave out taken away, and the directives themselves. */
export function applyGenerationDirectives(text: string, defined: string[]): string {
  if (!/\{\$(IFDEF|IFNOTDEF)/i.test(text)) return text
  const on = new Set(defined.map((d) => d.toLowerCase()))
  const stack: boolean[] = []
  let out = ''
  let at = 0
  const keeping = () => stack.every(Boolean)
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index!
    let end = start + m[0].length
    // A directive alone on its line takes its line with it.
    const lineStart = text.lastIndexOf('\n', start - 1) + 1
    const lineEnd = text.indexOf('\n', end)
    const alone =
      !text.slice(lineStart, start).trim() && !text.slice(end, lineEnd === -1 ? undefined : lineEnd).trim()
    const cut = alone ? lineStart : start
    if (alone) end = lineEnd === -1 ? text.length : lineEnd + 1
    if (keeping()) out += text.slice(at, cut)
    at = end
    const kind = m[1]!.toUpperCase()
    if (kind === 'ENDIF') stack.pop()
    else stack.push(kind === 'IFDEF' ? on.has(m[2]!.toLowerCase()) : !on.has(m[2]!.toLowerCase()))
  }
  if (keeping()) out += text.slice(at)
  return out
}

/** A model's tables with the directives applied to their check constraints. */
export function tablesWithDirectives(tables: TableInfo[], defined: string[]): TableInfo[] {
  if (!tables.some((t) => t.checks?.some((c) => c.expression.includes('{$')))) return tables
  return tables.map((t) =>
    t.checks?.some((c) => c.expression.includes('{$'))
      ? {
          ...t,
          checks: t.checks
            .map((c) => ({ ...c, expression: applyGenerationDirectives(c.expression, defined).trim() }))
            .filter((c) => c.expression),
        }
      : t,
  )
}

/** A project's scripts around its CREATE and ALTER scripts with the directives applied. */
export function scriptingWithDirectives<
  T extends { around?: { create: [string, string]; alter: [string, string] } },
>(scripting: T | undefined, defined: string[]): T | undefined {
  if (!scripting?.around) return scripting
  const apply = ([begin, end]: [string, string]): [string, string] => [
    applyGenerationDirectives(begin, defined),
    applyGenerationDirectives(end, defined),
  ]
  return {
    ...scripting,
    around: { create: apply(scripting.around.create), alter: apply(scripting.around.alter) },
  }
}

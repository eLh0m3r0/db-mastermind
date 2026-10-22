import { snippetCompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import type { DriverId } from '@dbmastermind/core/browser'
import type { Snippet } from '@shared/api'
import { t } from '@/lib/i18n'

/** Built-in snippets; `${name}` fields are filled in with Tab. User snippets with the same trigger win. */
export function builtinSnippets(driver: DriverId): Snippet[] {
  const top = (n: number, rest: string) =>
    driver === 'mssql' ? `SELECT TOP ${n} ${rest}` : driver === 'oracle' ? `SELECT ${rest}\nFETCH FIRST ${n} ROWS ONLY` : `SELECT ${rest}\nLIMIT ${n}`
  const begin = driver === 'mssql' ? 'BEGIN TRANSACTION' : driver === 'mysql' || driver === 'mariadb' ? 'START TRANSACTION' : 'BEGIN'
  return [
    { trigger: 'sel', name: 'Select rows', body: top(100, '* FROM ${table}') },
    { trigger: 'selw', name: 'Select with condition', body: top(100, '* FROM ${table}\nWHERE ${condition}') },
    { trigger: 'cnt', name: 'Count by value', body: 'SELECT ${column}, COUNT(*) AS n\nFROM ${table}\nGROUP BY ${column}\nORDER BY n DESC' },
    { trigger: 'dup', name: 'Find duplicates', body: 'SELECT ${columns}, COUNT(*) AS n\nFROM ${table}\nGROUP BY ${columns}\nHAVING COUNT(*) > 1\nORDER BY n DESC' },
    { trigger: 'orph', name: 'Rows without a parent (orphans)', body: 'SELECT c.*\nFROM ${child} c\nLEFT JOIN ${parent} p ON p.${id} = c.${parent_id}\nWHERE c.${parent_id} IS NOT NULL AND p.${id} IS NULL' },
    { trigger: 'cte', name: 'Common table expression', body: 'WITH ${name} AS (\n  ${query}\n)\nSELECT *\nFROM ${name}' },
    { trigger: 'case', name: 'CASE expression', body: 'CASE WHEN ${condition} THEN ${value} ELSE ${otherwise} END' },
    { trigger: 'ins', name: 'Insert a row', body: 'INSERT INTO ${table} (${columns})\nVALUES (${values})' },
    { trigger: 'upd', name: 'Update rows', body: 'UPDATE ${table}\nSET ${column} = ${value}\nWHERE ${condition}' },
    { trigger: 'tx', name: 'Try changes in a transaction', body: `${begin};\n\n\${statements}\n\nROLLBACK; -- COMMIT when the result is right` },
  ]
}

export function allSnippets(driver: DriverId, user: Snippet[] = []): Snippet[] {
  const own = new Set(user.map((s) => s.trigger))
  return [...user, ...builtinSnippets(driver).filter((s) => !own.has(s.trigger))]
}

/** Completion source: typing a trigger offers its snippet. */
export function snippetSource(get: () => Snippet[]) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const word = ctx.matchBefore(/[A-Za-z_][\w-]*/)
    if (!word || (word.from === word.to && !ctx.explicit)) return null
    const options = get()
      .filter((s) => s.trigger && s.body)
      .map((s) => snippetCompletion(s.body, { label: s.trigger, detail: t(s.name), type: 'text' }))
    return options.length ? { from: word.from, options, validFor: /^[\w-]*$/ } : null
  }
}

import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { findTable, getDialect, statementAtOffset, type DriverId, type SchemaSnapshot, type TableInfo } from '@dbmastermind/core/browser'

interface Ref {
  table: TableInfo
  alias: string
}

const KEYWORDS = new Set(['on', 'where', 'join', 'inner', 'left', 'right', 'full', 'cross', 'outer', 'group', 'order', 'limit', 'having', 'using', 'set', 'union', 'natural', 'lateral', 'as', 'with'])

const unquote = (s: string) => s.replace(/^["`[]|["`\]]$/g, '')

/** Tables (and their aliases) referenced in FROM/JOIN clauses before the cursor. */
export function referencedTables(sql: string, schema: SchemaSnapshot): Ref[] {
  const out: Ref[] = []
  const re = /\b(?:from|join)\s+((?:["`[]?[\w$]+["`\]]?\.)?["`[]?[\w$]+["`\]]?)(?:\s+(?:as\s+)?([A-Za-z_][\w$]*))?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sql))) {
    const parts = m[1]!.split('.').map(unquote)
    const ref = parts.length > 1 ? { schema: parts[0], name: parts[1]! } : { name: parts[0]! }
    const table = findTable(schema, ref)
    if (!table) continue
    const alias = m[2] && !KEYWORDS.has(m[2].toLowerCase()) ? m[2] : table.name
    out.push({ table, alias })
  }
  return out
}

function aliasFor(name: string, taken: Set<string>): string {
  const base = name
    .split(/_|(?=[A-Z])/)
    .filter(Boolean)
    .map((w) => w[0]!.toLowerCase())
    .join('') || name[0]!.toLowerCase()
  let alias = base
  let i = 2
  while (taken.has(alias.toLowerCase())) alias = `${base}${i++}`
  return alias
}

/** Join conditions between two referenced tables, from foreign keys in either direction. */
function conditions(a: Ref, b: Ref, q: (s: string) => string): string[] {
  const out: string[] = []
  for (const fk of a.table.foreignKeys) {
    if (fk.refTable === b.table.name && (fk.refSchema ?? a.table.schema) === b.table.schema) {
      out.push(fk.columns.map((c, i) => `${q(a.alias)}.${q(c)} = ${q(b.alias)}.${q(fk.refColumns[i] ?? '')}`).join(' AND '))
    }
  }
  for (const fk of b.table.foreignKeys) {
    if (fk.refTable === a.table.name && (fk.refSchema ?? b.table.schema) === a.table.schema) {
      out.push(fk.columns.map((c, i) => `${q(b.alias)}.${q(c)} = ${q(a.alias)}.${q(fk.refColumns[i] ?? '')}`).join(' AND '))
    }
  }
  return out
}

/**
 * Completion source: after `JOIN ` suggests tables related to those already in the query, with the ON clause;
 * after `ON ` suggests the join condition. Uses declared and knowledge-base (virtual) foreign keys.
 */
export function joinCompletionSource(getSchema: () => SchemaSnapshot | undefined, getDriver: () => DriverId) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const schema = getSchema()
    if (!schema) return null
    const doc = ctx.state.doc.toString()
    const stmt = statementAtOffset(doc, ctx.pos, getDriver())
    const start = stmt ? stmt.start : 0
    const before = doc.slice(start, ctx.pos)
    const d = getDialect(getDriver())
    const plain = /^[A-Za-z_][\w$]*$/
    const q = (s: string) => (plain.test(s) && s === s.toLowerCase() ? s : d.quoteIdent(s))

    const afterJoin = /\bjoin\s+([\w$]*)$/i.exec(before)
    if (afterJoin) {
      const refs = referencedTables(before.slice(0, afterJoin.index), schema)
      if (!refs.length) return null
      const taken = new Set(refs.map((r) => r.alias.toLowerCase()))
      const options: Completion[] = []
      const seen = new Set<string>()
      for (const ref of refs) {
        const related = new Set<TableInfo>()
        for (const fk of ref.table.foreignKeys) {
          const t = findTable(schema, { schema: fk.refSchema ?? ref.table.schema, name: fk.refTable })
          if (t) related.add(t)
        }
        for (const t of schema.tables) if (t.foreignKeys.some((fk) => fk.refTable === ref.table.name)) related.add(t)
        for (const t of related) {
          const alias = aliasFor(t.name, taken)
          const candidate: Ref = { table: t, alias }
          for (const cond of conditions(candidate, ref, q)) {
            const name = t.schema && t.schema !== schema.defaultSchema ? `${q(t.schema)}.${q(t.name)}` : q(t.name)
            const label = `${name} ${alias} ON ${cond}`
            if (seen.has(label)) continue
            seen.add(label)
            options.push({ label, type: 'class', detail: `→ ${ref.alias}`, boost: 50 })
          }
        }
      }
      return options.length ? { from: ctx.pos - (afterJoin[1]?.length ?? 0), options, filter: true } : null
    }

    const afterOn = /\bjoin\s+((?:["`[]?[\w$]+["`\]]?\.)?["`[]?[\w$]+["`\]]?)(?:\s+(?:as\s+)?([A-Za-z_][\w$]*))?\s+on\s+([\w$.]*)$/i.exec(before)
    if (afterOn) {
      const refs = referencedTables(before, schema)
      const joined = refs.at(-1)
      if (!joined) return null
      const options: Completion[] = []
      for (const other of refs.slice(0, -1)) {
        for (const cond of conditions(joined, other, q)) options.push({ label: cond, type: 'keyword', detail: 'foreign key', boost: 50 })
      }
      return options.length ? { from: ctx.pos - (afterOn[3]?.length ?? 0), options } : null
    }
    return null
  }
}

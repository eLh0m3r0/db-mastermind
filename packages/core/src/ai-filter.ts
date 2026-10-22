import { newFilterId, OPERATORS, type FilterGroup, type FilterNode, type FilterOperator } from './filters.js'
import type { TableInfo } from './types.js'

/** Prompt that turns a natural-language request into DB Mastermind's filter JSON for one table. */
export function filterPrompt(table: TableInfo, request: string, today = new Date()): { system: string; prompt: string } {
  const ops = OPERATORS.map((o) => `${o.id} (${o.arity === 0 ? 'no value' : o.arity === 2 ? 'value + value2' : o.arity === 'list' ? 'values: string[]' : 'value'})`).join(', ')
  const system = `You convert a user's description into a filter for a database table. Reply with JSON only, no prose.
Schema of the JSON:
{"combinator":"and"|"or","children":[ condition | group ]}
condition = {"column": string, "operator": string, "value"?: string, "value2"?: string, "values"?: string[]}
group = {"combinator":"and"|"or","children":[...], "negate"?: boolean}
Operators: ${ops}.
Rules: use only the listed columns and operators; values are strings; dates as YYYY-MM-DD (today is ${today.toISOString().slice(0, 10)});
prefer relative date operators (today, last_n_days, this_month…) when the user speaks relatively; text matching should use contains unless an exact value is clear.`
  const columns = table.columns.map((c) => `${c.name} ${c.dataType}${c.comment ? ` (${c.comment})` : ''}`).join('\n')
  const prompt = `Table ${table.name}${table.comment ? ` — ${table.comment}` : ''}\nColumns:\n${columns}\n\nRequest: ${request}`
  return { system, prompt }
}

interface RawNode {
  combinator?: string
  children?: RawNode[]
  negate?: boolean
  column?: string
  operator?: string
  value?: unknown
  value2?: unknown
  values?: unknown
}

/** Validates model output against the real columns and operators; anything unknown is dropped. */
export function sanitizeFilter(raw: unknown, table: TableInfo): FilterGroup {
  const columns = new Map(table.columns.map((c) => [c.name.toLowerCase(), c.name]))
  const ops = new Set(OPERATORS.map((o) => o.id))
  const walk = (node: RawNode): FilterNode | null => {
    if (Array.isArray(node.children)) {
      const children = node.children.map(walk).filter((n): n is FilterNode => n !== null)
      if (!children.length) return null
      return { kind: 'group', id: newFilterId(), combinator: node.combinator === 'or' ? 'or' : 'and', negate: node.negate === true || undefined, children }
    }
    const column = columns.get(String(node.column ?? '').toLowerCase())
    const operator = String(node.operator ?? '') as FilterOperator
    if (!column || !ops.has(operator)) return null
    return {
      kind: 'condition',
      id: newFilterId(),
      column,
      operator,
      value: node.value === undefined || node.value === null ? undefined : String(node.value),
      value2: node.value2 === undefined || node.value2 === null ? undefined : String(node.value2),
      values: Array.isArray(node.values) ? node.values.map(String) : undefined,
    }
  }
  const root = walk((raw ?? {}) as RawNode)
  if (!root) throw new Error('The model did not produce a usable filter')
  return root.kind === 'group' ? root : { kind: 'group', id: newFilterId(), combinator: 'and', children: [root] }
}

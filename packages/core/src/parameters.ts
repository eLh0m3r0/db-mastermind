import type { Dialect } from './dialect.js'
import type { DriverId } from './types.js'

export interface QueryParameter {
  /** Name without the prefix (`:customer` → `customer`), or the 1-based position for `?` / `$1`. */
  name: string
  kind: 'named' | 'positional'
  /** Offsets of every occurrence in the SQL. */
  occurrences: { start: number; end: number }[]
}

/**
 * Finds `:name` parameters (and `?`, `$1` where the database has no native meaning for them) outside strings,
 * comments, PostgreSQL `::casts` and dollar quotes. `@name` is left alone on SQL Server (variables).
 */
export function extractParameters(sql: string, driver: DriverId): QueryParameter[] {
  const found = new Map<string, QueryParameter>()
  const add = (name: string, kind: QueryParameter['kind'], start: number, end: number) => {
    const key = `${kind}:${name}`
    const p = found.get(key) ?? { name, kind, occurrences: [] }
    p.occurrences.push({ start, end })
    found.set(key, p)
  }
  let positional = 0
  let i = 0
  const n = sql.length
  while (i < n) {
    const ch = sql[i]!
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      const e = sql.indexOf('\n', i)
      i = e === -1 ? n : e
      continue
    }
    if (ch === '/' && next === '*') {
      const e = sql.indexOf('*/', i + 2)
      i = e === -1 ? n : e + 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`' || (ch === '[' && driver === 'mssql')) {
      const close = ch === '[' ? ']' : ch
      i++
      while (i < n) {
        if ((driver === 'mysql' || driver === 'mariadb') && sql[i] === '\\') {
          i += 2
          continue
        }
        if (sql[i] === close) {
          if (sql[i + 1] === close) {
            i += 2
            continue
          }
          break
        }
        i++
      }
      i++
      continue
    }
    if (ch === '$' && driver === 'postgres') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (tag) {
        const e = sql.indexOf(tag[0], i + tag[0].length)
        i = e === -1 ? n : e + tag[0].length
        continue
      }
      const num = /^\$(\d+)/.exec(sql.slice(i))
      if (num) {
        add(num[1]!, 'positional', i, i + num[0].length)
        i += num[0].length
        continue
      }
    }
    if (ch === ':' && next === ':') {
      i += 2
      continue
    }
    if (ch === ':' && /[A-Za-z_]/.test(next ?? '') && !/[\w:]/.test(sql[i - 1] ?? '')) {
      const m = /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i))!
      add(m[1]!, 'named', i, i + m[0].length)
      i += m[0].length
      continue
    }
    if (ch === '?' && driver !== 'postgres') {
      positional += 1
      add(String(positional), 'positional', i, i + 1)
      i++
      continue
    }
    i++
  }
  return [...found.values()]
}

/**
 * Rewrites named parameters to the driver's placeholders and returns values in order.
 * `values` holds text as typed by the user; `null` binds SQL NULL.
 */
export function bindParameters(
  sql: string,
  driver: DriverId,
  dialect: Dialect,
  values: Record<string, string | null>,
): { sql: string; params: unknown[] } {
  const params = extractParameters(sql, driver)
  const occurrences = params
    .flatMap((p) => p.occurrences.map((o) => ({ ...o, p })))
    .sort((a, b) => a.start - b.start)
  let out = ''
  let last = 0
  const bound: unknown[] = []
  for (const o of occurrences) {
    out += sql.slice(last, o.start)
    const key = o.p.kind === 'named' ? o.p.name : `$${o.p.name}`
    if (!(key in values)) throw new Error(`Missing value for parameter ${o.p.kind === 'named' ? `:${o.p.name}` : o.p.name}`)
    bound.push(values[key])
    out += dialect.placeholder(bound.length)
    last = o.end
  }
  out += sql.slice(last)
  return { sql: out, params: bound }
}

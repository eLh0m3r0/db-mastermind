import type { DatabaseService } from './engine.js'
import { classifyStatement } from './sql-split.js'
import { cellToText } from './values.js'

/** One operator of an execution plan, normalized across databases. */
export interface PlanNode {
  /** Operator, e.g. "Seq Scan", "Index Seek", "Hash Join". */
  operation: string
  /** Table or index the operator reads. */
  object?: string
  detail?: string
  /** Estimated cost (database-specific units, comparable within one plan). */
  cost?: number
  rows?: number
  /** Measured time in ms when the plan was analyzed. */
  actualMs?: number
  actualRows?: number
  children: PlanNode[]
}

export interface ExplainResult {
  root: PlanNode
  /** The raw plan text/JSON/XML as returned by the database. */
  raw: string
  format: 'json' | 'xml' | 'text'
}

const num = (v: unknown): number | undefined => {
  const n = Number(v)
  return v === undefined || v === null || v === '' || Number.isNaN(n) ? undefined : n
}

function pgNode(p: Record<string, unknown>): PlanNode {
  const relation = (p['Relation Name'] ?? p['Index Name'] ?? p['CTE Name'] ?? p['Function Name']) as string | undefined
  const detail = [p['Index Cond'], p['Filter'], p['Hash Cond'], p['Join Filter'], p['Sort Key']]
    .filter(Boolean)
    .map((v) => (Array.isArray(v) ? v.join(', ') : String(v)))
    .join(' · ')
  return {
    operation: [p['Node Type'], p['Join Type'] ? `(${p['Join Type']})` : ''].filter(Boolean).join(' '),
    object: relation ? `${p['Schema'] ? `${p['Schema']}.` : ''}${relation}${p['Alias'] && p['Alias'] !== relation ? ` ${p['Alias']}` : ''}` : undefined,
    detail: detail || undefined,
    cost: num(p['Total Cost']),
    rows: num(p['Plan Rows']),
    actualMs: num(p['Actual Total Time']),
    actualRows: num(p['Actual Rows']),
    children: ((p['Plans'] as Record<string, unknown>[] | undefined) ?? []).map(pgNode),
  }
}

/** MySQL EXPLAIN FORMAT=JSON is a nested object; tables become leaves under their join operators. */
function mysqlNode(name: string, value: unknown): PlanNode[] {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap((v) => mysqlNode(name, v))
  const o = value as Record<string, unknown>
  if (o.table && typeof o.table === 'object') return mysqlNode('table', o.table)
  const cost = o.cost_info as Record<string, unknown> | undefined
  const children = Object.entries(o)
    .filter(([k, v]) => typeof v === 'object' && v !== null && k !== 'cost_info' && k !== 'used_columns' && k !== 'possible_keys' && k !== 'used_key_parts')
    .flatMap(([k, v]) => mysqlNode(k, v))
  if (name === 'table') {
    return [
      {
        operation: `${String(o.access_type ?? 'scan').toUpperCase()} access`,
        object: String(o.table_name ?? ''),
        detail: [o.key ? `key ${String(o.key)}` : '', o.attached_condition ? String(o.attached_condition) : ''].filter(Boolean).join(' · ') || undefined,
        cost: num(cost?.prefix_cost ?? cost?.read_cost),
        rows: num(o.rows_produced_per_join ?? o.rows_examined_per_scan ?? o.rows),
        children,
      },
    ]
  }
  if (['query_block', 'nested_loop', 'ordering_operation', 'grouping_operation', 'duplicates_removal', 'materialized_from_subquery', 'union_result'].includes(name)) {
    return [{ operation: name.replaceAll('_', ' '), cost: num(cost?.query_cost ?? cost?.sort_cost), children }]
  }
  return children
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]
}

/** Walks SQL Server showplan XML: nested RelOp elements form the tree. */
function mssqlPlan(xml: string): PlanNode {
  const root: PlanNode = { operation: 'Query', children: [] }
  const stack: PlanNode[] = [root]
  const tagRe = /<(\/?)(RelOp|Object)\b([^>]*?)(\/?)>/g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(xml))) {
    const [, closing, name, attrs] = m
    if (name === 'RelOp') {
      if (closing) {
        if (stack.length > 1) stack.pop()
        continue
      }
      const node: PlanNode = {
        operation: attr(attrs!, 'PhysicalOp') ?? 'Operator',
        detail: attr(attrs!, 'LogicalOp'),
        cost: num(attr(attrs!, 'EstimatedTotalSubtreeCost')),
        rows: num(attr(attrs!, 'EstimateRows')),
        children: [],
      }
      stack.at(-1)!.children.push(node)
      stack.push(node)
    } else if (name === 'Object' && !closing) {
      const current = stack.at(-1)!
      if (!current.object) {
        const table = attr(attrs!, 'Table')?.replace(/[[\]]/g, '')
        const index = attr(attrs!, 'Index')?.replace(/[[\]]/g, '')
        if (table) current.object = `${table}${index ? ` (${index})` : ''}`
      }
    }
  }
  return root.children.length === 1 ? root.children[0]! : root
}

function sqliteTree(rows: unknown[][]): PlanNode {
  const root: PlanNode = { operation: 'Query', children: [] }
  const byId = new Map<number, PlanNode>([[0, root]])
  for (const r of rows) {
    const [id, parent, , detail] = r
    const text = String(detail ?? '')
    const m = /^(SCAN|SEARCH|USE TEMP B-TREE|CO-ROUTINE|MATERIALIZE|COMPOUND|LIST SUBQUERY|CORRELATED SCALAR SUBQUERY)\s*(\S+)?(.*)$/i.exec(text)
    const node: PlanNode = { operation: m ? m[1]!.toUpperCase() : text, object: m?.[2], detail: m?.[3]?.trim() || undefined, children: [] }
    byId.set(Number(id), node)
    ;(byId.get(Number(parent)) ?? root).children.push(node)
  }
  return root.children.length === 1 ? root.children[0]! : root
}

/**
 * Execution plan of a read-only statement. `analyze` executes the query (PostgreSQL EXPLAIN ANALYZE)
 * to show actual times; it's only allowed for reads.
 */
interface DuckNode {
  name?: string
  operator_name?: string
  operator_timing?: number
  operator_cardinality?: number
  extra_info?: Record<string, unknown>
  children?: DuckNode[]
}

function duckNode(n: DuckNode): PlanNode {
  const info = n.extra_info ?? {}
  const text = (v: unknown) => (Array.isArray(v) ? v.join(', ') : v === undefined || v === null ? undefined : String(v))
  const children = (n.children ?? []).map(duckNode)
  const ownMs = n.operator_timing !== undefined ? n.operator_timing * 1000 : undefined
  const totalMs = ownMs !== undefined ? ownMs + children.reduce((s, c) => s + (c.cost ?? 0), 0) : undefined
  return {
    operation: String(n.operator_name ?? n.name ?? '?').trim().replaceAll('_', ' '),
    object: text(info.Table),
    detail: [text(info.Filters), text(info.Aggregates), text(info.Conditions)].filter(Boolean).join(' · ') || undefined,
    rows: n.operator_cardinality ?? num(info['Estimated Cardinality']),
    actualMs: ownMs,
    // DuckDB has no cost model in plans; with ANALYZE, time spent stands in for cost.
    cost: totalMs,
    children,
  }
}

/**
 * CockroachDB's text plan: `• operator` lines nested by the column of the bullet, with `key: value` details below.
 * Planning summary lines before the first operator are skipped.
 */
export function cockroachPlan(lines: string[]): PlanNode {
  const root: PlanNode = { operation: 'Query', children: [] }
  const stack: { col: number; node: PlanNode }[] = [{ col: -1, node: root }]
  let current: PlanNode | undefined
  for (const line of lines) {
    const bullet = line.indexOf('•')
    if (bullet >= 0) {
      const node: PlanNode = { operation: line.slice(bullet + 1).trim(), children: [] }
      while (stack.length > 1 && stack.at(-1)!.col >= bullet) stack.pop()
      stack.at(-1)!.node.children.push(node)
      stack.push({ col: bullet, node })
      current = node
      continue
    }
    if (!current) continue
    const m = /^[\s│]*([\w ]+?):\s*(.+)$/.exec(line)
    if (!m) continue
    const [, key, value] = m as unknown as [string, string, string]
    if (key === 'table') current.object = value
    else if (key === 'estimated row count') current.rows = num(value.replace(/[^\d.]/g, ''))
    else if (key === 'actual row count') current.actualRows = num(value.replace(/[^\d.]/g, ''))
    else if (key === 'execution time') current.actualMs = num(value.replace(/[^\d.]/g, ''))
    else if (/^(spans|filter|equality|lookup condition|order|group by|estimated max memory allocated)$/.test(key)) current.detail = [current.detail, `${key}: ${value}`].filter(Boolean).join(' · ')
  }
  return root.children.length === 1 ? root.children[0]! : root
}

export async function explainQuery(db: DatabaseService, connectionId: string, sql: string, analyze = false): Promise<ExplainResult> {
  if (classifyStatement(sql) !== 'read') throw new Error('Only SELECT statements can be explained')
  const driver = db.config(connectionId).driver
  const body = sql.trim().replace(/;\s*$/, '')
  const session = `explain-${Date.now()}`
  const run = async (script: string) => {
    const outcomes = await db.runScript(connectionId, script, { session, maxRows: 10_000 })
    const failed = outcomes.find((o) => o.error)
    if (failed) throw new Error(failed.error!.message)
    return outcomes.flatMap((o) => o.results ?? []).filter((r) => r.fields.length)
  }
  try {
    switch (driver) {
      case 'postgres': {
        if (db.serverInfo(connectionId)?.product === 'CockroachDB') {
          const [r] = await run(`EXPLAIN${analyze ? ' ANALYZE' : ''} ${body}`)
          const lines = (r?.rows ?? []).map((row) => cellToText(row[0] ?? ''))
          return { root: cockroachPlan(lines), raw: lines.join('\n'), format: 'text' }
        }
        const [r] = await run(`EXPLAIN (FORMAT JSON${analyze ? ', ANALYZE, BUFFERS' : ''}) ${body}`)
        const raw = cellToText(r?.rows[0]?.[0] ?? '[]')
        const plan = (JSON.parse(raw) as { Plan: Record<string, unknown> }[])[0]!.Plan
        return { root: pgNode(plan), raw, format: 'json' }
      }
      case 'mysql':
      case 'mariadb': {
        const [r] = await run(`EXPLAIN FORMAT=JSON ${body}`)
        const raw = cellToText(r?.rows[0]?.[0] ?? '{}')
        const json = JSON.parse(raw) as Record<string, unknown>
        const nodes = mysqlNode('root', json)
        return { root: nodes.length === 1 ? nodes[0]! : { operation: 'Query', children: nodes }, raw, format: 'json' }
      }
      case 'mssql': {
        const results = await run(`SET SHOWPLAN_XML ON\nGO\n${body}\nGO\nSET SHOWPLAN_XML OFF`)
        const raw = results.map((r) => cellToText(r.rows[0]?.[0] ?? '')).join('\n')
        return { root: mssqlPlan(raw), raw, format: 'xml' }
      }
      case 'oracle': {
        // EXPLAIN PLAN writes to PLAN_TABLE in the session; read it back as a tree.
        const id = `dbm${Date.now().toString(36)}`
        await run(`EXPLAIN PLAN SET STATEMENT_ID = '${id}' FOR ${body}`)
        const [r] = await run(
          `SELECT id, parent_id, operation, options, object_owner, object_name, cost, cardinality, access_predicates, filter_predicates FROM plan_table WHERE statement_id = '${id}' ORDER BY id`,
        )
        await run(`DELETE FROM plan_table WHERE statement_id = '${id}'`)
        const byId = new Map<number, PlanNode>()
        let root: PlanNode | undefined
        for (const row of r?.rows ?? []) {
          const [nid, parent, op, opt, owner, obj, cost, card, access, filter] = row
          const node: PlanNode = {
            operation: [op, opt].filter((x) => x !== null && x !== undefined && x !== '').map((x) => cellToText(x!)).join(' '),
            object: obj ? `${owner ? `${cellToText(owner)}.` : ''}${cellToText(obj)}` : undefined,
            detail: [access, filter].filter((x) => x !== null && x !== undefined).map((x) => cellToText(x!)).join(' · ') || undefined,
            cost: num(cost),
            rows: num(card),
            children: [],
          }
          byId.set(Number(nid), node)
          const p = parent === null ? undefined : byId.get(Number(parent))
          if (p) p.children.push(node)
          else root ??= node
        }
        const raw = (r?.rows ?? []).map((row) => row.map((x) => (x === null ? '' : cellToText(x))).join(' | ')).join('\n')
        return { root: root ?? { operation: 'Query', children: [] }, raw, format: 'text' }
      }
      case 'duckdb': {
        const [r] = await run(`EXPLAIN (${analyze ? 'ANALYZE, ' : ''}FORMAT JSON) ${body}`)
        const raw = cellToText(r?.rows[0]?.[r.rows[0]!.length - 1] ?? '[]')
        const json = JSON.parse(raw) as DuckNode | DuckNode[]
        const top = Array.isArray(json) ? json : (json.children ?? [])
        // ANALYZE wraps the plan in an EXPLAIN_ANALYZE operator.
        const nodes = top.flatMap((n) => (/EXPLAIN_ANALYZE/.test(String(n.operator_name ?? n.name)) ? (n.children ?? []) : [n])).map(duckNode)
        return { root: nodes.length === 1 ? nodes[0]! : { operation: 'Query', children: nodes }, raw, format: 'json' }
      }
      case 'sqlite': {
        const [r] = await run(`EXPLAIN QUERY PLAN ${body}`)
        const rows = r?.rows ?? []
        return { root: sqliteTree(rows), raw: rows.map((x) => cellToText(x[3] ?? '')).join('\n'), format: 'text' }
      }
    }
  } finally {
    await db.releaseSession(connectionId, session)
  }
}

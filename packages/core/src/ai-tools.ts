import type { AgentDatabase } from './agent-db.js'
import { describeError } from './engine.js'
import type { PlanNode } from './explain.js'
import { KnowledgeBase } from './knowledge.js'
import { getDialect } from './dialect.js'
import { findJoinPath, findTable, incomingReferences, joinPathSql } from './schema-utils.js'
import { isReadOnlyScript, splitStatements } from './sql-split.js'
import type { DriverId, QueryResult, SchemaSnapshot, StatementOutcome, TableInfo } from './types.js'
import { cellToText } from './values.js'
import { routineObject } from './definitions.js'

/**
 * Database tools for language models, independent of any AI SDK. The desktop assistant wraps them
 * as AI SDK tools; the MCP server exposes them as MCP tools. Results are compact text: models read it
 * well and it keeps token usage predictable.
 */

export interface ToolContext {
  /** The guarded view of the database (agent-db.ts): the tools' only way to it. */
  db: AgentDatabase
  connectionId: string
  knowledge?: KnowledgeBase
  /**
   * May the model see table contents? "Schema only" (false) means no value that comes from rows reaches the AI:
   * names, types, comments, row-count estimates from the catalog and query plans without ANALYZE are schema; query
   * results, samples, statistics of values and error messages that can quote a value are not (they are reduced to
   * their class and position, schemaOnlyError). The knowledge base is the user's own notes and is shared as it is.
   * The same flag is on the view (`db.allowData`), which refuses reads and samples by itself.
   */
  allowData: boolean
  /** Called before a non-read statement runs. Return false to refuse. Missing = writes refused. */
  confirmWrite?: (sql: string) => Promise<boolean>
  /** Allow writing knowledge base files. */
  allowKnowledgeWrites?: boolean
  maxRows?: number
  /** Called for every statement the model ran (audit log). */
  onExecuted?: (outcome: StatementOutcome) => void
  /**
   * Confirmed writes run on this session (the app's chat on a connection with manual commit): they open a transaction
   * that waits for Commit / Roll back like a query tab's.
   */
  writeSession?: string
}

export interface JsonSchema {
  type: 'object'
  properties: Record<string, { type: string; description?: string; enum?: string[]; items?: { type: string } }>
  required?: string[]
  additionalProperties?: false
}

export interface DbTool {
  name: string
  description: string
  inputSchema: JsonSchema
  /** Read-only tools can run without confirmation. */
  readOnly: boolean
  run(ctx: ToolContext, input: Record<string, unknown>): Promise<string>
}

const DEFAULT_ROWS = 50
const MAX_ROWS = 500
const MAX_CELL = 200

export function formatResultForModel(result: QueryResult, maxRows = DEFAULT_ROWS): string {
  if (result.fields.length === 0) return `OK: ${result.affectedRows ?? result.rowCount} row(s) affected.`
  const rows = result.rows.slice(0, maxRows)
  const esc = (s: string) => (/[,"\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s)
  const lines = [result.fields.map((f) => esc(f.name)).join(',')]
  for (const r of rows) {
    lines.push(
      r
        .map((v) => {
          if (v === null) return 'NULL'
          const t = cellToText(v)
          return esc(t.length > MAX_CELL ? `${t.slice(0, MAX_CELL)}…` : t)
        })
        .join(','),
    )
  }
  const more = result.rows.length > rows.length || result.truncated
  lines.push(`(${rows.length} row(s) shown${more ? ', more rows exist: add filters, aggregate, or use LIMIT/OFFSET' : ''})`)
  return lines.join('\n')
}

function tableLine(t: TableInfo): string {
  const est = t.rowEstimate != null && t.rowEstimate >= 0 ? ` ~${t.rowEstimate} rows` : ''
  const kind = t.type === 'table' ? '' : ` [${t.type.replace('_', ' ')}]`
  return `${t.schema ? `${t.schema}.` : ''}${t.name}${kind}${est}${t.comment ? ` — ${t.comment}` : ''}`
}

export function describeTableText(snapshot: SchemaSnapshot, t: TableInfo): string {
  const lines: string[] = [`Table ${t.schema ? `${t.schema}.` : ''}${t.name} (${t.type})${t.comment ? `: ${t.comment}` : ''}`]
  if (t.rowEstimate != null && t.rowEstimate >= 0) lines.push(`Approximate rows: ${t.rowEstimate}`)
  lines.push('Columns:')
  for (const c of t.columns) {
    const flags = [
      c.isPrimaryKey ? 'PK' : '',
      c.isIdentity ? 'identity' : '',
      c.nullable ? '' : 'NOT NULL',
      c.defaultValue ? `default ${c.defaultValue}` : '',
    ].filter(Boolean)
    const fk = t.foreignKeys.find((f) => f.columns.includes(c.name))
    if (fk) flags.push(`FK → ${fk.refTable}.${fk.refColumns[fk.columns.indexOf(c.name)] ?? ''}${fk.virtual ? ' (documented)' : ''}`)
    lines.push(`  - ${c.name} ${c.dataType}${flags.length ? ` [${flags.join(', ')}]` : ''}${c.comment ? ` — ${c.comment}` : ''}`)
  }
  const incoming = incomingReferences(snapshot, t)
  if (incoming.length) {
    lines.push('Referenced by:')
    for (const r of incoming) lines.push(`  - ${r.table.name}(${r.foreignKey.columns.join(', ')}) → ${t.name}(${r.foreignKey.refColumns.join(', ')})`)
  }
  if (t.indexes.length) {
    lines.push('Indexes:')
    for (const ix of t.indexes) lines.push(`  - ${ix.name}${ix.unique ? ' UNIQUE' : ''} (${ix.columns.join(', ')})`)
  }
  return lines.join('\n')
}

/** A compact overview for the system prompt; large schemas are summarised and the model uses tools for details. */
export function schemaOverview(snapshot: SchemaSnapshot, maxChars = 12_000): string {
  const full = snapshot.tables
    .map((t) => {
      const cols = t.columns.map((c) => `${c.name}${c.isPrimaryKey ? '*' : ''} ${c.dataType}`).join(', ')
      const fks = t.foreignKeys.map((f) => `${f.columns.join(',')}→${f.refTable}.${f.refColumns.join(',')}`).join('; ')
      return `${t.schema && t.schema !== snapshot.defaultSchema ? `${t.schema}.` : ''}${t.name}(${cols})${fks ? ` FK: ${fks}` : ''}`
    })
    .join('\n')
  if (full.length <= maxChars) return full
  const names = snapshot.tables.map(tableLine).join('\n')
  if (names.length <= maxChars) return `${names}\n(Column details omitted: use describe_table.)`
  return `${names.slice(0, maxChars)}\n… (${snapshot.tables.length} tables in total: use list_tables / search_schema.)`
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function num(input: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const v = Number(input[key])
  return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), max) : fallback
}

async function resolveTable(ctx: ToolContext, name: string, schemaName?: string): Promise<{ snapshot: SchemaSnapshot; table: TableInfo }> {
  const snapshot = await ctx.db.schema(ctx.connectionId)
  let schema = schemaName
  let table = name
  if (!schema && name.includes('.')) {
    const idx = name.lastIndexOf('.')
    schema = name.slice(0, idx)
    table = name.slice(idx + 1)
  }
  const found = findTable(snapshot, { schema, name: table })
  if (!found) {
    const similar = snapshot.tables
      .filter((t) => t.name.toLowerCase().includes(table.toLowerCase().slice(0, 4)))
      .slice(0, 8)
      .map((t) => t.name)
    throw new Error(`Table "${name}" not found.${similar.length ? ` Similar: ${similar.join(', ')}` : ''}`)
  }
  return { snapshot, table: found }
}

function summaryWithoutData(r: QueryResult): string {
  if (r.fields.length) return `${r.rowCount} row(s) returned; not shown, because the user only shares the schema with the assistant.`
  return `Done, ${r.affectedRows ?? r.rowCount} row(s) affected.`
}

/**
 * An error as the model sees it. Schema only: errors of the classes that can quote a value from the rows (conversion
 * and constraint errors) are reduced to their class and position; the others (syntax, unknown names, permissions,
 * the guard's refusals) pass as they are:
 *
 * | database          | reduced                                                                                    |
 * |-------------------|--------------------------------------------------------------------------------------------|
 * | PostgreSQL, CRDB  | SQLSTATE classes 22 (data exception) and 23 (integrity constraint)                         |
 * | MySQL, MariaDB    | 1062 duplicate entry, 1264/1265/1292/1366/1406/1690 value conversions, 3819/4025 checks    |
 * | SQL Server        | 2601/2627 duplicate key, 245/220/232/241/242/295/517/8114/8115/8152/2628 conversions        |
 * | Oracle            | ORA-01722, ORA-01830–01862 (number and date conversion), ORA-12899                         |
 * | DuckDB            | Conversion, Constraint, Out of Range and Invalid Input errors                              |
 * | ClickHouse        | CANNOT_PARSE_*, CANNOT_CONVERT_*, *OUT_OF_RANGE*, TYPE_MISMATCH                            |
 * | any               | a message about a duplicate, a conversion or a value out of range                          |
 */
export function modelError(ctx: Pick<ToolContext, 'allowData'>, error: { message: string; code?: string; position?: number }): string {
  const code = error.code ? ` [${error.code}]` : ''
  if (ctx.allowData || !quotesValues(error)) return `ERROR: ${error.message}${code}`
  return `ERROR${code}: a ${valueClass(error)} error${error.position ? ` at position ${error.position}` : ''}. Its message can quote values from the rows, so it is not shown: the user only shares the schema.`
}

function quotesValues(e: { message: string; code?: string }): boolean {
  const code = e.code ?? ''
  if (/^2[23][0-9A-Z]{3}$/.test(code)) return true
  if (/^(ER_DUP_ENTRY|ER_TRUNCATED_WRONG_VALUE|ER_TRUNCATED_WRONG_VALUE_FOR_FIELD|WARN_DATA_TRUNCATED|ER_WARN_DATA_OUT_OF_RANGE|ER_DATA_TOO_LONG|ER_DATA_OUT_OF_RANGE|ER_CHECK_CONSTRAINT_VIOLATED|ER_CONSTRAINT_FAILED)$/.test(code)) return true
  if (/^(1062|1264|1265|1292|1366|1406|1690|3819|4025|2601|2627|245|220|232|241|242|295|517|8114|8115|8152|2628)$/.test(code)) return true
  if (/ORA-(01722|018[3-6]\d|12899)/.test(e.message)) return true
  if (/^(Conversion|Constraint|Out of Range|Invalid Input) Error/.test(e.message)) return true
  if (/CANNOT_PARSE|CANNOT_CONVERT|OUT_OF_RANGE|TYPE_MISMATCH|Cannot parse/i.test(`${code} ${e.message}`)) return true
  return /duplicate (key|entry)|conver(t|sion)|out of range|invalid input syntax|incorrect \w+ value|truncated incorrect/i.test(e.message)
}

const valueClass = (e: { message: string; code?: string }) => (/duplicate|unique|constraint|check/i.test(e.message) || /^23/.test(e.code ?? '') ? 'constraint' : 'conversion')

async function runSql(ctx: ToolContext, sql: string, maxRows: number): Promise<string> {
  const config = ctx.db.config(ctx.connectionId)
  const statements = splitStatements(sql, config.driver)
  if (statements.length === 0) return 'Nothing to run.'
  const writes = !isReadOnlyScript(sql, config.driver)
  if (!writes && !ctx.allowData) {
    return 'Refused: the user only shares the schema with the assistant, not table contents. Write the SQL for the user to run instead.'
  }
  // Statements nobody confirmed run in a read-only transaction: a SELECT can still call a function that writes.
  const session = writes ? ctx.writeSession : undefined
  let outcomes: StatementOutcome[]
  if (writes) {
    // (The view asks the person itself: no write without their yes, none on a read-only connection.)
    const done = await ctx.db.write(ctx.connectionId, sql, ctx.confirmWrite, { maxRows: Math.max(maxRows, 1), session })
    if ('refused' in done) return done.refused
    outcomes = done.outcomes
  } else outcomes = await ctx.db.read(ctx.connectionId, sql, { maxRows: Math.max(maxRows, 1) })
  for (const o of outcomes) ctx.onExecuted?.(o)
  const state = session ? await ctx.db.transactionState(ctx.connectionId, session) : undefined
  const pending = state === 'open' || state === 'failed'
  const note = pending
    ? "\n\nThe change waits in an open transaction: the user commits or rolls it back in the app. Until then your read queries (which run separately) don't see it; don't run it again."
    : ''
  return outcomes
    .map((o, i) => {
      const head = outcomes.length > 1 ? `Statement ${i + 1}: ` : ''
      if (o.error) return `${head}${modelError(ctx, o.error)}`
      // Schema only: the user approved a change, not sharing table contents (a SELECT in the script, RETURNING).
      if (!ctx.allowData) return head + ((o.results ?? []).map(summaryWithoutData).join('\n') || 'Done.')
      return head + (o.results ?? []).map((r) => formatResultForModel(r, maxRows)).join('\n\n')
    })
    .join('\n\n') + note
}

export const DIALECT_NAMES: Record<DriverId, string> = {
  postgres: 'PostgreSQL',
  mssql: 'T-SQL (SQL Server)',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  sqlite: 'SQLite',
  oracle: 'Oracle',
  duckdb: 'DuckDB',
  clickhouse: 'ClickHouse',
  bigquery: 'BigQuery (GoogleSQL; tables are `dataset.table`)',
  trino: 'Trino (ANSI SQL; tables are `schema.table` in the connection\'s catalog, or `catalog.schema.table`)',
}

export const DB_TOOLS: DbTool[] = [
  {
    name: 'list_tables',
    description: 'List tables and views (with approximate row counts and comments). Optionally filter by schema or a name substring.',
    inputSchema: {
      type: 'object',
      properties: {
        schema: { type: 'string', description: 'Only this schema' },
        search: { type: 'string', description: 'Case-insensitive substring of the table name' },
      },
      additionalProperties: false,
    },
    readOnly: true,
    async run(ctx, input) {
      const snapshot = await ctx.db.schema(ctx.connectionId)
      const schema = str(input, 'schema')
      const search = str(input, 'search')?.toLowerCase()
      const tables = snapshot.tables.filter((t) => (!schema || t.schema === schema) && (!search || t.name.toLowerCase().includes(search)))
      if (!tables.length) return 'No matching tables.'
      const shown = tables.slice(0, 400)
      return `${shown.map(tableLine).join('\n')}${tables.length > shown.length ? `\n… ${tables.length - shown.length} more, narrow with search` : ''}`
    },
  },
  {
    name: 'describe_table',
    description: 'Columns with types, primary key, foreign keys (both directions), indexes and comments of one table, plus knowledge base notes about it.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name, optionally schema-qualified (schema.table)' },
        schema: { type: 'string' },
      },
      required: ['table'],
      additionalProperties: false,
    },
    readOnly: true,
    async run(ctx, input) {
      const { snapshot, table } = await resolveTable(ctx, str(input, 'table') ?? '', str(input, 'schema'))
      let text = describeTableText(snapshot, table)
      if (ctx.knowledge) {
        const notes = await ctx.knowledge.forTable(table.name).catch(() => [])
        if (notes.length) {
          text += `\n\nKnowledge base notes:\n${notes
            .slice(0, 3)
            .map((n) => `--- ${n.path} ---\n${n.body.slice(0, 2500)}`)
            .join('\n')}`
        }
      }
      return text
    },
  },
  {
    name: 'get_definition',
    description: 'The SQL that defines a view, function or procedure (as the database keeps it), or the CREATE statement of a table. Use it to understand what a routine or view does.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Object name, optionally schema-qualified (schema.name)' },
        schema: { type: 'string' },
        kind: { type: 'string', enum: ['table', 'view', 'function', 'procedure'], description: 'Optional; found from the schema when omitted' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    readOnly: true,
    async run(ctx, input) {
      const raw = str(input, 'name') ?? ''
      const dot = raw.lastIndexOf('.')
      const schemaName = str(input, 'schema') ?? (dot > 0 ? raw.slice(0, dot) : undefined)
      const name = dot > 0 && !str(input, 'schema') ? raw.slice(dot + 1) : raw
      const snapshot = await ctx.db.schema(ctx.connectionId)
      const lower = (x: string | undefined) => (x ?? '').toLowerCase()
      const kind = str(input, 'kind')
      const table = kind === 'function' || kind === 'procedure' ? undefined : findTable(snapshot, { schema: schemaName, name })
      if (table) return (await ctx.db.definition(ctx.connectionId, { schema: table.schema, name: table.name, kind: table.type === 'foreign_table' ? 'table' : table.type })).sql
      const routines = snapshot.routines.filter((r) => lower(r.name) === lower(name) && (!schemaName || lower(r.schema) === lower(schemaName)) && (!kind || r.kind === kind))
      if (!routines.length) return `No table, view or routine named ${raw}. Use search_schema or list_tables to find it.`
      const texts = []
      for (const r of routines.slice(0, 5)) texts.push((await ctx.db.definition(ctx.connectionId, routineObject(r))).sql)
      return texts.join('\n')
    },
  },
  {
    name: 'search_schema',
    description: 'Find tables and columns whose name or comment contains the given words. Use this to locate where something is stored.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Words to look for, e.g. "invoice email"' } },
      required: ['query'],
      additionalProperties: false,
    },
    readOnly: true,
    async run(ctx, input) {
      const snapshot = await ctx.db.schema(ctx.connectionId)
      const terms = (str(input, 'query') ?? '').toLowerCase().split(/\s+/).filter(Boolean)
      const hits: string[] = []
      for (const t of snapshot.tables) {
        const tableText = `${t.name} ${t.comment ?? ''}`.toLowerCase()
        if (terms.some((q) => tableText.includes(q))) hits.push(`table ${tableLine(t)}`)
        for (const c of t.columns) {
          const colText = `${c.name} ${c.comment ?? ''}`.toLowerCase()
          if (terms.some((q) => colText.includes(q))) hits.push(`column ${t.name}.${c.name} ${c.dataType}${c.comment ? ` — ${c.comment}` : ''}`)
        }
        if (hits.length > 200) break
      }
      return hits.length ? hits.join('\n') : 'Nothing found. Try other words or list_tables.'
    },
  },
  {
    name: 'get_relationships',
    description: 'Foreign-key neighbourhood of a table up to N hops, with join conditions. Use it to figure out how to join tables.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        depth: { type: 'number', description: 'Hops to follow (1-3, default 1)' },
      },
      required: ['table'],
      additionalProperties: false,
    },
    readOnly: true,
    async run(ctx, input) {
      const { snapshot, table } = await resolveTable(ctx, str(input, 'table') ?? '')
      const depth = num(input, 'depth', 1, 3)
      const seen = new Set([table.name])
      let frontier = [table]
      const lines: string[] = []
      for (let d = 0; d < depth; d++) {
        const next: TableInfo[] = []
        for (const t of frontier) {
          for (const fk of t.foreignKeys) {
            const join = fk.columns.map((c, i) => `${t.name}.${c} = ${fk.refTable}.${fk.refColumns[i]}`).join(' AND ')
            lines.push(`${t.name} → ${fk.refTable} ON ${join}${fk.virtual ? ' (documented in knowledge base)' : ''}`)
            const target = findTable(snapshot, { schema: fk.refSchema, name: fk.refTable })
            if (target && !seen.has(target.name)) {
              seen.add(target.name)
              next.push(target)
            }
          }
          for (const ref of incomingReferences(snapshot, t)) {
            const join = ref.foreignKey.columns.map((c, i) => `${ref.table.name}.${c} = ${t.name}.${ref.foreignKey.refColumns[i]}`).join(' AND ')
            lines.push(`${ref.table.name} → ${t.name} ON ${join}`)
            if (!seen.has(ref.table.name)) {
              seen.add(ref.table.name)
              next.push(ref.table)
            }
          }
        }
        frontier = next
      }
      return lines.length ? [...new Set(lines)].join('\n') : `${table.name} has no foreign-key relationships.`
    },
  },
  {
    name: 'find_join_path',
    description: 'Shortest chain of foreign keys connecting two tables, with a ready-to-use SELECT … JOIN statement. Use it whenever you need to join tables that are not directly related.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start table, optionally schema.table' },
        to: { type: 'string', description: 'Target table, optionally schema.table' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    readOnly: true,
    async run(ctx, input) {
      const { snapshot, table: from } = await resolveTable(ctx, str(input, 'from') ?? '')
      const { table: to } = await resolveTable(ctx, str(input, 'to') ?? '')
      const path = findJoinPath(snapshot, from, to)
      if (!path) return `No chain of foreign keys connects ${from.name} and ${to.name} (within 6 hops). Look for matching columns with search_schema.`
      if (!path.length) return 'Same table.'
      const steps = path.map((s) => `${s.from.name} → ${s.to.name} ON ${s.on.map(([a, b]) => `${s.from.name}.${a} = ${s.to.name}.${b}`).join(' AND ')}${s.virtual ? ' (documented in knowledge base)' : ''}`)
      const sql = joinPathSql(path, getDialect(ctx.db.config(ctx.connectionId).driver).quoteIdent, snapshot.defaultSchema)
      return `${steps.join('\n')}\n\n${sql}`
    },
  },
  {
    name: 'sample_rows',
    description: 'A few rows from a table to see what the data looks like.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        limit: { type: 'number', description: 'Rows (default 10, max 100)' },
      },
      required: ['table'],
      additionalProperties: false,
    },
    readOnly: true,
    async run(ctx, input) {
      if (!ctx.allowData) return 'Refused: the user only shares the schema with the assistant, not table contents.'
      const { table } = await resolveTable(ctx, str(input, 'table') ?? '')
      const limit = num(input, 'limit', 10, 100)
      return formatResultForModel(await ctx.db.sample(ctx.connectionId, { schema: table.schema, name: table.name }, limit), limit)
    },
  },
  {
    name: 'run_query',
    description:
      'Execute SQL and return results as CSV. SELECT/WITH/EXPLAIN run directly; INSERT/UPDATE/DELETE/DDL need the user’s approval. Always add LIMIT/TOP for exploratory queries.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'SQL in the dialect of this database' },
        max_rows: { type: 'number', description: `Rows to return (default ${DEFAULT_ROWS}, max ${MAX_ROWS})` },
      },
      required: ['sql'],
      additionalProperties: false,
    },
    readOnly: false,
    async run(ctx, input) {
      const sql = str(input, 'sql')
      if (!sql) return 'Missing sql.'
      try {
        return await runSql(ctx, sql, num(input, 'max_rows', ctx.maxRows ?? DEFAULT_ROWS, MAX_ROWS))
      } catch (err) {
        return modelError(ctx, describeError(err))
      }
    },
  },
  {
    name: 'explain_query',
    description: 'Execution plan of a SELECT (without running it) as an indented operator tree with estimated cost and rows. Use it to check performance and index usage.',
    inputSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'], additionalProperties: false },
    readOnly: true,
    async run(ctx, input) {
      const sql = str(input, 'sql')
      if (!sql) return 'Missing sql.'
      try {
        const plan = await ctx.db.explain(ctx.connectionId, sql)
        const lines: string[] = []
        // Schema only: MySQL and MariaDB read const tables while planning and write their values into the plan's
        // conditions, so those are left out there; elsewhere a condition holds the agent's own constants.
        const driver = ctx.db.config(ctx.connectionId).driver
        const details = ctx.allowData || (driver !== 'mysql' && driver !== 'mariadb')
        const walk = (n: PlanNode, depth: number) => {
          const facts = [n.cost !== undefined ? `cost ${n.cost}` : '', n.rows !== undefined ? `rows ${n.rows}` : ''].filter(Boolean).join(', ')
          lines.push(`${'  '.repeat(depth)}${n.operation}${n.object ? ` on ${n.object}` : ''}${facts ? ` (${facts})` : ''}${n.detail && details ? ` — ${n.detail}` : ''}`)
          for (const c of n.children) walk(c, depth + 1)
        }
        walk(plan.root, 0)
        return lines.join('\n')
      } catch (err) {
        return modelError(ctx, describeError(err))
      }
    },
  },
  {
    name: 'search_knowledge',
    description: 'Search the knowledge base (Markdown notes the team wrote about this database: business meaning, rules, gotchas).',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    readOnly: true,
    async run(ctx, input) {
      if (!ctx.knowledge) return 'This connection has no knowledge base folder configured.'
      const hits = await ctx.knowledge.search(str(input, 'query') ?? '')
      return hits.length ? hits.map((h) => `## ${h.path} (${h.title})\n${h.excerpt}`).join('\n\n') : 'No notes matched.'
    },
  },
  {
    name: 'read_knowledge',
    description: 'Read a knowledge base file, or list all files when no path is given.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Relative path, e.g. "tables/orders.md"' } }, additionalProperties: false },
    readOnly: true,
    async run(ctx, input) {
      if (!ctx.knowledge) return 'This connection has no knowledge base folder configured.'
      const path = str(input, 'path')
      if (!path) {
        const files = await ctx.knowledge.list()
        return files.length ? files.map((f) => `${f.path} — ${f.title}${f.tables.length ? ` [tables: ${f.tables.join(', ')}]` : ''}`).join('\n') : 'The knowledge base is empty.'
      }
      const doc = await ctx.knowledge.read(path)
      return doc.content.slice(0, 20_000)
    },
  },
  {
    name: 'write_knowledge',
    description:
      'Create or overwrite a Markdown file in the knowledge base. Use front matter `tables: [..]` to link tables and `relations: ["a.col -> b.col"]` for relationships the database does not declare.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    readOnly: false,
    async run(ctx, input) {
      if (!ctx.knowledge) return 'This connection has no knowledge base folder configured.'
      if (!ctx.allowKnowledgeWrites) return 'Refused: writing to the knowledge base is not enabled.'
      const path = await ctx.knowledge.write(str(input, 'path') ?? 'notes.md', String(input.content ?? ''))
      return `Saved ${path}.`
    },
  },
]

export function getTool(name: string): DbTool | undefined {
  return DB_TOOLS.find((t) => t.name === name)
}

/** System prompt shared by the in-app assistant and agent integrations. */
/** The dashboard file the system prompt shows as its example (the desktop's parser reads it in a test). */
export const DASHBOARD_EXAMPLE = `---
dashboard: true
refresh: 300
---
# Sales overview

## Orders per month

\`\`\`sql chart=line x=month y=orders wide
select date_trunc('month', ordered_at) as month, count(*) as orders from orders group by 1 order by 1
\`\`\`

## Customers

\`\`\`sql
select count(*) as customers from customers
\`\`\`
`

/** How dashboards are kept in a knowledge base, for the system prompt (only when the connection has one). */
export function dashboardPrompt(canWrite: boolean): string {
  return `Dashboards shared with the team are knowledge base files dashboards/<name>.md. When the user asks for a dashboard or to add something to one, read the existing file with read_knowledge first, then ${canWrite ? 'write the whole file back with write_knowledge' : 'show the whole file\'s text (you may not write knowledge files here)'}. Format: optional front matter (dashboard: true; refresh: seconds, one of 60, 300, 900, 3600), a "# " title, then per tile one "## " heading and one fenced sql block. The block's options: chart=bar|line|scatter with x=<column> y=<column>[,<column>] naming result columns (quote names with spaces: x="order month"); no chart= shows a table, or a big number for a single value; wide spans the full width. Each block is one read-only query returning the named columns. Example:\n${DASHBOARD_EXAMPLE}`
}

export async function buildSystemPrompt(ctx: ToolContext, extra = ''): Promise<string> {
  const config = ctx.db.config(ctx.connectionId)
  const snapshot = await ctx.db.schema(ctx.connectionId)
  const info = ctx.db.serverInfo(ctx.connectionId)
  let kb = ''
  if (ctx.knowledge) {
    const files = await ctx.knowledge.list().catch(() => [])
    if (files.length) {
      kb = `\n\nKnowledge base files (read them with read_knowledge when relevant):\n${files
        .slice(0, 80)
        .map((f) => `- ${f.path}: ${f.title}`)
        .join('\n')}`
      const overview = files.find((f) => /^(readme|index|overview)\.md$/i.test(f.path))
      if (overview) {
        const doc = await ctx.knowledge.read(overview.path).catch(() => null)
        if (doc) kb += `\n\n${overview.path}:\n${doc.body.slice(0, 6000)}`
      }
    }
    kb += `\n\n${dashboardPrompt(!!ctx.allowKnowledgeWrites)}`
  }
  return `You are the database assistant inside DB Mastermind, a database client. You help an analyst understand and query a ${info?.product ?? config.driver} database${snapshot.database ? ` "${snapshot.database}"` : ''}.

Rules:
- Write SQL in the ${DIALECT_NAMES[config.driver]} dialect. Quote identifiers only when needed.
- Use the tools to check table and column names before writing SQL; never guess columns.
- To join tables that aren't directly related, use find_join_path instead of guessing the chain.
- Exploratory queries must be limited (${config.driver === 'mssql' ? 'TOP' : config.driver === 'oracle' ? 'FETCH FIRST n ROWS ONLY' : 'LIMIT'}). Prefer aggregates over dumping rows.
- ${ctx.allowData ? 'You may run read-only queries to verify answers.' : 'You can only see the schema, not the data: write SQL for the user to run.'}
- ${ctx.confirmWrite && !config.readOnly ? 'Never run INSERT/UPDATE/DELETE/DDL unless the user explicitly asked. When they did, call run_query with the statement: the app shows it to the user and runs it only if they approve, so don\'t ask for approval in the chat first.' : 'You cannot change data on this connection: when the user asks for a change, write the SQL for them to run.'}
- Put final SQL in a fenced \`\`\`sql block so the user can insert or run it with one click.
- Be concise. Answer in the user's language.${config.readOnly ? '\n- The connection is read-only.' : ''}

Schema${snapshot.defaultSchema ? ` (default schema: ${snapshot.defaultSchema})` : ''}:
${schemaOverview(snapshot)}${kb}${extra ? `\n\n${extra}` : ''}`
}


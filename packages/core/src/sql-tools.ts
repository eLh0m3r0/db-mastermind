import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { formatResultForModel, type DbTool, type JsonSchema } from './ai-tools.js'
import { describeError } from './engine.js'
import type { KnowledgeBase } from './knowledge.js'
import { classifyStatement, splitStatements } from './sql-split.js'

/**
 * Tool plugins: `tools/*.sql` in a connection's knowledge base become tools for the AI assistant and MCP agents.
 *
 *   -- tool: customer_balance
 *   -- description: Current balance of one customer
 *   -- param: customer_id (number, required): id from customers.id
 *   SELECT … WHERE c.id = :customer_id
 *
 * They are read-only (anything else is refused) and their parameters are bound, never pasted into the SQL.
 * Teams share them like notes: through Git or the team folder.
 */
export interface SqlToolSpec {
  name: string
  description: string
  params: { name: string; type: 'string' | 'number' | 'boolean'; required: boolean; description: string }[]
  sql: string
  file: string
}

export const TOOLS_FOLDER = 'tools'

/** Parses a tool file; returns an error message for files that aren't valid tools. */
export function parseSqlTool(text: string, file: string): SqlToolSpec | { error: string } {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const meta: { name?: string; description?: string; params: SqlToolSpec['params'] } = { params: [] }
  let i = 0
  let last = ''
  for (; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line) continue
    const m = /^--\s*(tool|description|param)\s*:\s*(.*)$/i.exec(line)
    if (!m) {
      if (!line.startsWith('--')) break
      // A plain comment right after the description continues it.
      if (last === 'description') meta.description = [meta.description, line.replace(/^--\s*/, '')].filter(Boolean).join(' ')
      continue
    }
    const [, key, value] = m as unknown as [string, string, string]
    last = key.toLowerCase()
    if (key.toLowerCase() === 'tool') meta.name = value.trim()
    else if (key.toLowerCase() === 'description') meta.description = [meta.description, value.trim()].filter(Boolean).join(' ')
    else {
      const p = /^(\w+)\s*(?:\(([^)]*)\))?\s*:?\s*(.*)$/.exec(value.trim())
      if (!p) return { error: `${file}: cannot read "-- param: ${value}"` }
      const flags = (p[2] ?? '').split(',').map((s) => s.trim().toLowerCase())
      const type = flags.find((f) => f === 'number' || f === 'boolean' || f === 'string') as SqlToolSpec['params'][number]['type'] | undefined
      meta.params.push({ name: p[1]!, type: type ?? 'string', required: flags.includes('required'), description: p[3]!.trim() })
    }
  }
  const sql = lines.slice(i).join('\n').trim().replace(/;\s*$/, '')
  const name = meta.name ?? file.replace(/^.*[\\/]/, '').replace(/\.sql$/i, '')
  if (!/^[a-zA-Z][\w-]{0,62}$/.test(name)) return { error: `${file}: the tool name must be letters, digits, _ or - (got "${name}")` }
  if (!sql) return { error: `${file}: no SQL` }
  if (!meta.description) return { error: `${file}: add a "-- description:" line so the AI knows when to use it` }
  return { name, description: meta.description, params: meta.params, sql, file }
}

/** The AI tool for a spec: binds the parameters, refuses anything but reads, returns CSV like run_query. */
export function sqlTool(spec: SqlToolSpec): DbTool {
  const inputSchema: JsonSchema = {
    type: 'object',
    properties: Object.fromEntries(spec.params.map((p) => [p.name, { type: p.type, ...(p.description ? { description: p.description } : {}) }])),
    required: spec.params.filter((p) => p.required).map((p) => p.name),
    additionalProperties: false,
  }
  return {
    name: spec.name,
    description: `${spec.description} (team tool from ${spec.file})`,
    inputSchema,
    readOnly: true,
    async run(ctx, input) {
      const driver = ctx.db.config(ctx.connectionId).driver
      if (splitStatements(spec.sql, driver).some((s) => classifyStatement(s.text) !== 'read')) return `Refused: tool files may only read data (${spec.file}).`
      if (!ctx.allowData) return 'Refused: the user only shares the schema with the assistant, not table contents.'
      const values: Record<string, string | null> = {}
      for (const p of spec.params) {
        const v = input[p.name]
        if ((v === undefined || v === null || v === '') && p.required) return `Missing parameter ${p.name}.`
        values[p.name] = v === undefined || v === null ? null : String(v)
      }
      try {
        const outcomes = await ctx.db.runScript(ctx.connectionId, spec.sql, { maxRows: ctx.maxRows ?? 200, parameterValues: values, readOnly: true })
        for (const o of outcomes) ctx.onExecuted?.(o)
        return outcomes
          .map((o) => (o.error ? `ERROR: ${o.error.message}` : (o.results ?? []).map((r) => formatResultForModel(r, ctx.maxRows ?? 200)).join('\n\n')))
          .join('\n\n')
      } catch (err) {
        return `ERROR: ${describeError(err).message}`
      }
    },
  }
}

/** Tool plugins of a knowledge base (invalid files are reported in `errors`, the rest still load). */
export async function loadSqlTools(kb: KnowledgeBase | undefined, reserved: string[] = []): Promise<{ tools: DbTool[]; errors: string[] }> {
  if (!kb) return { tools: [], errors: [] }
  const dir = join(kb.root, TOOLS_FOLDER)
  const files = await readdir(dir).catch(() => [] as string[])
  const tools: DbTool[] = []
  const errors: string[] = []
  for (const file of files.filter((f) => f.toLowerCase().endsWith('.sql')).sort()) {
    const spec = parseSqlTool(await readFile(join(dir, file), 'utf8'), `${TOOLS_FOLDER}/${file}`)
    if ('error' in spec) errors.push(spec.error)
    else if (reserved.includes(spec.name) || tools.some((t) => t.name === spec.name)) errors.push(`${spec.file}: the name "${spec.name}" is already used`)
    else tools.push(sqlTool(spec))
  }
  return { tools, errors }
}

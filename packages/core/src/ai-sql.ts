import type { DriverId } from './types.js'

export interface WriteSqlRequest {
  driver: DriverId
  /** What the user wants, in their words. */
  request: string
  /** Compact schema description (see `schemaOverview`). */
  schema: string
  /** The whole editor, for context. */
  sql?: string
  /** Selected text to rewrite; when absent the model writes a new statement. */
  selection?: string
  /** Relevant knowledge base excerpts. */
  notes?: string
  dialectName: string
}

/** Prompt for inline SQL writing in the editor (Cmd/Ctrl+I). */
export function writeSqlPrompt(r: WriteSqlRequest): { system: string; prompt: string } {
  const system = `You write ${r.dialectName} SQL inside a database client's editor. Reply with exactly one fenced \`\`\`sql block and nothing else.
- Use only tables and columns from the schema; never invent names.
- Quote identifiers only when needed. Keep the user's formatting style.
- Exploratory SELECTs over large tables get a row limit.
- Never write statements that change data or structure unless the request explicitly asks for it.
- Comments in the SQL may be in the user's language; keep them short.`
  const parts = [`Schema:\n${r.schema}`]
  if (r.notes) parts.push(`Notes about this database:\n${r.notes}`)
  if (r.sql?.trim()) parts.push(`Current editor content:\n\`\`\`sql\n${r.sql.slice(0, 8000)}\n\`\`\``)
  parts.push(
    r.selection?.trim()
      ? `Rewrite this selected SQL as requested (reply with the replacement only):\n\`\`\`sql\n${r.selection}\n\`\`\`\nRequest: ${r.request}`
      : `Write SQL for: ${r.request}`,
  )
  return { system, prompt: parts.join('\n\n') }
}

/** The SQL from a model reply: the first fenced block, or the whole reply when there is none. */
export function extractSql(text: string): string {
  const fenced = /```(?:sql|[a-z]*)?\s*\n([\s\S]*?)```/i.exec(text)?.[1]
  return (fenced ?? text).trim()
}


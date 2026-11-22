import { ReadOnlyViolationError } from './driver.js'
import { objectDefinition, type DefinedObject, type ObjectDefinition } from './definitions.js'
import type { DatabaseService } from './engine.js'
import { explainUnconfirmed, type ExplainResult } from './explain.js'
import { buildSelect } from './filters.js'
import { getDialect } from './dialect.js'
import type { ConnectionConfig, QueryResult, SchemaSnapshot, ServerInfo, StatementOutcome, TableRef, TransactionState } from './types.js'

/**
 * What the AI assistant's and agents' tools may do with a database (ToolContext.db): the only door they have.
 * - Catalog reads the drivers build themselves, with no agent text and no user object run: schema, definition.
 * - Everything that touches rows or runs agent text goes through the guarded path under the agent profile
 *   (runScript readOnly: one read per call, the allowlist and refused names, the read-only transaction): read,
 *   sample, explain (a plan only, never ANALYZE).
 * - A write only after the person confirmed it (write asks `confirm` itself), never on a read-only connection.
 * - Schema only (`allowData: false`): read and sample refuse; no row value reaches the model through this object.
 * Methods the tools must not have (runScript without the guard, fetchTable, streamQuery, driver) are not on it:
 * a new tool can't reach them by accident (agent-db.test.ts runs every tool against this object only).
 */
export interface AgentDatabase {
  readonly allowData: boolean
  config(id: string): ConnectionConfig
  serverInfo(id: string): ServerInfo | undefined
  schema(id: string): Promise<SchemaSnapshot>
  definition(id: string, object: DefinedObject): Promise<ObjectDefinition>
  read(id: string, sql: string, options?: { maxRows?: number; parameterValues?: Record<string, string | null> }): Promise<StatementOutcome[]>
  sample(id: string, table: TableRef, limit: number): Promise<QueryResult>
  explain(id: string, sql: string): Promise<ExplainResult>
  write(id: string, sql: string, confirm: ((sql: string) => Promise<boolean>) | undefined, options: { maxRows: number; session?: string }): Promise<{ outcomes: StatementOutcome[] } | { refused: string }>
  transactionState(id: string, session: string): Promise<TransactionState | undefined>
}

/** The names of AgentDatabase's members (tests check the view has these and nothing else). */
export const AGENT_DATABASE_MEMBERS = ['allowData', 'config', 'serverInfo', 'schema', 'definition', 'read', 'sample', 'explain', 'write', 'transactionState'] as const

const SCHEMA_ONLY = 'Refused: the user only shares the schema with the assistant, not table contents.'

export function agentDatabase(db: DatabaseService, options: { allowData: boolean }): AgentDatabase {
  const view: AgentDatabase = {
    allowData: options.allowData,
    config: (id) => db.config(id),
    serverInfo: (id) => db.serverInfo(id),
    schema: (id) => db.schema(id),
    definition: (id, object) => objectDefinition(db, id, object),
    async read(id, sql, o = {}) {
      if (!options.allowData) throw new ReadOnlyViolationError(SCHEMA_ONLY)
      return db.runScript(id, sql, { readOnly: true, maxRows: o.maxRows, parameterValues: o.parameterValues })
    },
    async sample(id, table, limit) {
      if (!options.allowData) throw new ReadOnlyViolationError(SCHEMA_ONLY)
      // (Built from quoted names, run as SQL nobody confirmed: a view's or a computed column's functions run in the
      // read-only transaction too.)
      const built = buildSelect({ table, limit }, getDialect(db.config(id).driver))
      const [o] = await db.runScript(id, built.sql, { readOnly: true, maxRows: limit, params: built.params })
      if (o?.error) throw new Error(o.error.message)
      const result = o?.results?.find((r) => r.fields.length)
      if (!result) throw new Error('Query returned no result')
      return result
    },
    explain: (id, sql) => explainUnconfirmed(db, id, sql),
    async write(id, sql, confirm, o) {
      if (db.config(id).readOnly) return { refused: 'Refused: this connection is read-only.' }
      if (!confirm) return { refused: 'Refused: write statements are not allowed here. Show the SQL to the user instead.' }
      if (!(await confirm(sql))) return { refused: 'The user declined to run this statement.' }
      return { outcomes: await db.runScript(id, sql, { readOnly: false, maxRows: o.maxRows, ...(o.session ? { session: o.session, editor: true } : {}) }) }
    },
    transactionState: (id, session) => db.transactionState(id, session).catch(() => undefined),
  }
  return Object.freeze(view)
}

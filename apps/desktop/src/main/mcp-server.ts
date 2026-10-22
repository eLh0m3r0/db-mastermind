/**
 * Stdio MCP server, run by the Electron binary in plain Node mode (ELECTRON_RUN_AS_NODE).
 * The parent (`--mcp`, see mcp-mode.ts) decrypts saved connections with the OS keychain and hands them
 * over IPC. Node mode has reliable stdio on every platform, which the GUI process lacks on Windows.
 * Must not import 'electron'.
 */
import { appendFileSync } from 'node:fs'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { DatabaseService, type ConnectionConfig } from '@dbmastermind/core'
import { createMcpServer } from 'dbmastermind-mcp'

export interface McpChildConfig {
  connections: ConnectionConfig[]
  allowWrites: boolean
  schemaOnly: boolean
  version: string
  /** JSON-lines audit file the app merges into its history. */
  historyFile?: string
}

process.once('message', (config: McpChildConfig) => {
  void (async () => {
    const db = new DatabaseService()
    const server = createMcpServer({
      db,
      connections: config.connections,
      allowWrites: config.allowWrites,
      allowKnowledgeWrites: config.allowWrites,
      schemaOnly: config.schemaOnly,
      version: config.version,
      onExecuted: config.historyFile
        ? (connectionId, o) => {
            const entry = { connectionId, sql: o.sql, executedAt: new Date().toISOString(), durationMs: o.durationMs, rowCount: o.results?.reduce((n, r) => n + r.rowCount, 0), error: o.error?.message, source: 'mcp' }
            try {
              appendFileSync(config.historyFile!, `${JSON.stringify(entry)}\n`)
            } catch {
              // Auditing must never break the agent's query.
            }
          }
        : undefined,
    })
    await server.connect(new StdioServerTransport())
    // The IPC channel would otherwise keep the process alive after the agent disconnects.
    process.disconnect?.()
    const quit = () => void db.disconnectAll().finally(() => process.exit(0))
    process.stdin.on('close', quit)
    process.on('SIGTERM', quit)
  })().catch((err: unknown) => {
    process.stderr.write(`DB Mastermind MCP server failed: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
})

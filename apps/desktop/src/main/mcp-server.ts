/**
 * Stdio MCP server, run by the Electron binary in plain Node mode (ELECTRON_RUN_AS_NODE).
 * The parent (`--mcp`, see mcp-mode.ts) decrypts saved connections with the OS keychain and hands them
 * over IPC. Node mode has reliable stdio on every platform, which the GUI process lacks on Windows.
 * Must not import 'electron'.
 */
import { appendFileSync } from 'node:fs'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { DatabaseService, useKnownHostsFile, type ConnectionConfig } from '@dbmastermind/core'
import { createMcpServer } from 'dbmastermind-mcp'
import { writeProposal } from './connection-proposals'
import { askParent, guardMcpTransport, LiveConnections } from './mcp-live'
import { withCommandPassword } from './password-command'

export interface McpChildConfig {
  /** The connections agents may use, each with its effective permissions (`agentConnections`). */
  connections: ConnectionConfig[]
  allowWrites: boolean
  version: string
  /** JSON-lines audit file the app merges into its history. */
  historyFile?: string
  /** Trusted SSH host keys, shared with the app. */
  knownHostsFile?: string
  /** Where proposed connections wait for the user (the running app watches it). */
  proposalsDir?: string
}

process.once('message', (config: McpChildConfig) => {
  if (config.knownHostsFile) useKnownHostsFile(config.knownHostsFile)
  void (async () => {
    const db = new DatabaseService()
    const live = new LiveConnections(config.connections, [], config.connections.length === 1 ? config.connections[0]!.id : undefined)
    const current = askParent(
      (m) => process.send!(m),
      (listener) => {
        process.on('message', listener)
        return () => void process.off('message', listener)
      },
    )
    const server = createMcpServer({
      db,
      connections: live.list,
      allowWrites: config.allowWrites,
      allowKnowledgeWrites: config.allowWrites,
      version: config.version,
      // Passwords from the user's password manager, fetched when an agent first uses the connection.
      prepareConnection: (c) => withCommandPassword(c),
      proposeConnection: config.proposalsDir ? async (p) => void (await writeProposal(config.proposalsDir!, p)) : undefined,
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
    const transport = new StdioServerTransport()
    await server.connect(transport)
    // Every request that uses a connection first asks the parent for the current permissions.
    guardMcpTransport(transport, live, async () => live.set(await current()))
    const quit = () => void db.disconnectAll().finally(() => process.exit(0))
    process.stdin.on('close', quit)
    // Without the parent nobody can say what is allowed any more.
    process.on('disconnect', quit)
    process.on('SIGTERM', quit)
  })().catch((err: unknown) => {
    process.stderr.write(`DB Mastermind MCP server failed: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
})

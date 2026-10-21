import { app } from 'electron'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { DatabaseService } from '@dbmastermind/core'
import { createMcpServer } from 'dbmastermind-mcp'
import { listConnections } from './connections'
import { getSettings } from './settings'

export const isMcpMode = process.argv.includes('--mcp')

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}

/**
 * Headless stdio MCP server. Agents launch the app binary with --mcp; it uses the saved connections
 * (only those with AI enabled) and decrypts passwords with the OS keychain, which a plain Node CLI can't.
 */
export async function runMcpMode(): Promise<void> {
  app.dock?.hide()
  await app.whenReady()
  const only = argValue('--connection')
  const connections = listConnections().filter((c) => c.aiEnabled !== false && (!only || c.id === only || c.name === only))
  const settings = getSettings()
  const db = new DatabaseService()
  const server = createMcpServer({
    db,
    connections,
    allowWrites: settings.mcp.allowWrites,
    allowKnowledgeWrites: settings.mcp.allowWrites,
    schemaOnly: settings.ai.dataSharing === 'schema',
    version: app.getVersion(),
  })
  await server.connect(new StdioServerTransport())
  const quit = () => void db.disconnectAll().finally(() => app.exit(0))
  process.stdin.on('close', quit)
  process.on('SIGTERM', quit)
}

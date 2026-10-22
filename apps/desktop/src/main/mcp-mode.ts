import { fork } from 'node:child_process'
import { join } from 'node:path'
import { app } from 'electron'
import { listConnections, loadConnections } from './connections'
import type { McpChildConfig } from './mcp-server'
import { getSettings, loadSettings } from './settings'

export const isMcpMode = process.argv.includes('--mcp')

if (isMcpMode) {
  // No windows are created in this mode; Linux distributions that restrict user namespaces
  // would otherwise refuse to start Chromium's sandbox.
  app.commandLine.appendSwitch('no-sandbox')
  app.disableHardwareAcceleration()
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}

/**
 * `--mcp`: agents launch the app binary as a stdio MCP server. This process only reads the saved
 * connections (only those with AI enabled) and decrypts their passwords with the OS keychain; the server
 * itself runs in a Node-mode child that inherits stdin/stdout.
 */
export async function runMcpMode(): Promise<void> {
  app.dock?.hide()
  await app.whenReady()
  await Promise.all([loadConnections(), loadSettings()])
  const only = argValue('--connection')
  const settings = getSettings()
  const config: McpChildConfig = {
    connections: listConnections().filter((c) => c.aiEnabled !== false && (!only || c.id === only || c.name === only)),
    allowWrites: settings.mcp.allowWrites,
    schemaOnly: settings.ai.dataSharing === 'schema',
    version: app.getVersion(),
  }
  const child = fork(join(__dirname, 'mcp-server.js'), [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  })
  child.send(config)
  child.on('exit', (code) => app.exit(code ?? 0))
}

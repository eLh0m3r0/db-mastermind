import { fork } from 'node:child_process'
import { join } from 'node:path'
import { app } from 'electron'
import { listConnections, loadConnections } from './connections'
import type { McpChildConfig } from './mcp-server'
import type { McpChildRequest, McpParentAnswer } from './mcp-live'
import { MCP_HISTORY_FILE } from './library'
import { agentConnections } from './ai-access'
import { managed, reloadManaged } from './managed'
import { dataPath } from './storage'
import { PROPOSALS_FOLDER } from './connection-proposals'
import { getSettings, loadSettings } from './settings'
import { invalidateTeam } from './team'

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
  await loadSettings()
  await loadConnections()
  if (managed()?.config.policies?.allowMcp === false) {
    process.stderr.write(`DB Mastermind: the MCP server is turned off by your organization (${managed()!.info.path})\n`)
    app.exit(1)
    return
  }
  const only = argValue('--connection')
  const settings = getSettings()
  const config: McpChildConfig = {
    connections: sharedWithAgents(only),
    allowWrites: settings.mcp.allowWrites,
    version: app.getVersion(),
    historyFile: dataPath(MCP_HISTORY_FILE),
    knownHostsFile: dataPath('known-hosts.json'),
    proposalsDir: dataPath(PROPOSALS_FOLDER),
  }
  const child = fork(join(__dirname, 'mcp-server.js'), [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  })
  child.send(config)
  // The child asks before each request that uses a connection: what the app saved since (a connection's AI turned
  // off or lowered, the organization's or the team's settings) applies to the next call. Answers go in order.
  let reading = Promise.resolve()
  child.on('message', (m: McpChildRequest) => {
    if (m?.type !== 'refresh') return
    reading = reading.then(async () => {
      let answer: McpParentAnswer
      try {
        answer = { type: 'connections', seq: m.seq, connections: await currentlyShared(only) }
      } catch {
        answer = { type: 'connections', seq: m.seq, error: 'Could not read the saved permissions' }
      }
      if (child.connected) child.send(answer)
    })
  })
  child.on('exit', (code) => app.exit(code ?? 0))
}

/** The connections agents may use, with their effective permissions (`aiAccess` decides), `--connection` applied. */
function sharedWithAgents(only: string | undefined) {
  return agentConnections(listConnections()).filter((c) => !only || c.id === only || c.name === only)
}

/** The same, read again from what the app saved: this process outlives changes made in the app. */
export async function currentlyShared(only: string | undefined) {
  reloadManaged()
  invalidateTeam()
  await loadSettings()
  await loadConnections()
  return sharedWithAgents(only)
}

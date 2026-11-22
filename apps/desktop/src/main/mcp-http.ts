import { agentConnections } from './ai-access'
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { app } from 'electron'
import { createMcpServer } from 'dbmastermind-mcp'
import { db } from './api'
import { listConnections } from './connections'
import { addHistory } from './library'
import { getSettings } from './settings'
import { guardMcpTransport, LiveConnections } from './mcp-live'
import { writeProposal } from './connection-proposals'
import { withCommandPassword } from './password-command'
import { notifyProposals, proposalsDir } from './proposals-watch'

let server: Server | undefined
let running: { port: number; token: string } | undefined
let lastError: string | undefined

export function mcpHttpStatus() {
  const { mcp } = getSettings()
  return { running: !!running, error: lastError, url: `http://127.0.0.1:${mcp.port}/mcp` }
}

function authorized(req: IncomingMessage, token: string): boolean {
  // An empty or short token (a hand-edited settings file) must never mean "no token needed".
  if (token.length < 16) return false
  // Exactly "Bearer <token>": a bare token is not accepted.
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')
  if (!m) return false
  const given = Buffer.from(m[1]!)
  const expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** Browsers send Origin; a web page must not reach the local endpoint (DNS rebinding). */
function trustedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  return !origin || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const { mcp } = getSettings()
  if (!req.url?.startsWith('/mcp')) {
    res.writeHead(404).end()
    return
  }
  if (!trustedOrigin(req) || !authorized(req, mcp.token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Unauthorized: send Authorization: Bearer <token> from Settings → MCP server' }))
    return
  }
  // Stateless: a fresh MCP server per request over the app's open connections (passwords stay in this process), with
  // the permissions `aiAccess` gives right now.
  const live = new LiveConnections(agentConnections(listConnections()), listConnections())
  const server = createMcpServer({
    db,
    connections: live.list,
    allowWrites: mcp.allowWrites,
    allowKnowledgeWrites: mcp.allowWrites,
    version: app.getVersion(),
    prepareConnection: (c) => withCommandPassword(c),
    proposeConnection: async (p) => {
      await writeProposal(proposalsDir(), p)
      notifyProposals()
    },
    onExecuted: (connectionId, o) =>
      addHistory({
        connectionId,
        sql: o.sql,
        executedAt: new Date().toISOString(),
        durationMs: o.durationMs,
        rowCount: o.results?.reduce((n, r) => n + r.rowCount, 0),
        error: o.error?.message,
        source: 'mcp',
      }),
  })
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  // Read when the request arrives (a connection whose AI was turned off gets a plain refusal, not "unknown").
  guardMcpTransport(transport, live, () => live.set(agentConnections(listConnections())))
  await transport.handleRequest(req, res)
}

/** Starts, restarts or stops the local HTTP endpoint to match the settings. */
export async function applyMcpHttp(): Promise<{ running: boolean; error?: string }> {
  const { mcp } = getSettings()
  if (running && mcp.enabled && running.port === mcp.port) return { running: true }
  if (server) {
    // Agents keep their connections open: without closing them, stopping or moving the endpoint waits for them.
    await new Promise<void>((resolve) => {
      server!.close(() => resolve())
      server!.closeAllConnections()
    })
    server = undefined
    running = undefined
  }
  lastError = undefined
  if (!mcp.enabled) return { running: false }
  const next = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      next.once('error', reject)
      next.listen(mcp.port, '127.0.0.1', () => resolve())
    })
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
    return { running: false, error: lastError }
  }
  lastError = undefined
  server = next
  running = { port: mcp.port, token: mcp.token }
  return { running: true }
}

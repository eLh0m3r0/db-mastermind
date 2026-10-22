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

let server: Server | undefined
let running: { port: number; token: string } | undefined
let lastError: string | undefined

export function mcpHttpStatus() {
  const { mcp } = getSettings()
  return { running: !!running, error: lastError, url: `http://127.0.0.1:${mcp.port}/mcp` }
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? ''
  const given = Buffer.from(header.replace(/^Bearer\s+/i, ''))
  const expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** Browsers send Origin; a web page must not reach the local endpoint (DNS rebinding). */
function trustedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  return !origin || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const { mcp, ai } = getSettings()
  if (!req.url?.startsWith('/mcp')) {
    res.writeHead(404).end()
    return
  }
  if (!trustedOrigin(req) || !authorized(req, mcp.token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Unauthorized: send Authorization: Bearer <token> from Settings → MCP server' }))
    return
  }
  // Stateless: a fresh MCP server per request over the app's open connections (passwords stay in this process).
  const server = createMcpServer({
    db,
    connections: agentConnections(listConnections()),
    allowWrites: mcp.allowWrites,
    allowKnowledgeWrites: mcp.allowWrites,
    schemaOnly: ai.dataSharing === 'schema',
    version: app.getVersion(),
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
  await transport.handleRequest(req, res)
}

/** Starts, restarts or stops the local HTTP endpoint to match the settings. */
export async function applyMcpHttp(): Promise<{ running: boolean; error?: string }> {
  const { mcp } = getSettings()
  if (running && mcp.enabled && running.port === mcp.port) return { running: true }
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
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

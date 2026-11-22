import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { app } from 'electron'
import { createMcpServer, type McpServerOptions } from 'dbmastermind-mcp'
import { guardMcpTransport, LiveConnections } from '../mcp-live'

/**
 * The app's own assistant, when it runs through an agent CLI (Claude Code), gets its database tools from this
 * process over MCP HTTP rather than from a separate `--mcp` process: the tools then use the chat's permissions and can
 * ask the user in the app before a write, like the API providers do. Each chat run has its own token and options;
 * the endpoint listens on 127.0.0.1 only. The options are made again for every request, so the permissions are the
 * ones the chat's connection has when a tool is called, not when the chat started.
 */

/** A chat run's endpoint: its options as of now, and the connection a request means. */
interface ChatRun {
  options: () => McpServerOptions
  connection: { id: string; name: string }
}

const runs = new Map<string, ChatRun>()
let server: Server | undefined
let port: Promise<number> | undefined

function listening(): Promise<number> {
  port ??= new Promise<number>((resolve, reject) => {
    server = createServer((req, res) => {
      handle(req, res).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
      })
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server!.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
  return port
}

function runFor(req: IncomingMessage): ChatRun | undefined {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')
  if (!m) return undefined
  const given = Buffer.from(m[1]!)
  for (const [token, run] of runs) {
    const expected = Buffer.from(token)
    if (given.length === expected.length && timingSafeEqual(given, expected)) return run
  }
  return undefined
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const run = req.url?.startsWith('/mcp') && !req.headers.origin ? runFor(req) : undefined
  if (!run) {
    res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Unauthorized' }))
    return
  }
  const options = run.options()
  // The chat's single connection, also when its AI was turned off since (the request then gets a plain refusal).
  const live = new LiveConnections(options.connections, [run.connection], run.connection.id)
  const mcp = createMcpServer({ version: app.getVersion(), ...options, connections: live.list })
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => {
    void transport.close()
    void mcp.close()
  })
  await mcp.connect(transport)
  guardMcpTransport(transport, live, () => live.set(run.options().connections))
  await transport.handleRequest(req, res)
}

/** An endpoint for one chat run on `connection`; `close` revokes its token. */
export async function chatMcpEndpoint(connection: { id: string; name: string }, options: () => McpServerOptions): Promise<{ url: string; headers: Record<string, string>; close: () => void }> {
  const token = randomBytes(24).toString('base64url')
  runs.set(token, { options, connection })
  const p = await listening()
  return { url: `http://127.0.0.1:${p}/mcp`, headers: { Authorization: `Bearer ${token}` }, close: () => runs.delete(token) }
}

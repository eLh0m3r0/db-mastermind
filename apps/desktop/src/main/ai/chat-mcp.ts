import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpServer, type McpServerOptions } from 'dbmastermind-mcp'

/**
 * The app's own assistant, when it runs through an agent CLI (Claude Code), gets its database tools from this
 * process over MCP HTTP rather than from a separate `--mcp` process: the tools then use the chat's permissions and can
 * ask the user in the app before a write, like the API providers do. Each chat run has its own token and options;
 * the endpoint listens on 127.0.0.1 only.
 */

const runs = new Map<string, McpServerOptions>()
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

function optionsFor(req: IncomingMessage): McpServerOptions | undefined {
  const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))
  for (const [token, options] of runs) {
    const expected = Buffer.from(token)
    if (given.length === expected.length && timingSafeEqual(given, expected)) return options
  }
  return undefined
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const options = req.url?.startsWith('/mcp') && !req.headers.origin ? optionsFor(req) : undefined
  if (!options) {
    res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Unauthorized' }))
    return
  }
  const mcp = createMcpServer(options)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => {
    void transport.close()
    void mcp.close()
  })
  await mcp.connect(transport)
  await transport.handleRequest(req, res)
}

/** An endpoint for one chat run; `close` revokes its token. */
export async function chatMcpEndpoint(options: McpServerOptions): Promise<{ url: string; headers: Record<string, string>; close: () => void }> {
  const token = randomBytes(24).toString('base64url')
  runs.set(token, options)
  const p = await listening()
  return { url: `http://127.0.0.1:${p}/mcp`, headers: { Authorization: `Bearer ${token}` }, close: () => runs.delete(token) }
}

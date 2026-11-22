/**
 * Permissions decided at the moment of use for the MCP servers the app runs (the HTTP endpoint, the assistant's
 * endpoint for agent CLIs, the `--mcp` child): before every request that uses a connection the list of connections
 * agents may use is brought up to date, and a request naming one that is no longer shared gets a plain refusal.
 * The server reads each connection's `ai` permissions from the list on every call, so the list is changed in place.
 * Must not import 'electron' (the `--mcp` child runs in plain Node).
 */
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { ConnectionConfig } from '@dbmastermind/core'

/** Requests that use a connection, or show which ones there are. */
const CHECKED = new Set(['tools/call', 'tools/list', 'resources/list', 'resources/read', 'prompts/get', 'prompts/list'])
/** Tools that name no connection. */
const NO_CONNECTION = new Set(['list_connections', 'propose_connection'])

export function noLongerShared(name: string): string {
  return `"${name}" is no longer shared with AI agents in DB Mastermind (its AI permissions, or your organization's or team's settings), so this was not run.`
}

export class LiveConnections {
  /** The list the MCP server is given; kept up to date in place. */
  readonly list: ConnectionConfig[]
  /** Every connection that was shared or that the caller knows of, by id: a refusal can name it. */
  private readonly known = new Map<string, string>()

  /**
   * @param known connections a refusal may name besides the shared ones (never their details)
   * @param defaultId the connection a request without one means (a server started with a single connection)
   */
  constructor(list: ConnectionConfig[], known: { id: string; name: string }[] = [], private readonly defaultId?: string) {
    this.list = [...list]
    for (const c of [...known, ...list]) this.known.set(c.id, c.name)
  }

  set(next: ConnectionConfig[]): void {
    this.list.splice(0, this.list.length, ...next)
    for (const c of next) this.known.set(c.id, c.name)
  }

  /** A plain refusal when `ref` (a connection's name or id, or none) is a connection agents may no longer use. */
  refusal(ref: string | undefined): string | undefined {
    const key = (ref ?? '').trim().toLowerCase()
    const shared = (id: string, name: string) => this.list.some((c) => c.id === id || c.name.toLowerCase() === name.toLowerCase())
    if (!key) {
      if (!this.defaultId) return undefined
      const name = this.known.get(this.defaultId) ?? this.defaultId
      return this.list.some((c) => c.id === this.defaultId) ? undefined : noLongerShared(name)
    }
    if (this.list.some((c) => c.id.toLowerCase() === key || c.name.toLowerCase() === key)) return undefined
    for (const [id, name] of this.known) if ((id.toLowerCase() === key || name.toLowerCase() === key) && !shared(id, name)) return noLongerShared(name)
    return undefined
  }
}

function connectionOf(message: { method: string; params?: Record<string, unknown> }): string | undefined {
  const params = message.params ?? {}
  if (message.method === 'resources/read') {
    const m = /^dbmastermind:\/\/([^/]+)\/schema$/.exec(String(params.uri ?? ''))
    return m ? decodeURIComponent(m[1]!) : undefined
  }
  const args = (params.arguments ?? {}) as Record<string, unknown>
  return args.connection === undefined || args.connection === null ? undefined : String(args.connection)
}

/**
 * Puts the check in front of a server already connected to `transport`: `refresh` brings `live` up to date (it may
 * read files or ask another process), then the request goes on to the server or gets the refusal as its answer.
 * Requests keep their order. If the permissions can't be read, the request is refused (never served on old ones).
 */
export function guardMcpTransport(transport: Transport, live: LiveConnections, refresh: () => Promise<void> | void): void {
  const deliver = transport.onmessage
  if (!deliver) throw new Error('Connect the MCP server to the transport first')
  let queue = Promise.resolve()
  const answer = (id: string | number, method: string, text: string) =>
    transport.send(
      method === 'tools/call'
        ? { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } }
        : { jsonrpc: '2.0', id, error: { code: -32600, message: text } },
    )
  transport.onmessage = (message: JSONRPCMessage, extra?: unknown) => {
    queue = queue
      .then(async () => {
        const request = message as { id?: string | number; method?: string; params?: Record<string, unknown> }
        if (request.id === undefined || !request.method || !CHECKED.has(request.method)) return deliver(message, extra as never)
        try {
          await refresh()
        } catch {
          return answer(request.id, request.method, 'DB Mastermind could not read the current AI permissions, so this was not run. Try again.')
        }
        const tool = request.method === 'tools/call' ? String(request.params?.name ?? '') : ''
        const text = request.method.endsWith('/list') || NO_CONNECTION.has(tool) ? undefined : live.refusal(connectionOf(request as { method: string; params?: Record<string, unknown> }))
        if (text === undefined) return deliver(message, extra as never)
        return answer(request.id, request.method, text)
      })
      .catch(() => undefined)
  }
}

/** Messages between the `--mcp` parent and this child after the start. */
export type McpChildRequest = { type: 'refresh'; seq: number }
export type McpParentAnswer = { type: 'connections'; seq: number; connections?: ConnectionConfig[]; error?: string }

/**
 * The connections agents may use right now, from the parent: it reads what the app saved (connections, settings, the
 * organization's managed configuration, the team folder) again for each request, so a permission changed in the app
 * after this server started applies to the next call.
 */
export function askParent(send: (m: McpChildRequest) => void, on: (listener: (m: unknown) => void) => () => void, timeoutMs = 10_000): () => Promise<ConnectionConfig[]> {
  let seq = 0
  return () =>
    new Promise((resolve, reject) => {
      const mine = ++seq
      const timer = setTimeout(() => (off(), reject(new Error('No answer from DB Mastermind'))), timeoutMs)
      const off = on((m) => {
        const answer = m as McpParentAnswer
        if (answer?.type !== 'connections' || answer.seq !== mine) return
        clearTimeout(timer)
        off()
        if (answer.connections) resolve(answer.connections)
        else reject(new Error(answer.error ?? 'No connections'))
      })
      try {
        send({ type: 'refresh', seq: mine })
      } catch (err) {
        clearTimeout(timer)
        off()
        reject(err)
      }
    })
}

import { addHistory } from '../library'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow } from 'electron'
import { jsonSchema, stepCountIs, streamText, tool, type ModelMessage, type ToolSet } from 'ai'
import { buildSystemPrompt, DB_TOOLS, isReadOnlyScript, describeError, KnowledgeBase, loadSqlTools, type ConnectionConfig, type EffectiveAiPermissions, type ToolContext } from '@dbmastermind/core'
import { AiProblem, explainAiError } from './errors'
import type { AiChatRequest, AiEvent } from '@shared/api'
import { db, ensureConnected } from '../api'
import { aiAccess } from '../ai-access'
import { chatMcpEndpoint } from './chat-mcp'
import { getConnection } from '../connections'
import { trackEditorSession } from '../transactions'
import { getSettings } from '../settings'
import { activeProvider } from './complete'
import { runCli } from './cli'
import { createModel } from './models'

const running = new Map<string, AbortController>()
const approvals = new Map<string, { chatId: string; kind: 'sql' | 'file'; resolve: (approved: boolean) => void }>()
/** Kinds the user approved for the rest of a chat ("Approve all"). */
const alwaysApproved = new Map<string, Set<'sql' | 'file'>>()

function send(event: AiEvent) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ai:event', event)
}

function askApproval(chatId: string, kind: 'sql' | 'file', detail: string, signal: AbortSignal): Promise<boolean> {
  if (alwaysApproved.get(chatId)?.has(kind)) return Promise.resolve(true)
  const id = randomUUID()
  send({ chatId, type: 'approval', id, kind, detail })
  return new Promise((resolve) => {
    approvals.set(id, { chatId, kind, resolve })
    signal.addEventListener('abort', () => {
      approvals.delete(id)
      resolve(false)
    })
  })
}

export function respondApproval(id: string, answer: boolean | 'always') {
  const pending = approvals.get(id)
  approvals.delete(id)
  if (!pending) return
  if (answer === 'always') {
    const set = alwaysApproved.get(pending.chatId) ?? new Set()
    set.add(pending.kind)
    alwaysApproved.set(pending.chatId, set)
  }
  pending.resolve(answer !== false)
}

/** The session a chat's confirmed writes run on with manual commit; the renderer uses the same name. */
export const aiSession = (chatId: string) => `ai-${chatId}`

export function cancelChat(chatId: string) {
  running.get(chatId)?.abort()
}

function mcpCommandFor(connectionId: string) {
  const args = [
    ...(app.isPackaged ? [] : [app.getAppPath()]),
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    '--mcp',
    '--connection',
    connectionId,
  ]
  return { command: process.execPath, args }
}

/** Starts a chat run in the background; every outcome, including setup errors, arrives as events. */
/** The provider in use, when there is one (for explaining an error that came before the chat started). */
function currentProvider() {
  try {
    return activeProvider()
  } catch {
    return undefined
  }
}

export function startChat(request: AiChatRequest): void {
  runChat(request).catch((err) => {
    const problem = explainAiError(err, currentProvider())
    send({ chatId: request.chatId, type: 'error', message: problem.message, code: (problem as AiProblem).code })
  })
}

/**
 * What AI may do in a chat right now: `aiAccess` is asked again for every tool call, every approval acted on and every
 * write about to run, so turning AI off or lowering it (in the app, the managed configuration or the team folder)
 * applies to a chat already running. A connection deleted meanwhile counts as off. `ask` asks the user.
 */
export function chatPermissions(connectionId: string, ask: (kind: 'sql' | 'file', detail: string) => Promise<boolean>, autoRunReadQueries: boolean) {
  const now = (): EffectiveAiPermissions => {
    try {
      return aiAccess(getConnection(connectionId))
    } catch {
      return { access: 'off', agents: false, agentWrites: false, knowledgeWrites: false }
    }
  }
  const name = () => {
    try {
      return getConnection(connectionId).name
    } catch {
      return connectionId
    }
  }
  const refusal = () => (now().access === 'off' ? `AI is turned off for "${name()}" now (its AI permissions in DB Mastermind), so this was not run.` : undefined)
  const writesOff = () => `AI may no longer change data in "${name()}" (its AI permissions in DB Mastermind), so this was not run.`

  /** A write the model asks for: the user confirms it, and it runs only if writes are still allowed then. */
  const confirmWrite = async (sql: string): Promise<boolean> => {
    if (now().access !== 'write') throw new Error(writesOff())
    const ok = await ask('sql', sql)
    if (ok && now().access !== 'write') throw new Error(writesOff())
    return ok
  }

  return {
    now,
    refusal,
    confirmWrite,
    /** The tools' context with the permissions of this moment. */
    context(base: ToolContext): ToolContext {
      const p = now()
      return { ...base, allowData: p.access === 'read' || p.access === 'write', allowKnowledgeWrites: p.knowledgeWrites, confirmWrite: p.access === 'write' ? confirmWrite : undefined }
    },
    /** The chat's connection for the agent CLIs' MCP endpoint, with the permissions of this moment (none when off). */
    mcpConnections(): ConnectionConfig[] {
      const p = now()
      if (p.access === 'off') return []
      return [{ ...getConnection(connectionId), ai: { access: p.access, agents: true, agentWrites: false, knowledgeWrites: p.knowledgeWrites } }]
    },
    /**
     * Asks the user before a tool when needed; a returned message is the tool's answer instead. Both chat paths use it.
     * The permissions are checked before and again after the user answered.
     */
    async gate(tool: string, input: Record<string, unknown>): Promise<string | undefined> {
      const off = refusal()
      if (off) return off
      if (tool === 'write_knowledge') {
        const ok = await ask('file', `${String(input.path)}\n\n${String(input.content ?? '').slice(0, 4000)}`)
        if (!ok) return 'The user declined to save this file.'
        if (!now().knowledgeWrites) return refusal() ?? `AI may no longer save knowledge base files for "${name()}", so this was not saved.`
      }
      if ((tool === 'run_query' || tool === 'sample_rows') && !autoRunReadQueries) {
        const sql = tool === 'run_query' ? String(input.sql ?? '') : `sample of ${String(input.table)}`
        // Writes are confirmed inside the tool; only reads need asking here.
        if (tool === 'sample_rows' || isReadOnlyScript(sql, getConnection(connectionId).driver)) {
          const ok = await ask('sql', sql)
          if (!ok) return 'The user declined to run this query.'
          const p = now()
          if (p.access === 'off') return refusal()
          if (p.access === 'schema') return `AI may see only the schema of "${name()}" now (its AI permissions in DB Mastermind), so this was not run.`
        }
      }
      return undefined
    },
  }
}

async function runChat(request: AiChatRequest): Promise<void> {
  const { chatId, connectionId } = request
  const settings = getSettings().ai
  const provider = activeProvider()
  const config = getConnection(connectionId)

  const controller = new AbortController()
  const signal = controller.signal
  const access = chatPermissions(connectionId, (kind, detail) => askApproval(chatId, kind, detail, signal), settings.autoRunReadQueries)
  if (access.now().access === 'off') throw new Error('AI is turned off for this connection (Settings → AI permissions)')
  // As every other request: the password command runs, and parallel connects share one attempt.
  await ensureConnected(connectionId)

  running.get(chatId)?.abort()
  running.set(chatId, controller)

  const base: ToolContext = {
    db,
    connectionId,
    knowledge: config.knowledgeBasePath ? new KnowledgeBase(config.knowledgeBasePath) : undefined,
    allowData: false,
    allowKnowledgeWrites: false,
    maxRows: 50,
    // Manual commit: what the user confirms waits in the chat's own transaction (the panel shows Commit / Roll back).
    writeSession: config.manualCommit && !config.readOnly ? aiSession(chatId) : undefined,
    onExecuted: (o) =>
      addHistory({
        connectionId,
        sql: o.sql,
        executedAt: new Date().toISOString(),
        durationMs: o.durationMs,
        rowCount: o.results?.reduce((n, r) => n + r.rowCount, 0),
        error: o.error?.message,
        source: 'ai',
      }),
  }
  const ctxNow = () => access.context(base)
  const ctx = ctxNow()
  const gate = access.gate

  if (ctx.writeSession) trackEditorSession(connectionId, ctx.writeSession)

  const extra = [
    request.context?.sql ? `The SQL currently in the user's editor:\n\`\`\`sql\n${request.context.sql}\n\`\`\`` : '',
    request.context?.table ? `The user is looking at table ${request.context.table}.` : '',
    request.context?.error ? `The last query failed with: ${request.context.error}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  try {
    const system = await buildSystemPrompt(ctx, extra)

    if (provider.id === 'claude-code' || provider.id === 'codex') {
      // Both agent CLIs get the tools from this process, so they follow the chat's permissions and a write is confirmed
      // in the app.
      const endpoint =
        provider.id === 'claude-code' || provider.id === 'codex'
          ? await chatMcpEndpoint({ id: config.id, name: config.name }, () => ({
              db,
              connections: access.mcpConnections(),
              confirmWrite: access.confirmWrite,
              writeSession: ctx.writeSession,
              beforeTool: gate,
              version: app.getVersion(),
              onExecuted: (_id, o) => ctx.onExecuted?.(o),
            }))
          : undefined
      const transcript = request.messages
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n\n')
      try {
        await runCli({
          provider: provider.id,
          prompt: request.messages.length > 1 ? `Conversation so far:\n\n${transcript}\n\nRespond to the last user message.` : (request.messages[0]?.content ?? ''),
          system,
          model: provider.model,
          mcp: endpoint ? { url: endpoint.url, headers: endpoint.headers } : mcpCommandFor(connectionId),
          signal,
          onEvent: (e) => {
            if (e.type === 'text') send({ chatId, type: 'text', text: `${e.text}\n\n` })
            else if (e.type === 'tool-start') send({ chatId, type: 'tool-start', id: e.id, name: e.name, input: e.input })
            else send({ chatId, type: 'tool-end', id: e.id, output: e.output, error: e.error })
          },
        })
      } finally {
        endpoint?.close()
      }
      send({ chatId, type: 'done' })
      return
    }

    const tools: ToolSet = {}
    for (const def of DB_TOOLS) {
      tools[def.name] = tool({
        description: def.description,
        inputSchema: jsonSchema<Record<string, unknown>>(def.inputSchema),
        execute: async (input: Record<string, unknown>) => {
          const stop = await gate(def.name, input)
          if (stop) return stop
          return def.run(ctxNow(), input)
        },
      })
    }

    // Team tools from the knowledge base (tools/*.sql): read-only, parameters bound.
    const { tools: teamTools } = await loadSqlTools(ctx.knowledge, Object.keys(tools))
    for (const def of teamTools) {
      tools[def.name] = tool({
        description: def.description,
        inputSchema: jsonSchema<Record<string, unknown>>(def.inputSchema),
        execute: async (input: Record<string, unknown>) => {
          const off = access.refusal()
          if (off) return off
          if (!settings.autoRunReadQueries) {
            const ok = await askApproval(chatId, 'sql', `${def.name}(${JSON.stringify(input)})`, signal)
            if (!ok) return 'The user declined to run this tool.'
          }
          return def.run(ctxNow(), input)
        },
      })
    }

    const messages: ModelMessage[] = request.messages.map((m) =>
      m.role === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', content: m.content },
    )

    const result = streamText({
      model: createModel(provider),
      system,
      messages,
      tools,
      stopWhen: stepCountIs(16),
      abortSignal: signal,
    })

    for await (const part of result.fullStream) {
      if (signal.aborted) break
      switch (part.type) {
        case 'text-delta':
          send({ chatId, type: 'text', text: part.text })
          break
        case 'tool-call':
          send({ chatId, type: 'tool-start', id: part.toolCallId, name: part.toolName, input: part.input })
          break
        case 'tool-result':
          send({ chatId, type: 'tool-end', id: part.toolCallId, output: String(part.output ?? '') })
          break
        case 'tool-error':
          send({ chatId, type: 'tool-end', id: part.toolCallId, output: describeError(part.error).message, error: true })
          break
        case 'error':
          throw part.error
        case 'finish':
          send({ chatId, type: 'usage', inputTokens: part.totalUsage.inputTokens ?? 0, outputTokens: part.totalUsage.outputTokens ?? 0 })
          break
      }
    }
    send({ chatId, type: 'done' })
  } catch (err) {
    if (signal.aborted) send({ chatId, type: 'done' })
    else {
      const problem = explainAiError(err, provider)
      send({ chatId, type: 'error', message: problem.message, code: (problem as AiProblem).code })
    }
  } finally {
    if (running.get(chatId) === controller) running.delete(chatId)
  }
}

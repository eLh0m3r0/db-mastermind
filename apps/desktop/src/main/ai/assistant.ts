import { randomUUID } from 'node:crypto'
import { app, BrowserWindow } from 'electron'
import { jsonSchema, stepCountIs, streamText, tool, type ModelMessage, type ToolSet } from 'ai'
import { buildSystemPrompt, classifyStatement, DB_TOOLS, describeError, KnowledgeBase, type ToolContext } from '@dbmastermind/core'
import type { AiChatRequest, AiEvent } from '@shared/api'
import { db } from '../api'
import { getConnection } from '../connections'
import { getSettings } from '../settings'
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

export function cancelChat(chatId: string) {
  running.get(chatId)?.abort()
}

function mcpCommandFor(connectionId: string) {
  const args = app.isPackaged ? ['--mcp', '--connection', connectionId] : [app.getAppPath(), '--mcp', '--connection', connectionId]
  return { command: process.execPath, args }
}

/** Starts a chat run in the background; every outcome, including setup errors, arrives as events. */
export function startChat(request: AiChatRequest): void {
  runChat(request).catch((err) => send({ chatId: request.chatId, type: 'error', message: describeError(err).message }))
}

async function runChat(request: AiChatRequest): Promise<void> {
  const { chatId, connectionId } = request
  const settings = getSettings().ai
  const provider = settings.providers.find((p) => p.id === settings.activeProvider)
  if (!provider) throw new Error('Choose an AI provider in Settings → AI assistant')
  const config = getConnection(connectionId)
  if (config.aiEnabled === false) throw new Error('AI is turned off for this connection (connection settings → Advanced)')
  if (!db.isOpen(connectionId)) await db.connect(config)

  const controller = new AbortController()
  running.get(chatId)?.abort()
  running.set(chatId, controller)
  const signal = controller.signal

  const ctx: ToolContext = {
    db,
    connectionId,
    knowledge: config.knowledgeBasePath ? new KnowledgeBase(config.knowledgeBasePath) : undefined,
    allowData: settings.dataSharing !== 'schema',
    allowKnowledgeWrites: true,
    confirmWrite: (sql) => askApproval(chatId, 'sql', sql, signal),
    maxRows: 50,
  }

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
      const transcript = request.messages
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n\n')
      await runCli({
        provider: provider.id,
        prompt: request.messages.length > 1 ? `Conversation so far:\n\n${transcript}\n\nRespond to the last user message.` : (request.messages[0]?.content ?? ''),
        system,
        model: provider.model,
        mcp: mcpCommandFor(connectionId),
        signal,
        onEvent: (e) => {
          if (e.type === 'text') send({ chatId, type: 'text', text: `${e.text}\n\n` })
          else if (e.type === 'tool-start') send({ chatId, type: 'tool-start', id: e.id, name: e.name, input: e.input })
          else send({ chatId, type: 'tool-end', id: e.id, output: e.output, error: e.error })
        },
      })
      send({ chatId, type: 'done' })
      return
    }

    const tools: ToolSet = {}
    for (const def of DB_TOOLS) {
      tools[def.name] = tool({
        description: def.description,
        inputSchema: jsonSchema<Record<string, unknown>>(def.inputSchema),
        execute: async (input: Record<string, unknown>) => {
          if (def.name === 'write_knowledge') {
            const ok = await askApproval(chatId, 'file', `${String(input.path)}\n\n${String(input.content ?? '').slice(0, 4000)}`, signal)
            if (!ok) return 'The user declined to save this file.'
          }
          if ((def.name === 'run_query' || def.name === 'sample_rows') && !settings.autoRunReadQueries) {
            const sql = def.name === 'run_query' ? String(input.sql ?? '') : `sample of ${String(input.table)}`
            // Writes are confirmed inside the tool; only reads need asking here.
            if (def.name === 'sample_rows' || classifyStatement(sql) === 'read') {
              const ok = await askApproval(chatId, 'sql', sql, signal)
              if (!ok) return 'The user declined to run this query.'
            }
          }
          return def.run(ctx, input)
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
    else send({ chatId, type: 'error', message: describeError(err).message })
  } finally {
    if (running.get(chatId) === controller) running.delete(chatId)
  }
}

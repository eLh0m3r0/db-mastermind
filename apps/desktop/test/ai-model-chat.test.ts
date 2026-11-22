import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiChatRequest, AiEvent } from '../src/shared/api'

/**
 * A chat about a model (the model tab's Design with AI and its tasks, the panel with a model in front) is about the
 * model's text: main opens no connection, offers no database tool, and still needs a provider and AI allowed by the
 * organization.
 */

const state = vi.hoisted(() => ({
  events: [] as AiEvent[],
  managed: null as unknown,
  provider: 'openai' as string | undefined,
  touched: [] as string[],
  cli: [] as unknown[],
  model: undefined as unknown,
}))
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', isPackaged: false, getAppPath: () => '' },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: (_channel: string, event: AiEvent) => void state.events.push(event) } }] },
}))
vi.mock('../src/main/api', () => ({
  get db() {
    state.touched.push('db')
    return {}
  },
  ensureConnected: async (id: string) => void state.touched.push(`connect ${id}`),
}))
vi.mock('../src/main/connections', () => ({
  listConnections: () => (state.touched.push('list connections'), []),
  getConnection: (id: string) => {
    state.touched.push(`connection ${id}`)
    throw new Error('Connection not found')
  },
}))
vi.mock('../src/main/settings', () => ({
  getSettings: () => ({
    ai: { providers: state.provider ? [{ id: state.provider, enabled: true, model: 'm' }] : [], activeProvider: state.provider, dataSharing: 'schema-and-samples', autoRunReadQueries: true },
    mcp: { allowWrites: false },
  }),
}))
vi.mock('../src/main/managed', () => ({ managedConfig: () => state.managed }))
vi.mock('../src/main/team', () => ({ team: () => null }))
vi.mock('../src/main/library', () => ({ addHistory: () => undefined }))
vi.mock('../src/main/transactions', () => ({ trackEditorSession: () => undefined }))
vi.mock('../src/main/ai/cli', () => ({
  runCli: async (options: { onEvent: (e: unknown) => void }) => {
    state.cli.push(options)
    options.onEvent({ type: 'text', text: 'Looks fine.\n```dbml\nTable a { id int [pk] }\n```' })
  },
}))
vi.mock('../src/main/ai/models', () => ({ createModel: () => state.model }))

const { startChat, modelSystemPrompt } = await import('../src/main/ai/assistant')

const MODEL = 'Table customers {\n  id int [pk]\n  email varchar\n}'
const request = (extra: Partial<AiChatRequest> = {}): AiChatRequest => ({
  chatId: `chat-${Math.random()}`,
  connectionId: '',
  model: { name: 'shop.dbml' },
  messages: [{ role: 'user', content: 'Review the model' }],
  context: { model: MODEL },
  ...extra,
})

function streamingModel() {
  return new MockLanguageModelV4({
    doStream: {
      stream: convertArrayToReadableStream([
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Add a unique email.\n```dbml\nTable customers {\n  id int [pk]\n  email varchar [unique]\n}\n```' },
        { type: 'text-end', id: 't' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: undefined },
          usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
        },
      ]),
    },
  })
}

/** Runs a chat and waits for its last event. */
async function chat(r: AiChatRequest): Promise<AiEvent[]> {
  startChat(r)
  await vi.waitFor(() => expect(state.events.some((e) => e.chatId === r.chatId && (e.type === 'done' || e.type === 'error'))).toBe(true))
  return state.events.filter((e) => e.chatId === r.chatId)
}

beforeEach(() => {
  state.events = []
  state.managed = null
  state.provider = 'openai'
  state.touched = []
  state.cli = []
  state.model = streamingModel()
})

describe('a chat about a model', () => {
  it('answers with no database tool offered and no connection opened', async () => {
    const events = await chat(request())
    expect(events.map((e) => e.type)).toContain('done')
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toContain('```dbml')
    const call = (state.model as MockLanguageModelV4).doStreamCalls[0]!
    expect(call.tools ?? []).toEqual([])
    // The model's text and name are what it is about.
    const system = JSON.stringify(call.prompt)
    expect(system).toContain('shop.dbml')
    expect(system).toContain('email varchar')
    expect(system).toMatch(/no database is connected and you have no tools/)
    expect(state.touched).toEqual([])
  })

  it('never touches a connection, even when the request names one', async () => {
    await chat(request({ connectionId: 'shop' }))
    expect(state.touched).toEqual([])
    expect((state.model as MockLanguageModelV4).doStreamCalls[0]!.tools ?? []).toEqual([])
  })

  it('an agent CLI gets no MCP endpoint, only the model', async () => {
    state.provider = 'claude-code'
    const events = await chat(request())
    expect(events.at(-1)!.type).toBe('done')
    const options = state.cli[0] as { mcp?: unknown; system: string; prompt: string }
    expect(options.mcp).toBeUndefined()
    expect(options.system).toContain('email varchar')
    expect(options.prompt).toBe('Review the model')
    expect(state.touched).toEqual([])
  })

  it('AI turned off by the organization refuses it, without asking the model', async () => {
    state.managed = { policies: { allowAi: false } }
    const events = await chat(request())
    expect(events.at(-1)).toMatchObject({ type: 'error' })
    expect((events.at(-1) as { message: string }).message).toMatch(/turned off by your organization/)
    expect((state.model as MockLanguageModelV4).doStreamCalls).toHaveLength(0)
    expect(state.cli).toHaveLength(0)
  })

  it('needs an AI provider set up', async () => {
    state.provider = undefined
    const events = await chat(request())
    expect(events.at(-1)).toMatchObject({ type: 'error' })
    expect((state.model as MockLanguageModelV4).doStreamCalls).toHaveLength(0)
  })

  it('a database chat without a model still needs its connection (unchanged)', async () => {
    const events = await chat(request({ model: undefined, connectionId: 'shop' }))
    expect(events.at(-1)).toMatchObject({ type: 'error' })
    expect(state.touched).toContain('connection shop')
  })

  it('a model too long to send whole is never offered back as a whole model', () => {
    // (An applied ```dbml block replaces the model: of a model seen in part it would delete the rest.)
    const table = (n: number) => `Table t${n} {\n  id integer [pk]\n  name text\n}\n`
    const small = modelSystemPrompt('shop.dbml', table(1))
    expect(small).toContain('complete updated model in one ```dbml block')
    expect(small).toContain('Table t1')
    const big = modelSystemPrompt('shop.dbml', Array.from({ length: 8000 }, (_, n) => table(n)).join(''))
    expect(big.length).toBeLessThan(210_000)
    expect(big).toContain('Never reply with a ```dbml block')
    expect(big).not.toContain('complete updated model')
    expect(big).toContain('the rest of the model is left out')
    expect(modelSystemPrompt('new', '  ')).toContain('The model is empty so far.')
  })
})

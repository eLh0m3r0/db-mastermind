import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { ArrowUp, BookOpen, Check, ChevronRight, History, MessageSquare, Pencil, Plus, Settings2, Sparkles, Square, Trash2, Wrench, X } from 'lucide-react'
import { designFromDbml } from '@dbmastermind/core/browser'
import type { AiChatSummary, AiEvent } from '@shared/api'
import { askText, confirmAction } from '@/components/ui/ConfirmDialog'
import { Button, IconButton } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Spinner } from '@/components/ui/Spinner'
import { api, bridge, keys } from '@/lib/api'
import { runCommand } from '@/lib/commands'
import { cn, uid } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { useSettings } from '@/store/settings'
import { toast, useUi } from '@/store/ui'
import { useActiveTab, useWorkspace } from '@/store/workspace'
import { useCurrentConnectionId } from '../sidebar/Sidebar'
import { useAiAccess } from './AiPermissions'
import { Markdown } from './Markdown'
import { providerMeta } from './providers'
import { refreshTransaction, settleTransactions } from '@/store/transactions'
import { TransactionBar } from '@/features/query/TransactionBar'
import { formatDate, t as translate, tp, useT } from '@/lib/i18n'
import { aiProblemText } from '@/lib/ai-problems'
import { activeAiProvider, openAiSettings } from '@/lib/ai-error-toast'

type Part =
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; input: unknown; output?: string; error?: boolean }
  | { type: 'approval'; id: string; kind: 'sql' | 'file'; detail: string; answer?: boolean }

interface Message {
  id: string
  role: 'user' | 'assistant'
  parts: Part[]
  error?: string
  /** main/ai/errors.ts's code for the error, when it knows what happened. */
  errorCode?: string
  /** Instructions that go to the model with the text but aren't shown (Design with AI's: what to reply with). */
  hidden?: string
}

interface Chat {
  id: string
  messages: Message[]
  running: boolean
}

interface ChatStore {
  chats: Record<string, Chat>
  /** Connections whose last saved chat was already looked up this session. */
  restored: Record<string, boolean>
  get(connectionId: string): Chat
  update(connectionId: string, fn: (chat: Chat) => Chat): void
  reset(connectionId: string): void
  /** Opens a saved chat (or the newest one when `id` is omitted). */
  open(connectionId: string, id?: string): Promise<void>
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Chats are kept between sessions (main process, ai-chats.json); saved shortly after each change. */
function scheduleSave(connectionId: string, chat: Chat) {
  if (!chat.messages.length) return
  clearTimeout(saveTimers.get(chat.id))
  saveTimers.set(
    chat.id,
    setTimeout(() => {
      saveTimers.delete(chat.id)
      const first = chat.messages.find((m) => m.role === 'user')
      const title = first ? messageText(first).replace(/\s+/g, ' ').slice(0, 80) : undefined
      void api.saveAiChat({ id: chat.id, connectionId, title, messages: chat.messages }).catch(() => {})
    }, 400),
  )
}

const useChats = create<ChatStore>((set, get) => ({
  chats: {},
  restored: {},
  get: (connectionId) => get().chats[connectionId] ?? { id: uid('chat'), messages: [], running: false },
  update: (connectionId, fn) => {
    const next = fn(get().get(connectionId))
    set((s) => ({ chats: { ...s.chats, [connectionId]: next } }))
    scheduleSave(connectionId, next)
  },
  reset: (connectionId) =>
    set((s) => {
      const chats = { ...s.chats }
      const old = chats[connectionId]
      if (old?.running) void api.cancelAiChat(old.id)
      delete chats[connectionId]
      return { chats, restored: { ...s.restored, [connectionId]: true } }
    }),
  open: async (connectionId, id) => {
    set((s) => ({ restored: { ...s.restored, [connectionId]: true } }))
    const target = id ?? (await api.listAiChats(connectionId))[0]?.id
    const saved = target ? await api.getAiChat(target) : null
    if (!saved) return
    const old = get().chats[connectionId]
    if (old?.running) void api.cancelAiChat(old.id)
    // A question that waited for an answer when the app closed can't be answered any more.
    const messages = (saved.messages as Message[]).map((m) => ({
      ...m,
      parts: m.parts.map((p) => (p.type === 'approval' && p.answer === undefined ? { ...p, answer: false } : p)),
    }))
    set((s) => ({ chats: { ...s.chats, [connectionId]: { id: saved.id, messages, running: false } } }))
  },
}))

/** The session the chat's confirmed writes run on with manual commit (main/ai/assistant.ts aiSession). */
export const aiSession = (chatId: string) => `ai-${chatId}`

/**
 * A chat about a model's text belongs to the model: its file, or its tab while it has none. Its key stands where a
 * connection's id stands for a database chat (the chat store, saved chats, history search).
 */
export function modelChatKey(tab: { id: string; path?: string; source?: { path: string } }): string {
  return `model:${tab.path ?? tab.source?.path ?? tab.id}`
}
const isModelChat = (key: string) => key.startsWith('model:')

/** Before leaving a chat: its open transaction is committed or rolled back, then its session closes. */
async function leaveChat(connectionId: string): Promise<boolean> {
  const old = useChats.getState().chats[connectionId]
  if (!old || isModelChat(connectionId)) return true
  const session = aiSession(old.id)
  if (!(await settleTransactions([session], () => translate('AI assistant')))) return false
  void api.releaseSession(connectionId, session).catch(() => {})
  return true
}

// Route streamed events to the chat that owns them.
bridge.on('ai:event', (event: AiEvent) => {
  const store = useChats.getState()
  const entry = Object.entries(store.chats).find(([, c]) => c.id === event.chatId)
  if (!entry) return
  const [connectionId] = entry
  // A statement the assistant ran may have opened (or ended) the chat's transaction.
  if (event.type === 'tool-end') {
    const part = entry[1].messages.at(-1)?.parts.find((p) => p.type === 'tool' && p.id === event.id) as Extract<Part, { type: 'tool' }> | undefined
    if (part && /run_query$/.test(part.name)) {
      const sql = String((part.input as { sql?: unknown } | null)?.sql ?? '')
      void refreshTransaction(aiSession(event.chatId), connectionId, sql ? [{ sql, start: 0, end: sql.length, durationMs: 0, ...(event.error ? { error: { message: String(event.error) } } : {}) }] : [])
    }
  }
  store.update(connectionId, (chat) => {
    const messages = [...chat.messages]
    let last = messages.at(-1)
    if (!last || last.role !== 'assistant') {
      last = { id: uid('m'), role: 'assistant', parts: [] }
      messages.push(last)
    }
    const msg: Message = { ...last, parts: [...last.parts] }
    messages[messages.length - 1] = msg
    switch (event.type) {
      case 'text': {
        const tail = msg.parts.at(-1)
        if (tail?.type === 'text') msg.parts[msg.parts.length - 1] = { ...tail, text: tail.text + event.text }
        else msg.parts.push({ type: 'text', text: event.text })
        break
      }
      case 'tool-start':
        msg.parts.push({ type: 'tool', id: event.id, name: event.name, input: event.input })
        break
      case 'tool-end': {
        const idx = msg.parts.findIndex((p) => p.type === 'tool' && p.id === event.id)
        if (idx >= 0) msg.parts[idx] = { ...(msg.parts[idx] as Extract<Part, { type: 'tool' }>), output: event.output, error: event.error }
        else msg.parts.push({ type: 'tool', id: event.id, name: 'tool', input: null, output: event.output, error: event.error })
        break
      }
      case 'approval':
        msg.parts.push({ type: 'approval', id: event.id, kind: event.kind, detail: event.detail })
        break
      case 'error':
        msg.error = event.message
        msg.errorCode = event.code
        return { ...chat, messages, running: false }
      case 'done':
        return { ...chat, messages, running: false }
    }
    return { ...chat, messages }
  })
})

function messageText(m: Message): string {
  return m.parts
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
    .trim()
}

const SUGGESTIONS = [
  'Give me a short tour of this database',
  'Which tables store customers and their orders?',
  'Find tables that have no primary key',
  'Document this database into the knowledge base',
]

export function AiPanel() {
  const currentConnectionId = useCurrentConnectionId()
  const activeTab = useActiveTab()
  const modelTab = activeTab?.kind === 'model' ? activeTab : undefined
  // A model tab's own database only (not the one picked in the sidebar).
  const databaseId = modelTab ? modelTab.connectionId || undefined : currentConnectionId
  const connection = useConnections((s) => s.list.find((c) => c.id === databaseId))
  const status = useConnections((s) => (databaseId ? s.runtime[databaseId]?.status : undefined))
  const access = useAiAccess(connection)
  /**
   * With a model in front, the chat is about its database only while that database is open and allows AI; otherwise it
   * is about the model's text, with no database tools, so nothing from a database goes into a chat about a file.
   */
  const modelChat = !!modelTab && !(connection && status === 'connected' && access !== 'off')
  const modelName = modelTab ? ((modelTab.path ?? modelTab.source?.path)?.split(/[\\/]/).pop() || modelTab.title) : ''
  // Whose chat it is: the model's (modelChatKey) or the database's.
  const connectionId = modelChat && modelTab ? modelChatKey(modelTab) : databaseId
  const settings = useSettings((s) => s.settings)
  const chat = useChats((s) => (connectionId ? (s.chats[connectionId] ?? null) : null))
  const update = useChats((s) => s.update)
  const reset = useChats((s) => s.reset)
  const setUi = useUi((s) => s.set)
  const [input, setInput] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  // Hidden instructions and a placeholder that a request (Design with AI) leaves for the next message.
  const pendingContext = useRef<string | undefined>(undefined)
  const [placeholder, setPlaceholder] = useState<string>()
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const provider = settings?.ai.providers.find((p) => p.id === settings.ai.activeProvider)
  const meta = providerMeta(provider?.id)
  const t = useT()

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [chat?.messages])

  // The connection's last chat comes back after a restart.
  const restored = useChats((s) => (connectionId ? s.restored[connectionId] : true))
  useEffect(() => {
    if (connectionId && !restored && !useChats.getState().chats[connectionId]) void useChats.getState().open(connectionId)
  }, [connectionId, restored])
  useEffect(() => setShowHistory(false), [connectionId])


  const send = (text: string) => {
    if (!connectionId || !text.trim()) return
    const current = useChats.getState().get(connectionId)
    if (current.running) return
    const userMsg: Message = { id: uid('m'), role: 'user', parts: [{ type: 'text', text: text.trim() }], ...(pendingContext.current ? { hidden: pendingContext.current } : {}) }
    pendingContext.current = undefined
    setPlaceholder(undefined)
    const messages = [...current.messages, userMsg]
    update(connectionId, () => ({ ...current, messages, running: true }))
    setInput('')
    const context: { sql?: string; table?: string; model?: string } = {}
    if (activeTab?.connectionId === connectionId && activeTab.kind === 'query' && activeTab.sql.trim()) context.sql = activeTab.sql.slice(0, 8000)
    if (activeTab?.connectionId === connectionId && activeTab.kind === 'table') context.table = activeTab.table.name
    // A chat about a model gets the model as it is now (an answer applied since changed it).
    const model = modelChat && modelTab ? useWorkspace.getState().tabs.find((x) => x.id === modelTab.id) : undefined
    if (model?.kind === 'model') context.model = model.text
    void api.aiChat({
      chatId: current.id,
      connectionId: modelChat ? '' : connectionId,
      ...(modelChat ? { model: { name: modelName } } : {}),
      messages: messages.map((m) => ({ role: m.role, content: m.hidden ? `${m.hidden}\n\n${messageText(m)}` : messageText(m) || '(tool calls only)' })),
      context,
    })
  }

  const aiRequest = useUi((s) => s.aiRequest)
  useEffect(() => {
    if (!aiRequest) return
    useUi.getState().set({ aiRequest: undefined })
    void (async () => {
      // A task of its own (Explain with AI, Design with AI) starts a new chat: it doesn't continue whatever was open.
      if (aiRequest.newChat && connectionId && useChats.getState().chats[connectionId]?.messages.length) {
        if (!(await leaveChat(connectionId))) return
        reset(connectionId)
        setShowHistory(false)
      }
      pendingContext.current = aiRequest.context
      setPlaceholder(aiRequest.placeholder)
      if (aiRequest.prompt && aiRequest.send && (modelChat || status === 'connected') && !useChats.getState().chats[connectionId ?? '']?.running) send(aiRequest.prompt)
      else if (aiRequest.prompt) setInput(aiRequest.prompt)
      requestAnimationFrame(() => inputRef.current?.focus())
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiRequest])

  const stop = () => {
    if (!connectionId || !chat) return
    void api.cancelAiChat(chat.id)
    update(connectionId, (c) => ({ ...c, running: false }))
  }

  const answerApproval = (messageId: string, partId: string, answer: boolean | 'always') => {
    if (!connectionId) return
    const approved = answer !== false
    void api.respondAiApproval(partId, answer)
    update(connectionId, (c) => ({
      ...c,
      messages: c.messages.map((m) =>
        m.id !== messageId ? m : { ...m, parts: m.parts.map((p) => (p.type === 'approval' && p.id === partId ? { ...p, answer: approved } : p)) },
      ),
    }))
  }

  const insertSql = (sql: string) => {
    if (!connectionId) return
    const ws = useWorkspace.getState()
    const tab = ws.tabs.find((t) => t.id === ws.activeTabId)
    if (tab?.kind === 'query' && tab.connectionId === connectionId) {
      window.dispatchEvent(new CustomEvent('editor:insert', { detail: { tabId: tab.id, text: sql, block: true } }))
    } else ws.newQuery(connectionId, sql)
  }

  const applyModel = (dbml: string) => {
    if (!connectionId) return
    const ws = useWorkspace.getState()
    const active = ws.tabs.find((x) => x.id === ws.activeTabId)
    const target =
      active?.kind === 'model' ? active : ws.tabs.find((x) => x.kind === 'model' && (modelChat ? modelChatKey(x) === connectionId : x.connectionId === connectionId))
    if (target) {
      ws.update(target.id, { text: dbml, dirty: true })
      ws.activate(target.id)
    } else ws.open({ kind: 'model', connectionId: modelChat ? '' : connectionId, title: t('Model'), text: dbml }, { reuse: false })
  }

  // With a live ER diagram open, DBML from the assistant becomes pending design changes (reviewed as a migration).
  const diagramTab = useWorkspace((s) => {
    const active = s.tabs.find((x) => x.id === s.activeTabId)
    return active?.kind === 'diagram' && active.connectionId === connectionId ? active : undefined
  })
  const applyDesign = (dbml: string) => {
    if (!diagramTab || !connectionId) return
    const schema = useConnections.getState().runtime[connectionId]?.schema
    if (!schema) return
    const { drafts, errors } = designFromDbml(dbml, schema.tables, { defaultSchema: schema.defaultSchema })
    if (errors.length) {
      toast({ kind: 'error', message: t('The DBML has errors'), detail: errors.map((e) => `${t('line {n}', { n: String(e.line) })}: ${e.message}`).join('\n') })
      return
    }
    const current = useWorkspace.getState().tabs.find((x) => x.id === diagramTab.id)
    useWorkspace.getState().update(diagramTab.id, { design: { ...(current?.kind === 'diagram' ? current.design : undefined), ...drafts } })
    toast({ kind: 'success', message: tp(Object.keys(drafts).length, { one: '{n} table in the design', many: '{n} tables in the design' }), detail: t('Review the migration in the diagram toolbar.') })
  }

  const runSql = (sql: string) => {
    if (!connectionId) return
    useWorkspace.getState().newQuery(connectionId, sql, t('AI query'))
    // Let the new editor mount, then run it.
    setTimeout(() => runCommand('run-all'), 150)
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-subtle">
      {/* title-band: a look that colors the title bar colors this header too, so the bar runs on. */}
      <div className="title-band flex h-[38px] shrink-0 items-center gap-1.5 border-b border-line px-2.5">
        <Sparkles size={14} className="shrink-0 text-accent" />
        {/* The title on one line; which provider and model answer goes under it (it used to push the title onto two). */}
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="text-[12.5px] font-semibold whitespace-nowrap">{t('AI assistant')}</span>
          {meta && (
            <span className="truncate text-[10.5px] text-fg-faint" title={`${meta.label}${provider?.model ? ` · ${provider.model}` : ''}`} data-testid="ai-provider-line">
              {meta.label.replace(/ \(.*\)$/, '')}
              {provider?.model ? ` · ${provider.model}` : ''}
            </span>
          )}
        </div>
        <div className="flex-1" />
        <IconButton label={t('Chat history')} disabled={!connectionId} onClick={() => setShowHistory((v) => !v)} className={cn(showHistory && 'bg-muted text-fg')}>
          <History size={13} />
        </IconButton>
        <IconButton
          label={t('New chat')}
          disabled={!connectionId}
          onClick={async () => {
            if (!connectionId || !(await leaveChat(connectionId))) return
            reset(connectionId)
            setShowHistory(false)
            requestAnimationFrame(() => inputRef.current?.focus())
          }}
        >
          <Plus size={14} />
        </IconButton>
        <IconButton label={t('AI settings')} onClick={() => setUi({ modal: { kind: 'settings', section: 'ai' } })}>
          <Settings2 size={13} />
        </IconButton>
        <IconButton label={t('Close')} onClick={() => setUi({ aiPanelVisible: false })}>
          <X size={14} />
        </IconButton>
      </div>

      {!provider ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <Sparkles size={26} className="text-accent" />
          <div className="text-[13px] font-medium">{t('Connect an AI model')}</div>
          <p className="text-[12px] leading-relaxed text-fg-muted">
            {t('Use your own API key (Claude, OpenAI, OpenRouter, Gemini, Azure), a local model with Ollama, or your existing Claude Code / Codex subscription.')}
          </p>
          <Button variant="primary" onClick={() => setUi({ modal: { kind: 'settings', section: 'ai' } })}>
            {t('Set up AI')}
          </Button>
        </div>
      ) : !modelChat && !connection ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-[12px] text-fg-faint">{t('Connect to a database to chat about it.')}</div>
      ) : !modelChat && access === 'off' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <Sparkles size={26} className="text-fg-faint" />
          <div className="text-[13px] font-medium">{t('AI is turned off for {name}', { name: connection?.name ?? '' })}</div>
          <p className="text-[12px] leading-relaxed text-fg-muted">{t('Nothing from this connection is sent to an AI model. You can allow it in AI permissions.')}</p>
          <Button onClick={() => setUi({ modal: { kind: 'settings', section: 'permissions' } })}>{t('AI permissions')}</Button>
        </div>
      ) : showHistory && connectionId ? (
        <ChatHistory
          connectionId={connectionId}
          currentId={chat?.id}
          onOpen={async (id) => {
            if (!(await leaveChat(connectionId))) return
            void useChats.getState().open(connectionId, id)
            setShowHistory(false)
          }}
          leaveCurrent={() => leaveChat(connectionId)}
          onDeletedCurrent={() => reset(connectionId)}
        />
      ) : (
        <>
          <div ref={listRef} className="min-h-0 flex-1 overflow-auto px-3 py-3">
            {(!chat || chat.messages.length === 0) && modelChat && (
              <div className="flex flex-col gap-2 pt-4">
                <div className="mb-1 text-[12.5px] text-fg-muted">
                  {t('Ask anything about')} <b className="text-fg">{modelName}</b>. {t('The assistant sees only the text of the model, no database.')}
                </div>
              </div>
            )}
            {(!chat || chat.messages.length === 0) && !modelChat && connection && (
              <div className="flex flex-col gap-2 pt-4">
                <div className="mb-1 text-[12.5px] text-fg-muted">
                  {t('Ask anything about')} <b className="text-fg">{connection.name}</b>.{' '}
                  {access === 'schema'
                    ? connection.knowledgeBasePath
                      ? t('The assistant reads the schema and your knowledge base, but not the data in tables.')
                      : t('The assistant reads the schema, but not the data in tables.')
                    : access === 'write'
                      ? connection.knowledgeBasePath
                        ? t('The assistant reads the schema and your knowledge base and runs queries; it asks before changing anything.')
                        : t('The assistant reads the schema and runs queries; it asks before changing anything.')
                      : connection.knowledgeBasePath
                        ? t('The assistant reads the schema and your knowledge base and can run read-only queries.')
                        : t('The assistant reads the schema and can run read-only queries.')}
                </div>
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" onClick={() => send(t(s))} className="rounded-md border border-line bg-bg px-2.5 py-2 text-left text-[12px] hover:border-accent/60 hover:bg-hover" disabled={status !== 'connected'}>
                    {t(s)}
                  </button>
                ))}
                {!connection.knowledgeBasePath && (
                  <button
                    type="button"
                    className="mt-2 flex items-center gap-1.5 text-[11.5px] text-accent hover:underline"
                    onClick={() => useWorkspace.getState().open({ kind: 'knowledge', connectionId: connection.id, title: t('Knowledge base') })}
                  >
                    <BookOpen size={12} /> {t('Set up a knowledge base for better answers')}
                  </button>
                )}
              </div>
            )}
            {chat?.messages.map((m) =>
              m.role === 'user' ? (
                <div key={m.id} className="mb-3 ml-8 rounded-lg bg-accent-soft px-3 py-2 text-[12.5px] whitespace-pre-wrap select-text">
                  {messageText(m)}
                </div>
              ) : (
                <div key={m.id} className="mb-3">
                  {m.parts.map((p, i) =>
                    p.type === 'text' ? (
                      <Markdown key={i} text={p.text} actions={{ onInsert: modelChat ? undefined : insertSql, onRun: modelChat ? undefined : runSql, onApplyModel: applyModel, onApplyDesign: diagramTab ? applyDesign : undefined }} />
                    ) : p.type === 'tool' ? (
                      <ToolCall key={p.id || i} part={p} />
                    ) : (
                      <div key={p.id} className="my-2 rounded-md border border-warning/40 bg-warning-soft p-2.5">
                        <div className="mb-1.5 text-[11.5px] font-semibold text-warning">
                          {p.kind === 'file' ? t('Save this knowledge base file?') : t('Run this statement?')}
                        </div>
                        <pre className="max-h-48 overflow-auto rounded bg-bg p-2 font-mono text-[11px] whitespace-pre-wrap select-text">{p.detail}</pre>
                        {p.answer === undefined ? (
                          <div className="mt-2 flex gap-1.5">
                            <Button size="xs" variant="primary" icon={<Check size={11} />} onClick={() => answerApproval(m.id, p.id, true)}>
                              {p.kind === 'file' ? t('Save') : t('Run')}
                            </Button>
                            <Button size="xs" variant="ghost" onClick={() => answerApproval(m.id, p.id, 'always')} title={t('Approve this and every later request of this kind in this chat')}>
                              {p.kind === 'file' ? t('Save all') : t('Run all in this chat')}
                            </Button>
                            <Button size="xs" onClick={() => answerApproval(m.id, p.id, false)}>
                              {t('Decline')}
                            </Button>
                          </div>
                        ) : (
                          <div className="mt-1.5 text-[11px] text-fg-muted">{p.answer ? t('Approved') : t('Declined')}</div>
                        )}
                      </div>
                    ),
                  )}
                  {m.error && <ChatError message={m.error} code={m.errorCode} />}
                </div>
              ),
            )}
            {chat?.running && (
              <div className="flex items-center gap-2 text-[12px] text-fg-faint">
                <Spinner size={12} /> {t('Thinking…')}
              </div>
            )}
          </div>
          <div className="border-t border-line p-2">
            {chat && connection && !modelChat && (
              <div className="mb-1.5 flex justify-end empty:hidden">
                <TransactionBar tabId={aiSession(chat.id)} driver={connection.driver} manual={false} busy={chat.running} />
              </div>
            )}
            <div data-focus-frame className="flex items-end gap-1.5 rounded-lg border border-line bg-bg p-1.5 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    send(input)
                  }
                }}
                rows={Math.min(8, Math.max(2, input.split('\n').length))}
                placeholder={placeholder ?? (modelChat || !connection ? t('What should change in the model?') : t('Ask about the {name} database…', { name: connection.name }))}
                className="max-h-48 min-h-[36px] flex-1 resize-none bg-transparent px-1.5 py-1 text-[12.5px] outline-none placeholder:text-fg-faint"
              />
              {chat?.running ? (
                <IconButton label={t('Stop')} size="md" onClick={stop} className="bg-muted">
                  <Square size={12} fill="currentColor" />
                </IconButton>
              ) : (
                <IconButton label={t('Send (Enter)')} size="md" disabled={!input.trim() || (!modelChat && status !== 'connected')} onClick={() => send(input)} className="bg-accent text-accent-fg hover:bg-accent-hover hover:text-accent-fg">
                  <ArrowUp size={14} />
                </IconButton>
              )}
            </div>
            <div className="mt-1 px-1 text-[10.5px] text-fg-faint">
              {t('Enter to send · Shift+Enter for a new line · {shortcut} toggles this panel', { shortcut: keys('⌘J') })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function ToolCall({ part }: { part: Extract<Part, { type: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const input = part.input as Record<string, unknown> | null
  const summary = input ? String(input.sql ?? input.table ?? input.query ?? input.path ?? '').replace(/\s+/g, ' ').slice(0, 80) : ''
  return (
    <div className="my-1.5 rounded-md border border-line bg-bg text-[11.5px]">
      <button type="button" className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-fg-muted hover:text-fg" onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={11} className={cn('shrink-0 transition-transform', open && 'rotate-90')} />
        {part.output === undefined ? <Spinner size={11} /> : <Wrench size={11} className={part.error ? 'text-danger' : 'text-accent'} />}
        <span className="shrink-0 font-medium whitespace-nowrap">{part.name.replaceAll('_', ' ')}</span>
        <span className="truncate font-mono text-fg-faint">{summary}</span>
      </button>
      {open && (
        <div className="border-t border-line p-2">
          {input && Object.keys(input).length > 0 && <pre className="mb-1.5 overflow-auto font-mono text-[10.5px] whitespace-pre-wrap text-fg-muted select-text">{JSON.stringify(input, null, 2)}</pre>}
          {part.output !== undefined && <pre className="max-h-64 overflow-auto font-mono text-[10.5px] whitespace-pre-wrap select-text">{part.output}</pre>}
        </div>
      )}
    </div>
  )
}

/** The connection's saved chats: open, rename, delete. */
function ChatHistory({
  connectionId,
  currentId,
  onOpen,
  leaveCurrent,
  onDeletedCurrent,
}: {
  connectionId: string
  currentId?: string
  onOpen: (id: string) => void
  /** The current chat's open transaction is settled before it is deleted (false: the user kept it). */
  leaveCurrent: () => Promise<boolean>
  onDeletedCurrent: () => void
}) {
  const t = useT()
  const [chats, setChats] = useState<AiChatSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [anySaved, setAnySaved] = useState(true)
  const latest = useRef(0)
  const load = (q = query) => {
    const request = ++latest.current
    void api.listAiChats(connectionId, q).then((list) => {
      if (request !== latest.current) return // a newer search answered meanwhile
      setChats(list)
      if (!q.trim()) setAnySaved(list.length > 0)
    })
  }
  useEffect(() => {
    // Typing searches after a short pause; opening the list (no query) loads at once.
    const timer = setTimeout(() => load(query), query.trim() ? 150 : 0)
    return () => clearTimeout(timer)
  }, [connectionId, query])

  const rename = async (c: AiChatSummary) => {
    const title = await askText({ title: t('Rename chat'), value: c.title, confirmLabel: t('Rename') })
    if (!title?.trim()) return
    await api.renameAiChat(c.id, title)
    load()
  }
  const remove = async (c: AiChatSummary) => {
    if (!(await confirmAction({ title: t('Delete this chat?'), message: c.title, confirmLabel: t('Delete'), danger: true }))) return
    if (c.id === currentId && !(await leaveCurrent())) return
    await api.deleteAiChat(c.id)
    if (c.id === currentId) onDeletedCurrent()
    load()
  }

  if (!chats) return <div className="flex flex-1 items-center justify-center"><Spinner /></div>
  if (!anySaved && !query.trim()) return <div className="flex flex-1 items-center justify-center p-6 text-center text-[12px] text-fg-faint">{t('No saved chats yet. Chats are kept here when you ask something.')}</div>
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 pt-2">
        <Input
          inputSize="sm"
          autoFocus
          placeholder={t('Search chats…')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.stopPropagation()
              setQuery('')
            }
            if (e.key === 'Enter' && chats[0]) onOpen(chats[0].id)
          }}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {!chats.length && <div className="p-4 text-center text-[12px] text-fg-faint">{t('No chats contain “{query}”', { query: query.trim() })}</div>}
        {chats.map((c) => (
          <div key={c.id} className={cn('group flex items-center gap-1 rounded-md pr-1 hover:bg-muted', c.id === currentId && 'bg-muted')}>
            <button type="button" className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left" onClick={() => onOpen(c.id)}>
              <MessageSquare size={13} className="mt-0.5 shrink-0 text-fg-faint" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px]">{c.title}</span>
                {c.snippet && <span className="line-clamp-2 block text-[11.5px] break-words text-fg-muted">{c.snippet}</span>}
                <span className="block text-[11px] text-fg-faint">
                  {formatDate(c.updatedAt)} · {tp(c.messageCount, { one: '{n} message', many: '{n} messages' })}
                </span>
              </span>
            </button>
            <IconButton label={t('Rename chat')} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => void rename(c)}>
              <Pencil size={12} />
            </IconButton>
            <IconButton label={t('Delete chat')} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => void remove(c)}>
              <Trash2 size={12} />
            </IconButton>
          </div>
        ))}
      </div>
    </div>
  )
}

/** A failed answer: what happened (in the UI's language), the provider's words, and AI settings when they fix it. */
function ChatError({ message, code }: { message: string; code?: string }) {
  const t = useT()
  const p = aiProblemText(message, code, activeAiProvider(), t)
  return (
    <div className="my-2 flex flex-col gap-1 rounded-md border border-danger/30 bg-danger-soft p-2.5 text-[12px] select-text" data-testid="ai-chat-error">
      {p.summary && <span className="font-medium text-fg">{p.summary}</span>}
      {p.detail && <span className={p.summary ? 'text-fg-muted' : 'text-danger'}>{p.detail}</span>}
      {p.settings && (
        <button type="button" className="self-start font-medium text-accent hover:underline" onClick={openAiSettings}>
          {t('Open AI settings')}
        </button>
      )}
    </div>
  )
}

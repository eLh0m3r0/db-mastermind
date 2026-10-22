import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { ArrowUp, BookOpen, Check, ChevronRight, Plus, Settings2, Sparkles, Square, Wrench, X } from 'lucide-react'
import type { AiEvent } from '@shared/api'
import { Button, IconButton } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { api, bridge, modKey } from '@/lib/api'
import { runCommand } from '@/lib/commands'
import { cn, uid } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { useSettings } from '@/store/settings'
import { useUi } from '@/store/ui'
import { useActiveTab, useWorkspace } from '@/store/workspace'
import { useCurrentConnectionId } from '../sidebar/Sidebar'
import { Markdown } from './Markdown'
import { providerMeta } from './providers'

type Part =
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; input: unknown; output?: string; error?: boolean }
  | { type: 'approval'; id: string; kind: 'sql' | 'file'; detail: string; answer?: boolean }

interface Message {
  id: string
  role: 'user' | 'assistant'
  parts: Part[]
  error?: string
}

interface Chat {
  id: string
  messages: Message[]
  running: boolean
}

interface ChatStore {
  chats: Record<string, Chat>
  get(connectionId: string): Chat
  update(connectionId: string, fn: (chat: Chat) => Chat): void
  reset(connectionId: string): void
}

const useChats = create<ChatStore>((set, get) => ({
  chats: {},
  get: (connectionId) => get().chats[connectionId] ?? { id: uid('chat'), messages: [], running: false },
  update: (connectionId, fn) => set((s) => ({ chats: { ...s.chats, [connectionId]: fn(s.get(connectionId)) } })),
  reset: (connectionId) =>
    set((s) => {
      const chats = { ...s.chats }
      const old = chats[connectionId]
      if (old?.running) void api.cancelAiChat(old.id)
      delete chats[connectionId]
      return { chats }
    }),
}))

// Route streamed events to the chat that owns them.
bridge.on('ai:event', (event: AiEvent) => {
  const store = useChats.getState()
  const entry = Object.entries(store.chats).find(([, c]) => c.id === event.chatId)
  if (!entry) return
  const [connectionId] = entry
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
  const connectionId = useCurrentConnectionId()
  const connection = useConnections((s) => s.list.find((c) => c.id === connectionId))
  const status = useConnections((s) => (connectionId ? s.runtime[connectionId]?.status : undefined))
  const settings = useSettings((s) => s.settings)
  const chat = useChats((s) => (connectionId ? (s.chats[connectionId] ?? null) : null))
  const update = useChats((s) => s.update)
  const reset = useChats((s) => s.reset)
  const setUi = useUi((s) => s.set)
  const activeTab = useActiveTab()
  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const provider = settings?.ai.providers.find((p) => p.id === settings.ai.activeProvider)
  const meta = providerMeta(provider?.id)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [chat?.messages])

  useEffect(() => {
    const onAsk = (e: Event) => {
      const detail = (e as CustomEvent<{ sql?: string; prompt?: string }>).detail
      if (detail?.prompt) setInput(detail.prompt)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
    window.addEventListener('ai:ask', onAsk)
    return () => window.removeEventListener('ai:ask', onAsk)
  }, [])

  const send = (text: string) => {
    if (!connectionId || !text.trim()) return
    const current = useChats.getState().get(connectionId)
    if (current.running) return
    const userMsg: Message = { id: uid('m'), role: 'user', parts: [{ type: 'text', text: text.trim() }] }
    const messages = [...current.messages, userMsg]
    update(connectionId, () => ({ ...current, messages, running: true }))
    setInput('')
    const context: { sql?: string; table?: string } = {}
    if (activeTab?.connectionId === connectionId && activeTab.kind === 'query' && activeTab.sql.trim()) context.sql = activeTab.sql.slice(0, 8000)
    if (activeTab?.connectionId === connectionId && activeTab.kind === 'table') context.table = activeTab.table.name
    void api.aiChat({
      chatId: current.id,
      connectionId,
      messages: messages.map((m) => ({ role: m.role, content: messageText(m) || '(tool calls only)' })),
      context,
    })
  }

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
      window.dispatchEvent(new CustomEvent('editor:insert', { detail: { tabId: tab.id, text: sql } }))
    } else ws.newQuery(connectionId, sql)
  }

  const runSql = (sql: string) => {
    if (!connectionId) return
    useWorkspace.getState().newQuery(connectionId, sql, 'AI query')
    // Let the new editor mount, then run it.
    setTimeout(() => runCommand('run-all'), 150)
  }

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-line bg-subtle">
      <div className="flex h-[38px] shrink-0 items-center gap-1.5 border-b border-line px-2.5">
        <Sparkles size={14} className="text-accent" />
        <span className="text-[12.5px] font-semibold">AI assistant</span>
        {meta && (
          <span className="truncate text-[11px] text-fg-faint" title={provider?.model}>
            · {meta.label.replace(/ \(.*\)$/, '')}
            {provider?.model ? ` · ${provider.model}` : ''}
          </span>
        )}
        <div className="flex-1" />
        <IconButton label="New chat" disabled={!connectionId} onClick={() => connectionId && reset(connectionId)}>
          <Plus size={14} />
        </IconButton>
        <IconButton label="AI settings" onClick={() => setUi({ modal: { kind: 'settings', section: 'ai' } })}>
          <Settings2 size={13} />
        </IconButton>
        <IconButton label="Close" onClick={() => setUi({ aiPanelVisible: false })}>
          <X size={14} />
        </IconButton>
      </div>

      {!provider ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <Sparkles size={26} className="text-accent" />
          <div className="text-[13px] font-medium">Connect an AI model</div>
          <p className="text-[12px] leading-relaxed text-fg-muted">
            Use your own API key (Claude, OpenAI, OpenRouter, Gemini, Azure), a local model with Ollama, or your existing Claude Code / Codex
            subscription.
          </p>
          <Button variant="primary" onClick={() => setUi({ modal: { kind: 'settings', section: 'ai' } })}>
            Set up AI
          </Button>
        </div>
      ) : !connection ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-[12px] text-fg-faint">Connect to a database to chat about it.</div>
      ) : (
        <>
          <div ref={listRef} className="min-h-0 flex-1 overflow-auto px-3 py-3">
            {(!chat || chat.messages.length === 0) && (
              <div className="flex flex-col gap-2 pt-4">
                <div className="mb-1 text-[12.5px] text-fg-muted">
                  Ask anything about <b className="text-fg">{connection.name}</b>. The assistant reads the schema
                  {connection.knowledgeBasePath ? ' and your knowledge base' : ''} and can run read-only queries.
                </div>
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" onClick={() => send(s)} className="rounded-md border border-line bg-bg px-2.5 py-2 text-left text-[12px] hover:border-accent/60 hover:bg-hover" disabled={status !== 'connected'}>
                    {s}
                  </button>
                ))}
                {!connection.knowledgeBasePath && (
                  <button
                    type="button"
                    className="mt-2 flex items-center gap-1.5 text-[11.5px] text-accent hover:underline"
                    onClick={() => useWorkspace.getState().open({ kind: 'knowledge', connectionId: connection.id, title: 'Knowledge base' })}
                  >
                    <BookOpen size={12} /> Set up a knowledge base for better answers
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
                      <Markdown key={i} text={p.text} actions={{ onInsert: insertSql, onRun: runSql }} />
                    ) : p.type === 'tool' ? (
                      <ToolCall key={p.id || i} part={p} />
                    ) : (
                      <div key={p.id} className="my-2 rounded-md border border-warning/40 bg-warning-soft p-2.5">
                        <div className="mb-1.5 text-[11.5px] font-semibold text-warning">
                          {p.kind === 'file' ? 'Save this knowledge base file?' : 'Run this statement?'}
                        </div>
                        <pre className="max-h-48 overflow-auto rounded bg-bg p-2 font-mono text-[11px] whitespace-pre-wrap select-text">{p.detail}</pre>
                        {p.answer === undefined ? (
                          <div className="mt-2 flex gap-1.5">
                            <Button size="xs" variant="primary" icon={<Check size={11} />} onClick={() => answerApproval(m.id, p.id, true)}>
                              {p.kind === 'file' ? 'Save' : 'Run'}
                            </Button>
                            <Button size="xs" variant="ghost" onClick={() => answerApproval(m.id, p.id, 'always')} title="Approve this and every later request of this kind in this chat">
                              {p.kind === 'file' ? 'Save all' : 'Run all in this chat'}
                            </Button>
                            <Button size="xs" onClick={() => answerApproval(m.id, p.id, false)}>
                              Decline
                            </Button>
                          </div>
                        ) : (
                          <div className="mt-1.5 text-[11px] text-fg-muted">{p.answer ? 'Approved' : 'Declined'}</div>
                        )}
                      </div>
                    ),
                  )}
                  {m.error && <div className="my-2 rounded-md border border-danger/30 bg-danger-soft p-2.5 text-[12px] text-danger select-text">{m.error}</div>}
                </div>
              ),
            )}
            {chat?.running && (
              <div className="flex items-center gap-2 text-[12px] text-fg-faint">
                <Spinner size={12} /> Thinking…
              </div>
            )}
          </div>
          <div className="border-t border-line p-2">
            <div className="flex items-end gap-1.5 rounded-lg border border-line bg-bg p-1.5 focus-within:border-accent">
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
                placeholder={`Ask about ${connection.name}…`}
                className="max-h-48 min-h-[36px] flex-1 resize-none bg-transparent px-1.5 py-1 text-[12.5px] outline-none placeholder:text-fg-faint"
              />
              {chat?.running ? (
                <IconButton label="Stop" size="md" onClick={stop} className="bg-muted">
                  <Square size={12} fill="currentColor" />
                </IconButton>
              ) : (
                <IconButton label="Send (Enter)" size="md" disabled={!input.trim() || status !== 'connected'} onClick={() => send(input)} className="bg-accent text-accent-fg hover:bg-accent-hover hover:text-accent-fg">
                  <ArrowUp size={14} />
                </IconButton>
              )}
            </div>
            <div className="mt-1 px-1 text-[10.5px] text-fg-faint">
              Enter to send · Shift+Enter for a new line · {modKey}J toggles this panel
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

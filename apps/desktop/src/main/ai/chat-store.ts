import { readJson, writeJson } from '../storage'
import type { AiStoredChat, AiChatSummary } from '@shared/api'

/**
 * Assistant chats kept between sessions (ai-chats.json in the data folder): the newest 50 per connection, long tool
 * outputs cut, so the file stays small. Messages are stored as the renderer gives them.
 */
const FILE = 'ai-chats.json'
const PER_CONNECTION = 50
const MAX_TOOL_OUTPUT = 4000

let cache: AiStoredChat[] | undefined
const all = (): AiStoredChat[] => (cache ??= readJson<{ chats?: AiStoredChat[] }>(FILE, {}).chats ?? [])
const persist = () => writeJson(FILE, { chats: all() })

function trim(messages: unknown[]): unknown[] {
  return messages.map((m) => {
    const msg = m as { parts?: { type?: string; output?: string }[] }
    if (!Array.isArray(msg.parts)) return m
    return {
      ...msg,
      parts: msg.parts.map((p) => (p.type === 'tool' && typeof p.output === 'string' && p.output.length > MAX_TOOL_OUTPUT ? { ...p, output: `${p.output.slice(0, MAX_TOOL_OUTPUT)}\n…` } : p)),
    }
  })
}

export function listChats(connectionId: string): AiChatSummary[] {
  return all()
    .filter((c) => c.connectionId === connectionId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(({ id, title, updatedAt, messages }) => ({ id, title, updatedAt, messageCount: messages.length }))
}

export function getChat(id: string): AiStoredChat | null {
  return all().find((c) => c.id === id) ?? null
}

export function saveChat(chat: Omit<AiStoredChat, 'updatedAt' | 'title'> & { title?: string }): void {
  const chats = all()
  const existing = chats.find((c) => c.id === chat.id)
  const stored: AiStoredChat = {
    ...chat,
    title: existing?.title || chat.title || 'Chat',
    messages: trim(chat.messages),
    updatedAt: new Date().toISOString(),
  }
  const rest = chats.filter((c) => c.id !== chat.id)
  const mine = [stored, ...rest.filter((c) => c.connectionId === chat.connectionId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))]
  cache = [...rest.filter((c) => c.connectionId !== chat.connectionId), ...mine.slice(0, PER_CONNECTION)]
  persist()
}

export function renameChat(id: string, title: string): void {
  const chat = all().find((c) => c.id === id)
  if (!chat || !title.trim()) return
  chat.title = title.trim()
  persist()
}

export function deleteChat(id: string): void {
  cache = all().filter((c) => c.id !== id)
  persist()
}

/** Chats of a deleted connection go with it. */
export function deleteChatsOf(connectionId: string): void {
  if (!all().some((c) => c.connectionId === connectionId)) return
  cache = all().filter((c) => c.connectionId !== connectionId)
  persist()
}

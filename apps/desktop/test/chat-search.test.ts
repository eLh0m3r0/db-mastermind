import { describe, expect, it, vi } from 'vitest'

const text = (t: string) => ({ type: 'text', text: t })
const chats = [
  { id: 'a', connectionId: 'c1', title: 'Monthly revenue', updatedAt: '2026-10-20T10:00:00Z', messages: [{ role: 'user', parts: [text('Jaký byl příjem za září?')] }, { role: 'assistant', parts: [{ type: 'tool', name: 'run_query', input: { sql: 'SELECT sum(total) FROM invoices' } }, text('Příjem za září byl 120 000 Kč.')] }] },
  { id: 'b', connectionId: 'c1', title: 'Customers', updatedAt: '2026-10-21T10:00:00Z', messages: [{ role: 'user', parts: [text('Which customers ordered twice?')] }] },
  { id: 'c', connectionId: 'c2', title: 'Other database', updatedAt: '2026-10-22T10:00:00Z', messages: [{ role: 'user', parts: [text('příjem')] }] },
]
vi.mock('../src/main/storage', () => ({ readJson: () => ({ chats }), writeJson: () => undefined }))

const { listChats } = await import('../src/main/ai/chat-store')

describe('listChats search', () => {
  it('lists a connection\'s chats newest first', () => {
    expect(listChats('c1').map((c) => c.id)).toEqual(['b', 'a'])
  })

  it('finds words in messages and SQL, ignoring case and diacritics, with a snippet', () => {
    const [hit, ...rest] = listChats('c1', 'PRIJEM zari')
    expect(rest).toEqual([])
    expect(hit).toMatchObject({ id: 'a', snippet: 'Jaký byl příjem za září?' })
    expect(listChats('c1', 'invoices').map((c) => c.id)).toEqual(['a'])
    expect(listChats('c1', 'customers').map((c) => c.id)).toEqual(['b'])
    expect(listChats('c1', 'příjem customers')).toEqual([])
  })
})

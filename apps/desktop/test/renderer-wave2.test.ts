import { describe, expect, it } from 'vitest'
import { lockHolder } from '../src/renderer/src/features/table/lock-holder'
import { topQueriesReason } from '../src/renderer/src/features/activity/health-text'
import { analysable } from '../src/renderer/src/features/query/analyse-limit'
import { cs } from '../src/renderer/src/lib/i18n-cs'

describe('Not saved: the rows are locked', () => {
  const tx = (connectionId: string) => ({ connectionId })

  it('names the one other tab that holds a transaction, never the tab itself', () => {
    expect(lockHolder({ table1: tx('c'), query2: tx('c') }, 'c', 'table1')).toEqual({ session: 'query2', ai: false })
    expect(lockHolder({ table1: tx('c') }, 'c', 'table1')).toBeUndefined()
  })

  it('says nothing it can’t tell: several candidates, or another connection', () => {
    expect(lockHolder({ a: tx('c'), b: tx('c') }, 'c', 'table1')).toBeUndefined()
    expect(lockHolder({ a: tx('other') }, 'c', 'table1')).toBeUndefined()
  })

  it('an AI chat’s session is the AI assistant, not a tab', () => {
    expect(lockHolder({ 'ai-123': tx('c') }, 'c', undefined)).toEqual({ session: 'ai-123', ai: true })
  })
})

describe('Top queries: why they can’t be shown', () => {
  const czech = (text: string, vars: Record<string, string> = {}) => (cs[text] ?? text).replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m)

  it('the templated message from core reaches the Czech UI translated, the server’s own error as it is', () => {
    const reason = 'The server did not allow reading its statement statistics: permission denied for view pg_stat_statements. It needs the pg_read_all_stats role to see other users’ statements.'
    const out = topQueriesReason(reason, czech)
    expect(out).toContain('permission denied for view pg_stat_statements')
    expect(out).not.toContain('The server did not allow')
    expect(out).not.toContain('It needs')
  })

  it('a message without a hint, and any other message, still come through', () => {
    expect(topQueriesReason('The server did not allow reading its statement statistics: boom.', (x, v) => (v ? `${x}|${v.error}|${v.hint}` : x))).toBe('The server did not allow reading its statement statistics: {error}. {hint}|boom|')
    expect(topQueriesReason('This database does not keep statement statistics the app can read.', czech)).toBe(cs['This database does not keep statement statistics the app can read.'])
  })
})

describe('the editor on a large file', () => {
  it('stops checking and ⌘-hover parsing above the limit', () => {
    expect(analysable(10_000)).toBe(true)
    expect(analysable(5_000_000)).toBe(false)
  })
})

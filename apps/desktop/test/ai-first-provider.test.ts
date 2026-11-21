import { describe, expect, it } from 'vitest'
import { withProviderEdit } from '../src/renderer/src/features/ai/providers'

const none = { providers: [] } as never

describe('setting up AI the first time', () => {
  it('the provider whose key is pasted becomes the one in use, without "Use this provider"', () => {
    const ai = withProviderEdit(none, 'openrouter', { apiKey: 'sk-or-test' })
    expect(ai.activeProvider).toBe('openrouter')
    expect(ai.providers).toEqual([{ id: 'openrouter', enabled: true, apiKey: 'sk-or-test' }])
  })

  it('a provider without a key is in use once its address or model is there', () => {
    expect(withProviderEdit(none, 'openai-compatible', { baseUrl: 'http://127.0.0.1:1234/v1' }).activeProvider).toBe('openai-compatible')
    expect(withProviderEdit(none, 'claude-code', { model: 'sonnet' }).activeProvider).toBe('claude-code')
    expect(withProviderEdit(none, 'ollama', {}).activeProvider).toBeUndefined()
  })

  it('an empty key or a half-filled Azure deployment changes nothing yet', () => {
    expect(withProviderEdit(none, 'anthropic', { apiKey: '  ' }).activeProvider).toBeUndefined()
    expect(withProviderEdit(none, 'azure', { apiKey: 'k' }).activeProvider).toBeUndefined()
    expect(withProviderEdit(none, 'azure', { apiKey: 'k', resourceName: 'corp' }).activeProvider).toBe('azure')
  })

  it('never takes over from the provider already in use', () => {
    const ai = withProviderEdit({ activeProvider: 'anthropic', providers: [{ id: 'anthropic', enabled: true, apiKey: 'a' }] } as never, 'openrouter', { apiKey: 'b' })
    expect(ai.activeProvider).toBe('anthropic')
    expect(ai.providers.map((p) => p.id)).toEqual(['anthropic', 'openrouter'])
  })
})

import type { AiProviderId, AiProviderSettings, AiSettings } from '@shared/api'

export interface ProviderMeta {
  id: AiProviderId
  label: string
  description: string
  needsKey: boolean
  needsBaseUrl?: boolean
  baseUrlPlaceholder?: string
  needsResource?: boolean
  keyUrl?: string
  kind: 'api' | 'local' | 'subscription'
}

export const PROVIDERS: ProviderMeta[] = [
  { id: 'anthropic', label: 'Anthropic (Claude)', description: 'Claude models with your Anthropic API key.', needsKey: true, keyUrl: 'https://console.anthropic.com/settings/keys', kind: 'api' },
  { id: 'openai', label: 'OpenAI', description: 'GPT models with your OpenAI API key.', needsKey: true, keyUrl: 'https://platform.openai.com/api-keys', kind: 'api' },
  { id: 'openrouter', label: 'OpenRouter', description: 'Hundreds of models (Claude, GPT, Gemini, Llama, DeepSeek…) with one key.', needsKey: true, keyUrl: 'https://openrouter.ai/keys', kind: 'api' },
  { id: 'gemini', label: 'Google Gemini', description: 'Gemini models with a Google AI Studio key.', needsKey: true, keyUrl: 'https://aistudio.google.com/apikey', kind: 'api' },
  { id: 'azure', label: 'Azure OpenAI', description: 'Your company’s Azure OpenAI deployment.', needsKey: true, needsResource: true, kind: 'api' },
  { id: 'ollama', label: 'Ollama (local)', description: 'Models running on this computer. Data never leaves your machine.', needsKey: false, needsBaseUrl: true, baseUrlPlaceholder: 'http://localhost:11434', kind: 'local' },
  { id: 'openai-compatible', label: 'OpenAI-compatible', description: 'LM Studio, vLLM, LiteLLM, company gateways…', needsKey: false, needsBaseUrl: true, baseUrlPlaceholder: 'http://localhost:1234/v1', kind: 'local' },
  { id: 'claude-code', label: 'Claude Code (subscription)', description: 'Uses your installed Claude Code CLI and your Claude subscription.', needsKey: false, kind: 'subscription' },
  { id: 'codex', label: 'Codex CLI (ChatGPT, beta)', description: 'Uses your installed Codex CLI and your ChatGPT subscription.', needsKey: false, kind: 'subscription' },
]

export function providerMeta(id: AiProviderId | undefined): ProviderMeta | undefined {
  return PROVIDERS.find((p) => p.id === id)
}

/** Enough is filled in to try the provider: its key, or for one without a key its address or model. */
export function providerReady(meta: ProviderMeta, config: AiProviderSettings): boolean {
  if (meta.needsKey) return !!config.apiKey?.trim() && (!meta.needsResource || !!config.resourceName?.trim())
  if (meta.needsBaseUrl) return !!config.baseUrl?.trim() || !!config.model?.trim()
  return !!config.model?.trim()
}

/**
 * The AI settings after a provider's fields change. With no provider in use yet, the first one that is ready becomes
 * the one in use: people paste a key and close Settings, and AI was still off until "Use this provider".
 */
export function withProviderEdit(ai: AiSettings, id: AiProviderId, patch: Partial<AiProviderSettings>): AiSettings {
  const current = ai.providers.find((p) => p.id === id) ?? { id, enabled: true }
  const next = { ...current, ...patch }
  const providers = ai.providers.some((p) => p.id === id) ? ai.providers.map((p) => (p.id === id ? next : p)) : [...ai.providers, next]
  const meta = providerMeta(id)
  const activate = !ai.activeProvider && !!meta && providerReady(meta, next)
  return { ...ai, providers, ...(activate ? { activeProvider: id } : {}) }
}

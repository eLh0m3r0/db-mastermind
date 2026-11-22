import type { AiProviderSettings } from '@shared/api'

/**
 * An AI error from main (main/ai/errors.ts) in the UI's language: main sends a code with its English sentence on the
 * first line and the provider's own words after it. `settings`: AI settings fix it, so an "Open AI settings" action
 * goes with it.
 */
export type Translate = (text: string, vars?: Record<string, string>) => string

const NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  gemini: 'Google',
  azure: 'Azure OpenAI',
  ollama: 'Ollama',
}

const HOSTS: Record<string, string> = {
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
  openrouter: 'openrouter.ai',
  gemini: 'generativelanguage.googleapis.com',
  ollama: 'localhost:11434',
}

export interface AiProblemText {
  summary?: string
  detail: string
  settings: boolean
}

export function aiProblemText(message: string, code: string | undefined, provider: Pick<AiProviderSettings, 'id' | 'baseUrl' | 'model'> | undefined, t: Translate): AiProblemText {
  const [first = '', ...rest] = message.split('\n')
  const detail = rest.join('\n').trim()
  const name = provider ? (NAMES[provider.id] ?? t('The server')) : t('The AI provider')
  let host = provider ? HOSTS[provider.id] : undefined
  try {
    if (provider?.baseUrl) host = new URL(provider.baseUrl).host
  } catch {
    // (As typed: the provider's usual host.)
  }
  switch (code) {
    case 'AI_KEY':
      return { summary: t('{provider} didn’t accept the API key. Check it in Settings → AI assistant.', { provider: name }), detail, settings: true }
    case 'AI_CREDIT':
      return { summary: t('{provider} says the account has no credit left.', { provider: name }), detail, settings: true }
    case 'AI_RATE':
      return { summary: t('{provider} is limiting requests. Wait a minute and try again.', { provider: name }), detail, settings: false }
    case 'AI_MODEL':
      return { summary: t('{provider} doesn’t know the model {model}. Pick another in Settings → AI assistant.', { provider: name, model: provider?.model ?? '' }), detail, settings: true }
    case 'AI_UNREACHABLE':
      return { summary: t('Can’t reach {host}. Is it running, and are you online?', { host: host ?? t('the server') }), detail, settings: true }
    case 'AI_SERVER':
      return { summary: t('{provider} had a problem. Try again in a moment.', { provider: name }), detail: detail || first, settings: false }
    default:
      return { detail: message, settings: false }
  }
}

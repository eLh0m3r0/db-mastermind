import type { AiProviderSettings } from '@shared/api'

/**
 * What went wrong talking to an AI provider, for people: a code the window turns into a sentence in its language
 * (and an "Open AI settings" action where settings fix it), with the provider's own words kept as the detail.
 * "User not found." (OpenRouter's answer to a wrong key) and "Failed after 3 attempts. Last error: AI_APICallError:
 * Cannot connect to API: bad port" said neither what happened nor what to do.
 */
export type AiProblemCode = 'AI_KEY' | 'AI_CREDIT' | 'AI_RATE' | 'AI_MODEL' | 'AI_UNREACHABLE' | 'AI_SERVER'

export class AiProblem extends Error {
  readonly code: AiProblemCode
  constructor(code: AiProblemCode, summary: string, detail: string) {
    super(detail && detail !== summary ? `${summary}\n${detail}` : summary)
    this.code = code
    this.name = 'AiProblem'
  }
}

const NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  gemini: 'Google',
  azure: 'Azure OpenAI',
  ollama: 'Ollama',
  'openai-compatible': 'The server',
}

interface Shape {
  message?: unknown
  statusCode?: unknown
  url?: unknown
  responseBody?: unknown
  lastError?: unknown
  errors?: unknown
  cause?: unknown
  code?: unknown
}

/** The innermost error worth reading: a retry's last attempt, a fetch's cause. */
function unwrap(err: unknown): Shape {
  let e = (err ?? {}) as Shape
  for (let i = 0; i < 4; i++) {
    if (e.lastError) e = e.lastError as Shape
    else if (Array.isArray(e.errors) && e.errors.length) e = e.errors.at(-1) as Shape
    else break
  }
  return e
}

/** The provider's own message: from its JSON body when there is one ({"error":{"message":…}}), else the error's. */
function providerWords(e: Shape): string {
  if (typeof e.responseBody === 'string') {
    try {
      const body = JSON.parse(e.responseBody) as { error?: { message?: string } | string; message?: string }
      const text = typeof body.error === 'string' ? body.error : (body.error?.message ?? body.message)
      if (text) return String(text)
    } catch {
      // (Not JSON: the error's own message.)
    }
  }
  return String(e.message ?? e ?? '').replace(/^AI_\w+:\s*/, '')
}

function hostOf(url: unknown, fallback?: string): string {
  for (const candidate of [url, fallback]) {
    if (typeof candidate !== 'string' || !candidate) continue
    try {
      return new URL(candidate).host
    } catch {
      // next one
    }
  }
  return 'the server'
}

export function explainAiError(err: unknown, provider?: Pick<AiProviderSettings, 'id' | 'baseUrl' | 'model'>): Error {
  if (err instanceof AiProblem) return err
  const e = unwrap(err)
  const name = NAMES[provider?.id ?? ''] ?? 'The AI provider'
  const words = providerWords(e)
  const status = typeof e.statusCode === 'number' ? e.statusCode : Number(/^(\d{3}) /.exec(words)?.[1]) || undefined
  const text = `${words} ${String((e.cause as Shape | undefined)?.message ?? '')} ${String((e.cause as Shape | undefined)?.code ?? e.code ?? '')}`
  if (status === 401 || status === 403 || /invalid (x-)?api[ -]?key|incorrect api key|user not found|unauthori[sz]ed|authentication/i.test(words))
    return new AiProblem('AI_KEY', `${name} didn’t accept the API key. Check it in Settings → AI assistant.`, words)
  if (status === 402 || /insufficient (credits|quota|balance)|payment required|credit/i.test(words))
    return new AiProblem('AI_CREDIT', `${name} says the account has no credit left.`, words)
  if (status === 429) return new AiProblem('AI_RATE', `${name} is limiting requests. Wait a minute and try again.`, words)
  if (status === 404 && provider?.model) return new AiProblem('AI_MODEL', `${name} doesn’t know the model ${provider.model}. Pick another in Settings → AI assistant.`, words)
  if (/cannot connect to api|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|fetch failed|network|bad port|socket hang up/i.test(text))
    return new AiProblem('AI_UNREACHABLE', `Can’t reach ${hostOf(e.url, provider?.baseUrl)}. Is it running, and are you online?`, words)
  if (status && status >= 500) return new AiProblem('AI_SERVER', `${name} had a problem (${status}). Try again in a moment.`, words)
  return err instanceof Error ? err : new Error(words)
}

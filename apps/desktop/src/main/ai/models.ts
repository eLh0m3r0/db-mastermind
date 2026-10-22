import { createAnthropic } from '@ai-sdk/anthropic'
import { createAzure } from '@ai-sdk/azure'
import { createGoogle } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { generateText, type LanguageModel } from 'ai'
import type { AiProviderSettings } from '@shared/api'
import { cliAvailable, cliLoggedIn, loginHint } from './cli'

export const DEFAULT_MODELS: Partial<Record<AiProviderSettings['id'], string>> = {
  anthropic: 'claude-sonnet-5-5',
}

function ollamaBase(settings: AiProviderSettings): string {
  return (settings.baseUrl || 'http://localhost:11434').replace(/\/+$/, '').replace(/\/v1$/, '')
}

export function createModel(settings: AiProviderSettings): LanguageModel {
  const model = settings.model?.trim() || DEFAULT_MODELS[settings.id]
  if (!model) throw new Error('Choose a model in Settings → AI assistant')
  switch (settings.id) {
    case 'anthropic':
      return createAnthropic({ apiKey: settings.apiKey, baseURL: settings.baseUrl || undefined })(model)
    case 'openai':
      return createOpenAI({ apiKey: settings.apiKey, baseURL: settings.baseUrl || undefined })(model)
    case 'openrouter':
      return createOpenRouter({ apiKey: settings.apiKey, headers: { 'HTTP-Referer': 'https://github.com/eLh0m3r0/db-mastermind', 'X-Title': 'DB Mastermind' } })(model)
    case 'gemini':
      return createGoogle({ apiKey: settings.apiKey })(model)
    case 'azure':
      return createAzure({ apiKey: settings.apiKey, resourceName: settings.resourceName, baseURL: settings.baseUrl || undefined })(model)
    case 'ollama':
      return createOpenAICompatible({ name: 'ollama', baseURL: `${ollamaBase(settings)}/v1` })(model)
    case 'openai-compatible':
      if (!settings.baseUrl) throw new Error('Set the base URL of your OpenAI-compatible server')
      return createOpenAICompatible({ name: 'custom', baseURL: settings.baseUrl, apiKey: settings.apiKey || undefined })(model)
    case 'claude-code':
    case 'codex':
      throw new Error('CLI providers do not expose a language model object')
  }
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}${body ? `: ${body.slice(0, 300)}` : ''}`)
  }
  return res.json()
}

/** Lists model ids straight from the provider, so the app never ships a stale model list. */
export async function listModels(settings: AiProviderSettings): Promise<string[]> {
  const ids = (data: unknown, key = 'data') =>
    ((data as Record<string, { id?: string; name?: string }[]>)[key] ?? []).map((m) => m.id ?? m.name ?? '').filter(Boolean)
  switch (settings.id) {
    case 'anthropic': {
      const base = (settings.baseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '')
      return ids(await getJson(`${base}/models?limit=1000`, { 'x-api-key': settings.apiKey ?? '', 'anthropic-version': '2023-06-01' }))
    }
    case 'openai': {
      const base = (settings.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
      return ids(await getJson(`${base}/models`, { Authorization: `Bearer ${settings.apiKey ?? ''}` })).sort()
    }
    case 'openrouter':
      return ids(await getJson('https://openrouter.ai/api/v1/models', {})).sort()
    case 'gemini': {
      const data = (await getJson(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(settings.apiKey ?? '')}`, {})) as {
        models?: { name: string; supportedGenerationMethods?: string[] }[]
      }
      return (data.models ?? [])
        .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
        .map((m) => m.name.replace(/^models\//, ''))
    }
    case 'ollama': {
      const data = (await getJson(`${ollamaBase(settings)}/api/tags`, {})) as { models?: { name: string }[] }
      return (data.models ?? []).map((m) => m.name)
    }
    case 'openai-compatible': {
      if (!settings.baseUrl) throw new Error('Set the base URL first')
      return ids(await getJson(`${settings.baseUrl.replace(/\/+$/, '')}/models`, settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}))
    }
    default:
      return []
  }
}

export async function testProvider(settings: AiProviderSettings): Promise<string> {
  if (settings.id === 'claude-code' || settings.id === 'codex') {
    const version = await cliAvailable(settings.id)
    if (!version) throw new Error(`${settings.id === 'codex' ? 'codex' : 'claude'} CLI was not found on PATH`)
    // Finding the CLI isn't enough: a signed-out CLI fails on the first question.
    const login = await cliLoggedIn(settings.id)
    if (login && !login.loggedIn) throw new Error(`Found ${version}, but it isn't signed in: ${loginHint(settings.id)}, then test again.`)
    return `Found ${version}${login?.detail ? `, signed in (${login.detail})` : ''}`
  }
  const started = Date.now()
  const result = await generateText({
    model: createModel(settings),
    prompt: 'Reply with the single word: ready',
    maxOutputTokens: 16,
    abortSignal: AbortSignal.timeout(30_000),
  })
  return `${result.text.trim().slice(0, 40) || 'OK'} (${Date.now() - started} ms)`
}

import { generateText } from 'ai'
import type { AiProviderSettings } from '@shared/api'
import { assertAiAllowed } from '../managed'
import { getSettings } from '../settings'
import { runCli } from './cli'
import { createModel } from './models'

export function activeProvider(): AiProviderSettings {
  assertAiAllowed()
  const ai = getSettings().ai
  const provider = ai.providers.find((p) => p.id === ai.activeProvider)
  if (!provider) throw new Error('Choose an AI provider in Settings → AI assistant')
  return provider
}

/** One prompt in, text out, with whichever provider is active (API key, local model or CLI subscription). */
export async function completeText(system: string, prompt: string, signal = AbortSignal.timeout(120_000)): Promise<string> {
  const provider = activeProvider()
  if (provider.id === 'claude-code' || provider.id === 'codex') {
    let text = ''
    await runCli({ provider: provider.id, prompt, system, model: provider.model, signal, onEvent: (e) => e.type === 'text' && (text += e.text) })
    return text
  }
  const result = await generateText({ model: createModel(provider), system, prompt, abortSignal: signal })
  return result.text
}

/** First JSON object in a model reply (tolerates code fences and prose around it). */
export function extractJson<T>(text: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1]
  const candidate = fenced ?? text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('The model did not return JSON')
  return JSON.parse(candidate.slice(start, end + 1)) as T
}

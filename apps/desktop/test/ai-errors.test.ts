import { describe, expect, it } from 'vitest'
import { APICallError } from '@ai-sdk/provider'
import { RetryError } from 'ai'
import { explainAiError } from '../src/main/ai/errors'

const openrouter = { id: 'openrouter' as const, model: 'deepseek/deepseek-v4.1-flash-1017' }

/** An error as the AI SDK throws it after a provider's HTTP answer. */
const apiError = (statusCode: number, responseBody: string, message: string) =>
  new APICallError({ message, url: 'https://openrouter.ai/api/v1/chat/completions', requestBodyValues: {}, statusCode, responseBody, isRetryable: statusCode >= 500 })

describe('what an AI error means', () => {
  it('a wrong key: OpenRouter answers 401 "User not found."', () => {
    const e = explainAiError(apiError(401, '{"error":{"message":"User not found.","code":401}}', 'User not found.'), openrouter)
    expect((e as { code?: string }).code).toBe('AI_KEY')
    expect(e.message).toBe('OpenRouter didn’t accept the API key. Check it in Settings → AI assistant.\nUser not found.')
  })

  it('a server that is not running: the retries\' last error is read', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' })
    const attempt = new APICallError({ message: 'Cannot connect to API: bad port', url: 'http://127.0.0.1:9/v1/chat/completions', requestBodyValues: {}, cause, isRetryable: true })
    const retried = new RetryError({ message: 'Failed after 3 attempts. Last error: Cannot connect to API: bad port', reason: 'maxRetriesExceeded', errors: [attempt, attempt, attempt] })
    const e = explainAiError(retried, { id: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1' })
    expect((e as { code?: string }).code).toBe('AI_UNREACHABLE')
    expect(e.message.split('\n')[0]).toBe('Can’t reach 127.0.0.1:9. Is it running, and are you online?')
    expect(e.message).toContain('Cannot connect to API: bad port')
  })

  it('no credit, too many requests, an unknown model, a server error', () => {
    expect((explainAiError(apiError(402, '{"error":{"message":"Insufficient credits"}}', 'Insufficient credits'), openrouter) as { code?: string }).code).toBe('AI_CREDIT')
    expect((explainAiError(apiError(429, '', 'Rate limit exceeded'), openrouter) as { code?: string }).code).toBe('AI_RATE')
    const model = explainAiError(apiError(404, '{"error":{"message":"No endpoints found"}}', 'Not Found'), openrouter)
    expect(model.message.split('\n')[0]).toBe('OpenRouter doesn’t know the model deepseek/deepseek-v4.1-flash-1017. Pick another in Settings → AI assistant.')
    expect((explainAiError(apiError(503, '', 'Service Unavailable'), openrouter) as { code?: string }).code).toBe('AI_SERVER')
  })

  it('the model list: a plain fetch answer with its status and body', () => {
    const listed = Object.assign(new Error('401 Unauthorized: {"error":{"message":"Invalid API key"}}'), { statusCode: 401, responseBody: '{"error":{"message":"Invalid API key"}}' })
    expect(explainAiError(listed, { id: 'openai' }).message).toBe('OpenAI didn’t accept the API key. Check it in Settings → AI assistant.\nInvalid API key')
    const offline = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND openrouter.ai'), { code: 'ENOTFOUND' }) })
    expect((explainAiError(offline, openrouter) as { code?: string }).code).toBe('AI_UNREACHABLE')
  })

  it('leaves other errors as they are', () => {
    const plain = new Error('Choose a model in Settings → AI assistant')
    expect(explainAiError(plain, openrouter)).toBe(plain)
  })
})

import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AiProviderSettings } from '../src/shared/api'
import { listModels, testProvider } from '../src/main/ai/models'

// An API key must never end up on an error: errors are shown, logged and serialised (the Gemini model list used to
// put it in the URL, which the error kept). Every provider's model listing and chat call goes to a server that fails.
const KEY = 'sk-test-SECRET-0123456789abcdef'

let server: Server
let base = ''
/** The fake server's answer: 401 (explained as a key problem) and 400 (an error the app passes on as it is). */
let status = 401
const seen: { url: string; headers: Record<string, string | string[] | undefined> }[] = []
const realFetch = globalThis.fetch

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers })
    req.resume()
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: status === 401 ? 'The credentials were not accepted.' : 'Bad request.', code: status } }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  // Providers with a fixed address (OpenRouter, Google, Azure) are sent to the fake server too, path and query kept.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    return realFetch(`${base}${url.pathname}${url.search}`, init ?? (input instanceof Request ? input : undefined))
  }) as typeof fetch
})

afterAll(async () => {
  globalThis.fetch = realFetch
  await new Promise((r) => server.close(r))
})

/** Every string reachable from an error: message, stack, cause, own properties (also non-enumerable), nested. */
function strings(value: unknown, out: string[] = [], seenObjects = new Set<unknown>(), depth = 0): string[] {
  if (typeof value === 'string') out.push(value)
  else if (value instanceof URL) out.push(value.href)
  else if (value && typeof value === 'object' && !seenObjects.has(value) && depth < 8) {
    seenObjects.add(value)
    for (const name of Object.getOwnPropertyNames(value)) {
      try {
        strings((value as Record<string, unknown>)[name], out, seenObjects, depth + 1)
      } catch {
        // a getter that throws: nothing to read
      }
    }
    if (value instanceof Error) strings(value.cause, out, seenObjects, depth + 1)
    if (value instanceof Map) for (const [k, v] of value) strings([k, v], out, seenObjects, depth + 1)
    try {
      out.push(JSON.stringify(value))
    } catch {
      // circular: the parts were read above
    }
  }
  return out
}

const providers: AiProviderSettings[] = [
  { id: 'anthropic', enabled: true, apiKey: KEY, model: 'claude-x' },
  { id: 'openai', enabled: true, apiKey: KEY, model: 'gpt-x' },
  { id: 'openrouter', enabled: true, apiKey: KEY, model: 'vendor/model-x' },
  { id: 'gemini', enabled: true, apiKey: KEY, model: 'gemini-x' },
  { id: 'azure', enabled: true, apiKey: KEY, resourceName: 'corp', model: 'deployment-x' },
  { id: 'openai-compatible', enabled: true, apiKey: KEY, model: 'local-x' },
] as AiProviderSettings[]

const withBase = (p: AiProviderSettings): AiProviderSettings => (p.id === 'anthropic' || p.id === 'openai' || p.id === 'openai-compatible' ? { ...p, baseUrl: `${base}/v1` } : p)

for (const answer of [401, 400]) describe(`an AI provider that fails (${answer}) never puts the API key on the error`, () => {
  beforeAll(() => {
    status = answer
  })
  for (const provider of providers) {
    it(`${provider.id}: model list`, async () => {
      if (provider.id === 'azure') return // (Azure has no model list: deployments are typed in.)
      const err = await listModels(withBase(provider)).then(
        () => undefined,
        (e: unknown) => e,
      )
      if (provider.id === 'openrouter') {
        // OpenRouter's model list needs no key; a failing one must still not carry it.
        expect(err === undefined || !strings(err).some((s) => s.includes(KEY))).toBe(true)
        return
      }
      expect(err).toBeInstanceOf(Error)
      expect(strings(err).filter((s) => s.includes(KEY))).toEqual([])
    })

    it(`${provider.id}: chat (Test)`, async () => {
      const err = await testProvider(withBase(provider)).then(
        () => undefined,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(Error)
      expect(strings(err).filter((s) => s.includes(KEY))).toEqual([])
    })
  }

  it('the key travels in headers, never in a URL (Gemini: x-goog-api-key)', () => {
    expect(seen.length).toBeGreaterThan(5)
    expect(seen.filter((r) => r.url.includes(KEY) || decodeURIComponent(r.url).includes(KEY))).toEqual([])
    expect(seen.some((r) => r.headers['x-goog-api-key'] === KEY)).toBe(true)
  })
})

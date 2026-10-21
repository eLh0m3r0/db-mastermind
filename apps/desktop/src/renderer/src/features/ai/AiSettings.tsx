import { useState } from 'react'
import { CheckCircle2, ExternalLink, RefreshCw, XCircle } from 'lucide-react'
import type { AiProviderId, AiProviderSettings } from '@shared/api'
import { Button } from '@/components/ui/Button'
import { Checkbox, Field, Input, Segmented } from '@/components/ui/Input'
import { api } from '@/lib/api'
import { cn, errorMessage } from '@/lib/utils'
import { useSettings } from '@/store/settings'
import { PROVIDERS, providerMeta } from './providers'

export function AiSettingsSection() {
  const settings = useSettings((s) => s.settings)!
  const update = useSettings((s) => s.update)
  const ai = settings.ai
  const [selected, setSelected] = useState<AiProviderId>(ai.activeProvider ?? 'anthropic')
  const [models, setModels] = useState<string[]>([])
  const [status, setStatus] = useState<{ state: 'idle' | 'busy' | 'ok' | 'error'; message?: string }>({ state: 'idle' })
  const meta = providerMeta(selected)!
  const config: AiProviderSettings = ai.providers.find((p) => p.id === selected) ?? { id: selected, enabled: true }

  const saveProvider = (patch: Partial<AiProviderSettings>) => {
    const next = { ...config, ...patch }
    const providers = ai.providers.some((p) => p.id === selected) ? ai.providers.map((p) => (p.id === selected ? next : p)) : [...ai.providers, next]
    void update({ ai: { ...ai, providers } })
  }

  const fetchModels = async () => {
    setStatus({ state: 'busy' })
    try {
      const list = await api.listAiModels(config)
      setModels(list)
      setStatus({ state: 'ok', message: `${list.length} models available` })
    } catch (err) {
      setStatus({ state: 'error', message: errorMessage(err) })
    }
  }

  const test = async () => {
    setStatus({ state: 'busy' })
    try {
      const reply = await api.testAiProvider(config)
      setStatus({ state: 'ok', message: reply })
    } catch (err) {
      setStatus({ state: 'error', message: errorMessage(err) })
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-1.5">
        {PROVIDERS.map((p) => {
          const configured = ai.providers.find((x) => x.id === p.id)
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                setSelected(p.id)
                setModels([])
                setStatus({ state: 'idle' })
              }}
              className={cn(
                'flex flex-col items-start gap-0.5 rounded-md border px-2.5 py-2 text-left',
                selected === p.id ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover',
              )}
            >
              <span className="flex w-full items-center gap-1.5 text-[12.5px] font-medium">
                {p.label}
                {ai.activeProvider === p.id && <span className="ml-auto rounded bg-accent px-1 text-[9.5px] font-bold text-accent-fg">ACTIVE</span>}
                {ai.activeProvider !== p.id && configured && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-success" />}
              </span>
              <span className="text-[10.5px] text-fg-faint uppercase">{p.kind === 'subscription' ? 'subscription' : p.kind === 'local' ? 'local' : 'API key'}</span>
            </button>
          )
        })}
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-line p-3.5">
        <div className="text-[12.5px] text-fg-muted">{meta.description}</div>
        {meta.needsKey && (
          <Field
            label={
              <span className="flex items-center gap-2">
                API key
                {meta.keyUrl && (
                  <button type="button" className="flex items-center gap-0.5 text-accent hover:underline" onClick={() => void api.openExternal(meta.keyUrl!)}>
                    get a key <ExternalLink size={10} />
                  </button>
                )}
              </span>
            }
            hint="Stored encrypted with your operating system's keychain."
          >
            <Input type="password" value={config.apiKey ?? ''} onChange={(e) => saveProvider({ apiKey: e.target.value })} placeholder="sk-…" autoComplete="off" />
          </Field>
        )}
        {meta.needsResource && (
          <Field label="Resource name" hint="The part before .openai.azure.com">
            <Input value={config.resourceName ?? ''} onChange={(e) => saveProvider({ resourceName: e.target.value })} />
          </Field>
        )}
        {(meta.needsBaseUrl || meta.id === 'openai' || meta.id === 'anthropic') && (
          <Field label={meta.needsBaseUrl ? 'Base URL' : 'Base URL (optional, for proxies)'}>
            <Input value={config.baseUrl ?? ''} onChange={(e) => saveProvider({ baseUrl: e.target.value || undefined })} placeholder={meta.baseUrlPlaceholder} />
          </Field>
        )}
        <Field label={meta.id === 'azure' ? 'Deployment name' : 'Model'} hint={meta.kind === 'subscription' ? 'Optional: leave empty to use the CLI default.' : undefined}>
          <div className="flex gap-2">
            <Input className="flex-1" list={`models-${selected}`} value={config.model ?? ''} onChange={(e) => saveProvider({ model: e.target.value || undefined })} placeholder={defaultModelHint(selected)} />
            <datalist id={`models-${selected}`}>
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            {meta.kind !== 'subscription' && meta.id !== 'azure' && (
              <Button icon={<RefreshCw size={13} />} onClick={() => void fetchModels()} disabled={status.state === 'busy'}>
                Load models
              </Button>
            )}
          </div>
        </Field>
        <div className="flex items-center gap-2">
          <Button onClick={() => void test()} loading={status.state === 'busy'}>
            Test
          </Button>
          <Button variant={ai.activeProvider === selected ? 'subtle' : 'primary'} onClick={() => void update({ ai: { ...ai, activeProvider: selected, providers: ai.providers.some((p) => p.id === selected) ? ai.providers : [...ai.providers, config] } })}>
            {ai.activeProvider === selected ? 'Active provider' : 'Use this provider'}
          </Button>
          {status.state === 'ok' && (
            <span className="flex min-w-0 items-center gap-1 text-[12px] text-success">
              <CheckCircle2 size={13} className="shrink-0" /> <span className="truncate">{status.message}</span>
            </span>
          )}
          {status.state === 'error' && (
            <span className="flex min-w-0 items-center gap-1 text-[12px] text-danger" title={status.message}>
              <XCircle size={13} className="shrink-0" /> <span className="line-clamp-2">{status.message}</span>
            </span>
          )}
        </div>
      </div>

      <Field label="What the assistant may see">
        <Segmented
          value={ai.dataSharing}
          onChange={(dataSharing) => void update({ ai: { ...ai, dataSharing } })}
          options={[
            { value: 'schema', label: 'Schema only', title: 'Table and column names, types, relationships, knowledge base' },
            { value: 'schema-and-samples', label: 'Schema + query results', title: 'The assistant may run read-only queries and see results' },
            { value: 'full', label: 'Everything' },
          ]}
        />
      </Field>
      <Checkbox
        checked={ai.autoRunReadQueries}
        onChange={(autoRunReadQueries) => void update({ ai: { ...ai, autoRunReadQueries } })}
        label="Let the assistant run read-only queries without asking"
        hint="Writes (INSERT, UPDATE, DELETE, DDL) always need your confirmation."
        disabled={ai.dataSharing === 'schema'}
      />
    </div>
  )
}

function defaultModelHint(id: AiProviderId): string {
  switch (id) {
    case 'anthropic':
      return 'claude-sonnet-5-5'
    case 'openai':
      return 'e.g. gpt-5'
    case 'openrouter':
      return 'e.g. anthropic/claude-sonnet-5.5'
    case 'gemini':
      return 'e.g. gemini-2.5-pro'
    case 'ollama':
      return 'e.g. qwen3:14b'
    default:
      return ''
  }
}

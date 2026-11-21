import { aiProblemText } from './ai-problems'
import { t } from './i18n'
import { errorMessage } from './utils'
import { useSettings } from '@/store/settings'
import { toast, useUi } from '@/store/ui'

/** The AI provider in use, for explaining its errors. */
export function activeAiProvider() {
  const ai = useSettings.getState().settings?.ai
  return ai?.providers.find((p) => p.id === ai.activeProvider)
}

export const openAiSettings = () => useUi.getState().set({ modal: { kind: 'settings', section: 'ai' } })

/** An AI request failed: what happened in the UI's language, the provider's words, and AI settings when they fix it. */
export function aiErrorToast(title: string, err: unknown): void {
  const p = aiProblemText(errorMessage(err), (err as { code?: string }).code, activeAiProvider(), t)
  toast({
    kind: 'error',
    message: title,
    detail: p.summary ? `${p.summary}${p.detail ? `\n${p.detail}` : ''}` : p.detail,
    action: p.settings ? { label: t('Open AI settings'), run: openAiSettings } : undefined,
  })
}

import { create } from 'zustand'
import type { AppInfo, AppSettings } from '@shared/api'
import { api, bridge } from '@/lib/api'

interface SettingsState {
  settings?: AppSettings
  info?: AppInfo
  dark: boolean
  load(): Promise<void>
  update(patch: Partial<AppSettings>): Promise<void>
}

const media = window.matchMedia('(prefers-color-scheme: dark)')
const moreContrast = window.matchMedia('(prefers-contrast: more)')

function applyTheme(settings: AppSettings | undefined): boolean {
  const pref = settings?.theme ?? 'system'
  const dark = pref === 'dark' || (pref === 'system' && media.matches)
  document.documentElement.classList.toggle('dark', dark)
  const contrast = settings?.contrast ?? 'system'
  document.documentElement.classList.toggle('high-contrast', contrast === 'high' || (contrast === 'system' && moreContrast.matches))
  document.documentElement.style.setProperty('--editor-font-size', `${settings?.editorFontSize ?? 13}px`)
  return dark
}

export const useSettings = create<SettingsState>((set, get) => ({
  dark: applyTheme(undefined),
  async load() {
    const [settings, info] = await Promise.all([api.getSettings(), api.getAppInfo()])
    set({ settings, info, dark: applyTheme(settings) })
  },
  async update(patch) {
    const settings = await api.updateSettings(patch)
    if (patch.theme) bridge.setTheme(patch.theme)
    set({ settings, dark: applyTheme(settings) })
  },
}))

for (const query of [media, moreContrast]) {
  query.addEventListener('change', () => {
    useSettings.setState({ dark: applyTheme(useSettings.getState().settings) })
  })
}

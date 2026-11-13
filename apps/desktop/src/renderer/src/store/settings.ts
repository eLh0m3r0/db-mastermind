import { create } from 'zustand'
import type { AppInfo, AppSettings } from '@shared/api'
import { api, bridge } from '@/lib/api'
import { lookById } from '@/lib/looks'

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
  const look = lookById(settings?.look)
  // A playful look brings its own light or dark palette.
  const dark = look.dark ?? (pref === 'dark' || (pref === 'system' && media.matches))
  const root = document.documentElement
  root.classList.toggle('dark', dark)
  for (const c of [...root.classList]) if (c.startsWith('look-')) root.classList.remove(c)
  root.classList.add(`look-${look.id}`)
  root.classList.toggle('compact', settings?.density === 'compact')
  const contrast = settings?.contrast ?? 'system'
  // A look with its own palette ignores contrast (its colors are chosen together).
  document.documentElement.classList.toggle('high-contrast', look.dark === undefined && (contrast === 'high' || (contrast === 'system' && moreContrast.matches)))
  document.documentElement.style.setProperty('--editor-font-size', `${settings?.editorFontSize ?? 13}px`)
  return dark
}

/** Window chrome (title bar, scrollbars) follows a look's own light / dark palette, else the Theme setting. */
function syncNativeTheme(settings: AppSettings) {
  const look = lookById(settings.look)
  bridge.setTheme(look.dark === undefined ? settings.theme : look.dark ? 'dark' : 'light')
}

/** Table and explorer row heights. */
export const useCompact = () => useSettings((s) => s.settings?.density === 'compact')

export const useSettings = create<SettingsState>((set, get) => ({
  dark: applyTheme(undefined),
  async load() {
    const [settings, info] = await Promise.all([api.getSettings(), api.getAppInfo()])
    set({ settings, info, dark: applyTheme(settings) })
    syncNativeTheme(settings)
  },
  async update(patch) {
    const settings = await api.updateSettings(patch)
    if (patch.theme || 'look' in patch) syncNativeTheme(settings)
    set({ settings, dark: applyTheme(settings) })
  },
}))

for (const query of [media, moreContrast]) {
  query.addEventListener('change', () => {
    useSettings.setState({ dark: applyTheme(useSettings.getState().settings) })
  })
}

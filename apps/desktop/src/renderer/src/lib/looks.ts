/**
 * Looks: an accent color, or a whole palette for fun (an easter egg, not advertised anywhere). A look with `dark`
 * set brings its own light or dark colors and overrides the Theme setting. Colors live in styles.css (.look-<id>).
 */
export type LookGroup = 'standard' | 'retro' | 'seasonal' | 'games'

export interface Look {
  id: string
  group: LookGroup
  /** English name; translated in the UI. */
  name: string
  /** Preview colors: page, title bar, accent (standard looks show the accent on the current light / dark page). */
  swatch: [string, string, string]
  /** Forced light (false) or dark (true) palette; unset follows the Theme setting. */
  dark?: boolean
  /** Shown next to the version in the status bar. */
  emoji?: string
  /** Brings a font of its own (the Font setting can keep the standard one). */
  font?: boolean
}

export const LOOKS: Look[] = [
  { id: 'violet', group: 'standard', name: 'Violet', swatch: ['#ffffff', '#f6f7f9', '#6d4aff'] },
  { id: 'blue', group: 'standard', name: 'Blue', swatch: ['#ffffff', '#f6f7f9', '#2563eb'] },
  { id: 'teal', group: 'standard', name: 'Teal', swatch: ['#ffffff', '#f6f7f9', '#0f8f8a'] },
  { id: 'green', group: 'standard', name: 'Green', swatch: ['#ffffff', '#f6f7f9', '#16803c'] },
  { id: 'orange', group: 'standard', name: 'Orange', swatch: ['#ffffff', '#f6f7f9', '#c2410c'] },
  { id: 'rose', group: 'standard', name: 'Rose', swatch: ['#ffffff', '#f6f7f9', '#d6336c'] },
  { id: 'retro2001', group: 'retro', name: 'Retro 2001', swatch: ['#ece9d8', '#245edb', '#3c9b2f'], dark: false, emoji: '💾', font: true },
  { id: 'terminal', group: 'retro', name: 'Terminal', swatch: ['#000000', '#0a140c', '#33ff66'], dark: true, emoji: '⌨️', font: true },
  { id: 'halloween', group: 'seasonal', name: 'Halloween', swatch: ['#14100c', '#1d1610', '#ff7518'], dark: true, emoji: '🎃' },
  { id: 'christmas', group: 'seasonal', name: 'Christmas', swatch: ['#fbfaf7', '#a91f17', '#17602f'], dark: false, emoji: '🎄' },
  { id: 'medieval', group: 'games', name: 'Medieval', swatch: ['#f3e9d2', '#8b5a2b', '#b8860b'], dark: false, emoji: '⚔️', font: true },
  { id: 'fantasy', group: 'games', name: 'Fantasy', swatch: ['#0f0d14', '#2a2238', '#c9a227'], dark: true, emoji: '🛡️', font: true },
]

export const lookById = (id: string | undefined): Look => LOOKS.find((l) => l.id === id) ?? LOOKS[0]!

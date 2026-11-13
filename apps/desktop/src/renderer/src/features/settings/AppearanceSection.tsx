import type { AppSettings } from '@shared/api'
import { Segmented } from '@/components/ui/Input'
import { useT } from '@/lib/i18n'
import { LOOKS, lookById, type Look, type LookGroup } from '@/lib/looks'
import { cn } from '@/lib/utils'
import { useSettings } from '@/store/settings'

const GROUPS: [LookGroup, string][] = [
  ['standard', 'Standard'],
  ['retro', 'Retro'],
  ['seasonal', 'Seasonal'],
  ['games', 'Games'],
]

/**
 * The look first (accent colors and the playful looks, all as the same small cards), then only the settings that do
 * something with it: light / dark and contrast apply to the standard looks; the others bring their own colors.
 */
export function AppearanceSection({ settings, set }: { settings: AppSettings; set: (patch: Partial<AppSettings>) => void }) {
  const t = useT()
  const dark = useSettings((s) => s.dark)
  const current = lookById(settings.look)
  const ownPalette = current.dark !== undefined
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3">
        <h3 className="text-[13px] font-semibold">{t('Look')}</h3>
        {/* The standard colors in one row, the playful groups side by side under them. */}
        <div className="flex flex-wrap gap-x-5 gap-y-3">
          {GROUPS.map(([group, label]) => (
            <div key={group} className={cn('flex flex-col gap-1.5', group === 'standard' && 'basis-full')}>
              <div className="text-[10.5px] font-medium tracking-wide text-fg-faint uppercase">{t(label)}</div>
              <div className="flex flex-wrap gap-1.5">
                {LOOKS.filter((l) => l.group === group).map((look) => (
                  <LookCard key={look.id} look={look} dark={dark} selected={current.id === look.id} onPick={() => set({ look: look.id })} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3 border-t border-line pt-4">
        {ownPalette ? (
          <p className="text-[12px] text-fg-muted" data-testid="own-palette">
            {t('“{look}” has its own colors, so light / dark mode and contrast don’t apply to it.', { look: t(current.name) })}
          </p>
        ) : (
          <>
            <Setting label={t('Mode')}>
              <Segmented
                value={settings.theme}
                onChange={(theme) => set({ theme })}
                options={[
                  { value: 'system', label: t('System') },
                  { value: 'light', label: t('Light') },
                  { value: 'dark', label: t('Dark') },
                ]}
              />
            </Setting>
            <Setting label={t('Contrast')}>
              <Segmented
                value={settings.contrast ?? 'system'}
                onChange={(contrast) => set({ contrast })}
                options={[
                  { value: 'system', label: t('System') },
                  { value: 'normal', label: t('Normal') },
                  { value: 'high', label: t('High') },
                ]}
              />
            </Setting>
          </>
        )}
        <Setting label={t('Density')} hint={t('Compact fits more rows in tables and the explorer.')}>
          <Segmented
            value={settings.density ?? 'comfortable'}
            onChange={(density) => set({ density })}
            options={[
              { value: 'comfortable', label: t('Comfortable') },
              { value: 'compact', label: t('Compact') },
            ]}
          />
        </Setting>
      </section>
    </div>
  )
}

function Setting({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4">
      <div className="w-24 shrink-0 text-[12.5px] font-medium">{label}</div>
      {children}
      {hint && <div className="text-[11.5px] text-fg-faint">{hint}</div>}
    </div>
  )
}

/** A small window: title bar, page and an accent button, in the look's own colors. */
function LookCard({ look, dark, selected, onPick }: { look: Look; dark: boolean; selected: boolean; onPick: () => void }) {
  const t = useT()
  const standard = look.dark === undefined
  // Standard looks are an accent on the page as it is now (light or dark).
  const [page, bar, accent] = standard ? [dark ? '#16181d' : '#ffffff', dark ? '#1c1f25' : '#f6f7f9', look.swatch[2]] : look.swatch
  return (
    <button
      type="button"
      aria-pressed={selected}
      title={t(look.name)}
      data-look={look.id}
      onClick={onPick}
      className={cn('flex w-[78px] flex-col gap-1 rounded-lg p-1 text-left', selected ? 'bg-accent-soft ring-2 ring-accent' : 'hover:bg-hover')}
    >
      <span className="flex h-9 w-full flex-col overflow-hidden rounded-md border border-line-strong" style={{ background: page }}>
        <span className="h-2 shrink-0" style={{ background: bar }} />
        <span className="flex flex-1 items-end justify-between p-1">
          <span className="h-1 w-6 rounded-full opacity-40" style={{ background: standard ? (dark ? '#a1a8b5' : '#5b6372') : accent }} />
          <span className="h-2.5 w-5 rounded-sm" style={{ background: accent }} />
        </span>
      </span>
      <span className="line-clamp-2 min-h-[2lh] px-0.5 text-[11px] leading-tight">
        {t(look.name)}
        {look.emoji && <span aria-hidden className="ml-0.5">{look.emoji}</span>}
      </span>
    </button>
  )
}

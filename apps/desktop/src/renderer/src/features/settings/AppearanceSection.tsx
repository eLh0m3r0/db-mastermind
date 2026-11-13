import { Check } from 'lucide-react'
import type { AppSettings } from '@shared/api'
import { Segmented } from '@/components/ui/Input'
import { useT } from '@/lib/i18n'
import { LOOKS, lookById, type LookGroup } from '@/lib/looks'
import { cn } from '@/lib/utils'
import { Row } from './SettingsModal'

const GROUPS: [LookGroup, string][] = [
  ['retro', 'Retro'],
  ['seasonal', 'Seasonal'],
  ['games', 'Games'],
]

/** Theme, contrast, density and the look: an accent color, or (for fun) a whole palette. */
export function AppearanceSection({ settings, set }: { settings: AppSettings; set: (patch: Partial<AppSettings>) => void }) {
  const t = useT()
  const current = lookById(settings.look)
  const ownPalette = current.dark !== undefined
  return (
    <>
      <Row label={t('Theme')} hint={ownPalette ? t('The chosen look has its own colors.') : undefined}>
        <div className={cn(ownPalette && 'pointer-events-none opacity-50')}>
          <Segmented
            value={settings.theme}
            onChange={(theme) => set({ theme })}
            options={[
              { value: 'system', label: t('System') },
              { value: 'light', label: t('Light') },
              { value: 'dark', label: t('Dark') },
            ]}
          />
        </div>
      </Row>
      <Row label={t('Contrast')}>
        <Segmented
          value={settings.contrast ?? 'system'}
          onChange={(contrast) => set({ contrast })}
          options={[
            { value: 'system', label: t('System') },
            { value: 'normal', label: t('Normal') },
            { value: 'high', label: t('High') },
          ]}
        />
      </Row>
      <Row label={t('Density')} hint={t('Compact fits more rows in tables and the explorer.')}>
        <Segmented
          value={settings.density ?? 'comfortable'}
          onChange={(density) => set({ density })}
          options={[
            { value: 'comfortable', label: t('Comfortable') },
            { value: 'compact', label: t('Compact') },
          ]}
        />
      </Row>
      <Row label={t('Accent color')}>
        <div className="flex h-7 items-center gap-2" role="radiogroup" aria-label={t('Accent color')}>
          {LOOKS.filter((l) => l.group === 'standard').map((look) => (
            <button
              key={look.id}
              type="button"
              role="radio"
              aria-checked={current.id === look.id}
              title={t(look.name)}
              aria-label={t(look.name)}
              data-look={look.id}
              onClick={() => set({ look: look.id })}
              className={cn('flex h-6 w-6 items-center justify-center rounded-full ring-offset-2 ring-offset-elevated', current.id === look.id && 'ring-2 ring-fg-muted')}
              style={{ background: look.swatch[2] }}
            >
              {current.id === look.id && <Check size={13} strokeWidth={3} className="text-white" />}
            </button>
          ))}
        </div>
      </Row>
      {GROUPS.map(([group, label]) => (
        <Row key={group} label={t(label)} hint={group === 'retro' ? t('Just for fun.') : undefined}>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
            {LOOKS.filter((l) => l.group === group).map((look) => (
              <button
                key={look.id}
                type="button"
                aria-pressed={current.id === look.id}
                data-look={look.id}
                onClick={() => set({ look: current.id === look.id ? 'violet' : look.id })}
                title={current.id === look.id ? t('Click again for the usual look') : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-md border px-2 py-1.5 text-left text-[12px]',
                  current.id === look.id ? 'border-accent bg-accent-soft font-medium' : 'border-line hover:bg-hover',
                )}
              >
                <span className="flex h-6 w-9 shrink-0 overflow-hidden rounded border border-line-strong">
                  {look.swatch.map((c, i) => (
                    <span key={i} className="flex-1" style={{ background: c }} />
                  ))}
                </span>
                <span className="min-w-0 flex-1 truncate">{t(look.name)}</span>
                {look.emoji && <span aria-hidden>{look.emoji}</span>}
              </button>
            ))}
          </div>
        </Row>
      ))}
    </>
  )
}

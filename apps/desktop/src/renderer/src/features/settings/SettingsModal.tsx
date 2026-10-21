import { useState, type ReactNode } from 'react'
import { FolderOpen } from 'lucide-react'
import type { AppSettings } from '@shared/api'
import { Button } from '@/components/ui/Button'
import { Checkbox, Field, Input, Segmented, Select } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useSettings } from '@/store/settings'
import { useUi } from '@/store/ui'
import { AiSettingsSection } from '../ai/AiSettings'
import { McpSettingsSection } from '../ai/McpSettings'

const SECTIONS = [
  ['general', 'General'],
  ['editor', 'Editor & data'],
  ['ai', 'AI assistant'],
  ['mcp', 'MCP server'],
  ['about', 'About'],
] as const

type Section = (typeof SECTIONS)[number][0]

export function SettingsModal() {
  const modal = useUi((s) => s.modal)
  const setUi = useUi((s) => s.set)
  const open = modal?.kind === 'settings'
  const [section, setSection] = useState<Section>('general')
  const settings = useSettings((s) => s.settings)
  const info = useSettings((s) => s.info)
  const update = useSettings((s) => s.update)
  if (!settings) return null
  const set = (patch: Partial<AppSettings>) => void update(patch)
  const current = open && modal.section ? (modal.section as Section) : section

  return (
    <Modal open={open} onClose={() => setUi({ modal: undefined })} title="Settings" width={760} bodyClassName="p-0">
      <div className="flex min-h-[460px]">
        <nav className="flex w-[180px] shrink-0 flex-col gap-0.5 border-r border-line bg-subtle p-2">
          {SECTIONS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setSection(id)
                setUi({ modal: { kind: 'settings', section: id } })
              }}
              className={cn('h-8 rounded-md px-2.5 text-left text-[13px]', current === id ? 'bg-elevated font-medium shadow-sm' : 'text-fg-muted hover:bg-hover hover:text-fg')}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-auto p-5">
          {current === 'general' && (
            <>
              <Row label="Theme">
                <Segmented
                  value={settings.theme}
                  onChange={(theme) => set({ theme })}
                  options={[
                    { value: 'system', label: 'System' },
                    { value: 'light', label: 'Light' },
                    { value: 'dark', label: 'Dark' },
                  ]}
                />
              </Row>
              <Row label="Language" hint="Czech translation is in progress.">
                <Select className="w-48" value={settings.language} onChange={(e) => set({ language: e.target.value as 'en' | 'cs' })}>
                  <option value="en">English</option>
                  <option value="cs">Čeština</option>
                </Select>
              </Row>
              <Row label="Safety">
                <Checkbox
                  checked={settings.confirmDangerousStatements}
                  onChange={(v) => set({ confirmDangerousStatements: v })}
                  label="Confirm DELETE/UPDATE without WHERE, DROP and TRUNCATE"
                  hint="Always on for connections marked as production."
                />
              </Row>
            </>
          )}
          {current === 'editor' && (
            <>
              <Row label="Editor font size">
                <Input className="w-24" type="number" min={10} max={24} value={settings.editorFontSize} onChange={(e) => set({ editorFontSize: Number(e.target.value) || 13 })} />
              </Row>
              <Row label="Rows per page" hint="Default page size in the table browser.">
                <Select className="w-32" value={settings.pageSize} onChange={(e) => set({ pageSize: Number(e.target.value) })}>
                  {[50, 100, 200, 500, 1000, 5000].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </Row>
              <Row label="Max result rows" hint="Query results stop after this many rows (export streams everything).">
                <Input className="w-32" type="number" min={100} step={1000} value={settings.maxResultRows} onChange={(e) => set({ maxResultRows: Math.max(100, Number(e.target.value) || 10000) })} />
              </Row>
              <Row label="NULL display">
                <Input className="w-32" value={settings.nullDisplay} onChange={(e) => set({ nullDisplay: e.target.value })} />
              </Row>
            </>
          )}
          {current === 'ai' && <AiSettingsSection />}
          {current === 'mcp' && <McpSettingsSection />}
          {current === 'about' && info && (
            <>
              <Row label="Version">
                <span className="text-[13px]">{info.version}</span>
              </Row>
              <Row label="Mode">
                <span className="text-[13px]">{info.portable ? 'Portable (data stored next to the app)' : 'Installed'}</span>
              </Row>
              <Row label="Data folder">
                <div className="flex items-center gap-2">
                  <code className="truncate rounded bg-subtle px-1.5 py-0.5 text-[12px] select-text">{info.dataDir}</code>
                  <Button size="xs" icon={<FolderOpen size={12} />} onClick={() => void api.showItemInFolder(info.dataDir)}>
                    Show
                  </Button>
                </div>
              </Row>
              <Row label="Links">
                <div className="flex gap-2">
                  <Button size="xs" onClick={() => void api.openExternal('https://github.com/eLh0m3r0/db-mastermind')}>
                    GitHub
                  </Button>
                  <Button size="xs" onClick={() => void api.openExternal('https://github.com/eLh0m3r0/db-mastermind/blob/main/ROADMAP.md')}>
                    Roadmap
                  </Button>
                  <Button size="xs" onClick={() => void api.openExternal('https://github.com/eLh0m3r0/db-mastermind/issues/new')}>
                    Report issue
                  </Button>
                </div>
              </Row>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}

export function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[170px_1fr] items-start gap-4">
      <div className="pt-1.5">
        <div className="text-[13px] font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-[11.5px] leading-snug text-fg-faint">{hint}</div>}
      </div>
      <div className="min-w-0 pt-0.5">{children}</div>
    </div>
  )
}

export { Field }

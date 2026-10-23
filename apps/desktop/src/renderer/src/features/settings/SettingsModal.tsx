import { useEffect, useState, type ReactNode } from 'react'
import { Coffee, FolderOpen, Heart } from 'lucide-react'
import type { AppSettings, ManagedInfo, TeamStatus } from '@shared/api'
import { Button } from '@/components/ui/Button'
import { Checkbox, Field, Input, Segmented, Select } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { api } from '@/lib/api'
import { cn, errorMessage } from '@/lib/utils'
import { useSettings } from '@/store/settings'
import { useUi } from '@/store/ui'
import { AiSettingsSection } from '../ai/AiSettings'
import { McpSettingsSection } from '../ai/McpSettings'
import { AiPermissionsSection } from '../ai/AiPermissions'
import { SnippetsSection } from './SnippetsSection'
import { useT } from '@/lib/i18n'

const SECTIONS = [
  ['general', 'General'],
  ['editor', 'Editor & data'],
  ['snippets', 'Snippets'],
  ['ai', 'AI assistant'],
  ['permissions', 'AI permissions'],
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
  const t = useT()
  if (!settings) return null
  const set = (patch: Partial<AppSettings>) => void update(patch)
  const current = open && modal.section ? (modal.section as Section) : section

  return (
    <Modal open={open} onClose={() => setUi({ modal: undefined })} title={t('Settings')} width={760} bodyClassName="p-0">
      <div className="flex min-h-[460px]">
        <nav className="w-[180px] shrink-0 border-r border-line bg-subtle p-2">
          {/* Sticky: on long sections (MCP server) the list stays in view while the content scrolls. */}
          <div className="sticky top-2 flex flex-col gap-0.5">
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
              {t(label)}
            </button>
          ))}
          </div>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-auto p-5">
          {current === 'general' && (
            <>
              <TeamFolderRow />
              <Row label={t('Theme')}>
                <Segmented
                  value={settings.theme}
                  onChange={(theme) => set({ theme })}
                  options={[
                    { value: 'system', label: t('System') },
                    { value: 'light', label: t('Light') },
                    { value: 'dark', label: t('Dark') },
                  ]}
                />
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
              <Row label={t('Language')}>
                <Select className="w-48" value={settings.language} onChange={(e) => set({ language: e.target.value as 'en' | 'cs' })}>
                  <option value="en">English</option>
                  <option value="cs">Čeština</option>
                </Select>
              </Row>
              <Row label={t('Safety')}>
                <Checkbox
                  checked={settings.confirmDangerousStatements}
                  onChange={(v) => set({ confirmDangerousStatements: v })}
                  label={t('Confirm DELETE/UPDATE without WHERE, DROP and TRUNCATE')}
                  hint={t('Always on for connections marked as production.')}
                />
              </Row>
              <Row label={t('Updates')}>
                <Checkbox
                  checked={settings.checkForUpdates !== false}
                  onChange={(v) => set({ checkForUpdates: v })}
                  label={t('Check for new versions automatically')}
                  hint={t('Asks GitHub every few hours. Nothing about you or your databases is sent.')}
                />
              </Row>
            </>
          )}
          {current === 'snippets' && <SnippetsSection />}
          {current === 'editor' && (
            <>
              <Row label={t('Editor font size')}>
                <Input className="w-24" type="number" min={10} max={24} value={settings.editorFontSize} onChange={(e) => set({ editorFontSize: Number(e.target.value) || 13 })} />
              </Row>
              <Row label={t('Rows per page')} hint={t('Default page size in the table browser.')}>
                <Select className="w-32" value={settings.pageSize} onChange={(e) => set({ pageSize: Number(e.target.value) })}>
                  {[50, 100, 200, 500, 1000, 5000].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </Row>
              <Row label={t('Max result rows')} hint={t('Query results stop after this many rows (export streams everything).')}>
                <Input className="w-32" type="number" min={100} step={1000} value={settings.maxResultRows} onChange={(e) => set({ maxResultRows: Math.max(100, Number(e.target.value) || 10000) })} />
              </Row>
              <Row label={t('NULL display')}>
                <Input className="w-32" value={settings.nullDisplay} onChange={(e) => set({ nullDisplay: e.target.value })} />
              </Row>
              <Row label={t('CSV separator')} hint={t('Excel set to Czech (and many other languages) splits columns on semicolons.')}>
                <Select className="w-48" value={settings.csvDelimiter ?? (settings.language === 'cs' ? ';' : ',')} onChange={(e) => set({ csvDelimiter: e.target.value as ',' | ';' })}>
                  <option value=",">{t('Comma ( , )')}</option>
                  <option value=";">{t('Semicolon ( ; )')}</option>
                </Select>
              </Row>
            </>
          )}
          {current === 'ai' && <AiSettingsSection />}
          {current === 'permissions' && <AiPermissionsSection />}
          {current === 'mcp' && <McpSettingsSection />}
          {current === 'about' && info && (
            <>
              <Row label={t('Version')}>
                <span className="text-[13px]">{info.version}</span>
              </Row>
              <Row label={t('Mode')}>
                <span className="text-[13px]">{info.portable ? t('Portable (data stored next to the app)') : t('Installed')}</span>
              </Row>
              {info.managed && (
                <Row label={t('Managed configuration')}>
                  <div className="flex flex-col gap-1 text-[12.5px]">
                    <div className="flex items-center gap-2">
                      <code className="truncate rounded bg-subtle px-1.5 py-0.5 text-[12px] select-text">{info.managed.path}</code>
                      <Button size="xs" icon={<FolderOpen size={12} />} onClick={() => void api.showItemInFolder(info.managed!.path)}>
                        {t('Show')}
                      </Button>
                    </div>
                    {info.managed.error ? (
                      <span className="text-danger">{t('The file could not be read, so AI and MCP are off: {error}', { error: info.managed.error })}</span>
                    ) : (
                      <span className="text-fg-muted">{managedSummary(info.managed, t).join(' · ')}</span>
                    )}
                  </div>
                </Row>
              )}
              <Row label={t('Data folder')}>
                <div className="flex items-center gap-2">
                  <code className="truncate rounded bg-subtle px-1.5 py-0.5 text-[12px] select-text">{info.dataDir}</code>
                  <Button size="xs" icon={<FolderOpen size={12} />} onClick={() => void api.showItemInFolder(info.dataDir)}>
                    {t('Show')}
                  </Button>
                </div>
              </Row>
              <Row label={t('Links')}>
                <div className="flex gap-2">
                  <Button size="xs" onClick={() => void api.openExternal('https://dbmastermind.app')}>
                    {t('Website')}
                  </Button>
                  <Button size="xs" onClick={() => void api.openExternal('https://github.com/eLh0m3r0/db-mastermind')}>
                    GitHub
                  </Button>
                  <Button size="xs" onClick={() => void api.openExternal('https://github.com/eLh0m3r0/db-mastermind/blob/main/ROADMAP.md')}>
                    {t('Roadmap')}
                  </Button>
                  <Button size="xs" onClick={() => void api.reportIssue()}>
                    {t('Report issue')}
                  </Button>
                </div>
              </Row>
              <Row label={t('Support the project')} hint={t('DB Mastermind is free and stays free. If it saves you time, you can buy the author a coffee.')}>
                <div className="flex gap-2">
                  <Button size="xs" variant="primary" icon={<Coffee size={12} />} onClick={() => void api.openExternal('https://ko-fi.com/vaclavmudra')}>
                    Ko-fi
                  </Button>
                  <Button size="xs" icon={<Heart size={12} />} onClick={() => void api.openExternal('https://github.com/sponsors/eLh0m3r0')}>
                    GitHub Sponsors
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

/** Shared folder with the team's connections, saved queries and knowledge bases. */
function TeamFolderRow() {
  const t = useT()
  const [status, setStatus] = useState<TeamStatus | null>(null)
  useEffect(() => {
    void api.teamStatus().then(setStatus)
  }, [])
  const choose = async (path?: string | null) => {
    try {
      setStatus(await api.setTeamFolder(path))
    } catch (err) {
      setStatus((s) => (s ? { ...s, error: errorMessage(err) } : s))
    }
  }
  return (
    <Row
      label={t('Team folder')}
      hint={t('A shared folder (network drive, OneDrive, Git) with connections.json, queries/*.sql and knowledge/: everyone gets the same connections, saved queries and notes.')}
    >
      <div className="flex flex-col gap-1 text-[12.5px]">
        <div className="flex items-center gap-2">
          {status?.folder ? <code className="truncate rounded bg-subtle px-1.5 py-0.5 text-[12px] select-text">{status.folder}</code> : <span className="text-fg-faint">{t('None')}</span>}
          {!status?.locked && (
            <>
              <Button size="xs" icon={<FolderOpen size={12} />} onClick={() => void choose()}>
                {t('Choose…')}
              </Button>
              {status?.folder && (
                <Button size="xs" variant="ghost" onClick={() => void choose(null)}>
                  {t('Stop using')}
                </Button>
              )}
            </>
          )}
        </div>
        {status?.folder && (
          <span className={status.error ? 'text-danger' : 'text-fg-muted'}>
            {status.error ?? t('Connections: {c} · saved queries: {q}', { c: status.connections, q: status.queries })}
            {status.locked && ` · ${t('set by your organization')}`}
          </span>
        )}
      </div>
    </Row>
  )
}

/** Human summary of the organization's policies for Settings → About. */
function managedSummary(m: ManagedInfo, t: ReturnType<typeof useT>): string[] {
  const p = m.policies
  const out = [t('{n} predefined connections', { n: m.connections })]
  if (p.allowAi === false) out.push(t('AI off'))
  else if (p.allowedAiProviders) out.push(t('AI providers: {list}', { list: p.allowedAiProviders.join(', ') }))
  if (p.maxAiDataSharing) out.push(t('AI sees at most: {level}', { level: p.maxAiDataSharing }))
  if (p.allowMcp === false) out.push(t('MCP off'))
  else if (p.allowMcpWrites === false) out.push(t('MCP read-only'))
  if (p.disableUpdateCheck) out.push(t('no update check'))
  return out
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

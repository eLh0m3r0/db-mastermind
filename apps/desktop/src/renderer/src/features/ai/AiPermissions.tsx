import { RotateCcw } from 'lucide-react'
import { resolveAiPermissions, type AiAccess, type AiPermissions, type ConnectionConfig } from '@dbmastermind/core/browser'
import type { AppSettings, StoredConnection } from '@shared/api'
import { IconButton } from '@/components/ui/Button'
import { Checkbox, Select } from '@/components/ui/Input'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { cn, errorMessage } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { useSettings } from '@/store/settings'
import { toast } from '@/store/ui'
import { DriverIcon } from '../connections/drivers'

/** App-wide defaults (mirrors main/ai-access.ts: older settings said the same thing). */
export function aiDefaultsOf(settings: AppSettings): AiPermissions {
  return settings.ai.defaults ?? { access: settings.ai.dataSharing === 'schema' ? 'schema' : 'write', agents: true, agentWrites: settings.mcp.allowWrites, knowledgeWrites: true }
}

/** Whether AI features apply to this connection (UI hint; the main process enforces). */
export function useAiAllowed(connection: ConnectionConfig | undefined): boolean {
  const settings = useSettings((s) => s.settings)
  if (!connection || !settings) return false
  return resolveAiPermissions(connection, aiDefaultsOf(settings)).access !== 'off'
}

function useAccessOptions(): { value: AiAccess; label: string; hint: string }[] {
  const t = useT()
  return [
    { value: 'off', label: t('Off'), hint: t('No AI on this connection') },
    { value: 'schema', label: t('Schema only'), hint: t('Tables, columns, relationships and notes; no data') },
    { value: 'read', label: t('Read data'), hint: t('Also runs read-only queries and sees their results') },
    { value: 'write', label: t('Read and write'), hint: t('Also changes data; the app asks before every change') },
  ]
}

const GRID = 'grid grid-cols-[minmax(110px,1fr)_148px_52px_88px_44px_24px] items-center gap-x-2'

/** Access level plus the agent and knowledge base switches, for one connection or the defaults. */
export function AiPermissionControls({ value, onChange, readOnlyConnection, compact }: { value: AiPermissions; onChange: (p: AiPermissions) => void; readOnlyConnection?: boolean; compact?: boolean }) {
  const t = useT()
  const options = useAccessOptions()
  const policies = useSettings((s) => s.info?.managed?.policies)
  const set = (patch: Partial<AiPermissions>) => onChange({ ...value, ...patch })
  const access = readOnlyConnection && value.access === 'write' ? 'read' : value.access
  return (
    <div className={cn(compact ? 'contents' : 'flex flex-col gap-1.5')}>
      <Select inputSize="sm" className={compact ? 'w-full' : 'w-60'} value={access} onChange={(e) => set({ access: e.target.value as AiAccess })} title={options.find((o) => o.value === value.access)?.hint}>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.value === 'write' && readOnlyConnection}>
            {o.label}
          </option>
        ))}
      </Select>
      {!compact && <span className="text-[11.5px] text-fg-faint">{options.find((o) => o.value === access)?.hint}</span>}
      <Checkbox
        checked={value.agents !== false && access !== 'off' && policies?.allowMcp !== false}
        disabled={access === 'off' || policies?.allowMcp === false}
        onChange={(agents) => set({ agents })}
        label={compact ? '' : t('External agents (Claude Code, Codex, Cursor…) over MCP')}
      />
      <Checkbox
        checked={value.agentWrites === true && access === 'write' && value.agents !== false && policies?.allowMcpWrites !== false}
        disabled={access !== 'write' || value.agents === false || policies?.allowMcpWrites === false}
        onChange={(agentWrites) => set({ agentWrites })}
        label={compact ? '' : t('Agents may change data without asking (they cannot be asked)')}
      />
      <Checkbox
        checked={value.knowledgeWrites !== false && access !== 'off'}
        disabled={access === 'off'}
        onChange={(knowledgeWrites) => set({ knowledgeWrites })}
        label={compact ? '' : t('AI may write knowledge base notes')}
      />
    </div>
  )
}

/** Settings → AI permissions: the defaults and every connection in one place. */
export function AiPermissionsSection() {
  const t = useT()
  const settings = useSettings((s) => s.settings)!
  const update = useSettings((s) => s.update)
  const connections = useConnections((s) => s.list)
  const reload = useConnections((s) => s.load)
  const policies = useSettings((s) => s.info?.managed?.policies)
  const defaults = aiDefaultsOf(settings)

  const save = async (c: StoredConnection, ai: AiPermissions | undefined) => {
    try {
      await api.saveConnection({ ...c, ai, aiEnabled: undefined })
      await reload()
    } catch (err) {
      toast({ kind: 'error', message: t('Could not save the connection'), detail: errorMessage(err) })
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12.5px] text-fg-muted">{t('What AI may do on each connection, in the app and for external agents over MCP. Read-only connections are never written.')}</p>
      {(policies?.allowAi === false || policies?.maxAiDataSharing || policies?.allowMcp === false || policies?.allowMcpWrites === false) && (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-1.5 text-[12px]">{t('Your organization limits these permissions (managed configuration); stricter rules win.')}</div>
      )}
      <div className="overflow-hidden rounded-md border border-line">
        <div className={cn(GRID, 'border-b border-line px-3 py-1.5 text-[11px] font-medium text-fg-muted')}>
          <span>{t('Connection')}</span>
          <span>{t('AI may')}</span>
          <span title={t('External agents (Claude Code, Codex, Cursor…) over MCP')}>{t('Agents')}</span>
          <span title={t('Agents may change data without asking (they cannot be asked)')}>{t('Agents write')}</span>
          <span title={t('AI may write knowledge base notes')}>{t('Notes')}</span>
          <span />
        </div>
        <div className={cn(GRID, 'border-b border-line bg-subtle px-3 py-2')}>
          <span className="text-[12.5px] font-semibold">{t('Default')}</span>
          <AiPermissionControls compact value={defaults} onChange={(p) => void update({ ai: { ...settings.ai, defaults: p } })} />
          <span />
        </div>
        {connections.map((c) => {
          const own = !!c.ai || c.aiEnabled === false
          const value = c.ai ?? (c.aiEnabled === false ? { ...defaults, access: 'off' as const } : defaults)
          return (
            <div key={c.id} className={cn(GRID, 'border-b border-line px-3 py-1.5 last:border-b-0')}>
              <span className="flex min-w-0 items-center gap-1.5 text-[12.5px]" title={c.name}>
                <DriverIcon driver={c.driver} size={14} />
                <span className="truncate">{c.name}</span>
              </span>
              <AiPermissionControls compact value={value} readOnlyConnection={c.readOnly} onChange={(p) => void save(c, p)} />
              <div className="flex items-center justify-end">
                {own ? (
                  <IconButton label={t('Use the default')} onClick={() => void save(c, undefined)}>
                    <RotateCcw size={12} />
                  </IconButton>
                ) : (
                  <span className="text-[11px] text-fg-faint">{t('default')}</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <Checkbox
        checked={settings.ai.autoRunReadQueries}
        onChange={(autoRunReadQueries) => void update({ ai: { ...settings.ai, autoRunReadQueries } })}
        label={t('Let the assistant run read-only queries without asking')}
        hint={t('Changes (INSERT, UPDATE, DELETE, DDL) always need your confirmation in the app.')}
      />
    </div>
  )
}

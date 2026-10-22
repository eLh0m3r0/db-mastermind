import { useEffect, useState } from 'react'
import { Copy, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Checkbox, Input } from '@/components/ui/Input'
import { api } from '@/lib/api'
import { copyText } from '@/lib/utils'
import { useSettings } from '@/store/settings'
import { toast } from '@/store/ui'
import { useT } from '@/lib/i18n'

export function McpSettingsSection() {
  const settings = useSettings((s) => s.settings)!
  const update = useSettings((s) => s.update)
  const info = useSettings((s) => s.info)
  const mcp = settings.mcp
  const t = useT()
  const command = info?.mcpCommand.command ?? 'dbmastermind'
  const args = info?.mcpCommand.args ?? ['--mcp']
  const quoted = [command, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')
  const snippets: [string, string][] = [
    ['Claude Code', `claude mcp add dbmastermind -- ${quoted}`],
    ['Codex CLI (~/.codex/config.toml)', `[mcp_servers.dbmastermind]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}`],
    ['Claude Desktop / Cursor / VS Code (JSON)', JSON.stringify({ mcpServers: { dbmastermind: { command, args } } }, null, 2)],
  ]
  const [status, setStatus] = useState<{ running: boolean; error?: string; url: string } | null>(null)
  useEffect(() => {
    void api.mcpHttpStatus().then(setStatus)
  }, [mcp.enabled, mcp.port])
  const httpSnippet = status ? `claude mcp add --transport http dbmastermind ${status.url} --header "Authorization: Bearer ${mcp.token}"` : ''
  const newToken = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(24))
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[12.5px] leading-relaxed text-fg-muted">
        {info?.portable
          ? t('The MCP server lets AI agents (Claude Code, Codex, Cursor, Claude Desktop…) explore your databases through DB Mastermind: list tables, read the schema and knowledge base, and run read-only queries. It uses the connections saved in this app (portable data folder), and only those with AI enabled.')
          : t('The MCP server lets AI agents (Claude Code, Codex, Cursor, Claude Desktop…) explore your databases through DB Mastermind: list tables, read the schema and knowledge base, and run read-only queries. It uses the connections saved in this app, and only those with AI enabled.')}
      </p>
      <Checkbox
        checked={mcp.allowWrites}
        onChange={(allowWrites) => void update({ mcp: { ...mcp, allowWrites } })}
        label={t('Allow agents to run write statements')}
        hint={t('Off by default. Read-only connections stay read-only either way.')}
      />
      {snippets.map(([label, code]) => (
        <div key={label} className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-medium">{label}</span>
            <Button
              size="xs"
              variant="ghost"
              icon={<Copy size={11} />}
              onClick={() => {
                void copyText(code)
                toast({ kind: 'success', message: t('Copied') })
              }}
            >
              {t('Copy')}
            </Button>
          </div>
          <pre className="overflow-auto rounded-md bg-subtle p-2.5 font-mono text-[11.5px] whitespace-pre select-text">{code}</pre>
        </div>
      ))}
      <div className="flex flex-col gap-2 rounded-md border border-line p-3">
        <Checkbox
          checked={mcp.enabled}
          onChange={(enabled) => void update({ mcp: { ...mcp, enabled } })}
          label={t('Local HTTP endpoint while the app is running')}
          hint={t('Agents connect to this window instead of starting their own copy. Only this computer can reach it, with the token below.')}
        />
        {mcp.enabled && (
          <>
            <div className="flex items-center gap-2 text-[12px]">
              <span className="w-12 text-fg-muted">{t('Port')}</span>
              <Input inputSize="sm" type="number" className="w-24" value={mcp.port} onChange={(e) => void update({ mcp: { ...mcp, port: Number(e.target.value) || 7337 } })} />
              <span className={status?.running ? 'text-success' : 'text-danger'}>{status?.running ? t('Running at {url}', { url: status.url }) : (status?.error ?? t('Not running'))}</span>
            </div>
            <div className="flex items-center gap-2 text-[12px]">
              <span className="w-12 text-fg-muted">{t('Token')}</span>
              <Input inputSize="sm" readOnly className="flex-1 font-mono text-[11.5px]" value={mcp.token} />
              <Button size="xs" variant="ghost" icon={<RefreshCw size={11} />} onClick={() => void update({ mcp: { ...mcp, token: newToken() } })}>
                {t('New token')}
              </Button>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-medium">Claude Code (HTTP)</span>
              <Button size="xs" variant="ghost" icon={<Copy size={11} />} onClick={() => void copyText(httpSnippet).then(() => toast({ kind: 'success', message: t('Copied') }))}>
                {t('Copy')}
              </Button>
            </div>
            <pre className="overflow-auto rounded-md bg-subtle p-2.5 font-mono text-[11.5px] whitespace-pre-wrap select-text">{httpSnippet}</pre>
          </>
        )}
      </div>
      <p className="text-[11.5px] text-fg-faint">
        {t('The agent starts DB Mastermind in the background without a window, so it can use the passwords stored in your keychain. If you move the app, update the path. Headless servers can use the standalone')}{' '}
        <code>npx dbmastermind-mcp --url …</code> {t('instead.')}
      </p>
    </div>
  )
}

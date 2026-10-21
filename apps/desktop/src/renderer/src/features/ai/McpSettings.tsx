import { Copy } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Input'
import { copyText } from '@/lib/utils'
import { useSettings } from '@/store/settings'
import { toast } from '@/store/ui'

export function McpSettingsSection() {
  const settings = useSettings((s) => s.settings)!
  const update = useSettings((s) => s.update)
  const info = useSettings((s) => s.info)
  const mcp = settings.mcp
  const command = info?.mcpCommand.command ?? 'dbmastermind'
  const args = info?.mcpCommand.args ?? ['--mcp']
  const quoted = [command, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')
  const snippets: [string, string][] = [
    ['Claude Code', `claude mcp add dbmastermind -- ${quoted}`],
    ['Codex CLI (~/.codex/config.toml)', `[mcp_servers.dbmastermind]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}`],
    ['Claude Desktop / Cursor / VS Code (JSON)', JSON.stringify({ mcpServers: { dbmastermind: { command, args } } }, null, 2)],
  ]
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[12.5px] leading-relaxed text-fg-muted">
        The MCP server lets AI agents (Claude Code, Codex, Cursor, Claude Desktop…) explore your databases through DB Mastermind: list tables, read
        the schema and knowledge base, and run <b>read-only</b> queries. It uses the connections saved in this app
        {info?.portable ? ' (portable data folder)' : ''}, and only those with AI enabled.
      </p>
      <Checkbox
        checked={mcp.allowWrites}
        onChange={(allowWrites) => void update({ mcp: { ...mcp, allowWrites } })}
        label="Allow agents to run write statements"
        hint="Off by default. Read-only connections stay read-only either way."
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
                toast({ kind: 'success', message: 'Copied' })
              }}
            >
              Copy
            </Button>
          </div>
          <pre className="overflow-auto rounded-md bg-subtle p-2.5 font-mono text-[11.5px] whitespace-pre select-text">{code}</pre>
        </div>
      ))}
      <p className="text-[11.5px] text-fg-faint">
        The agent starts DB Mastermind in the background without a window, so it can use the passwords stored in your keychain. If you move the
        app, update the path. Headless servers can use the standalone <code>npx dbmastermind-mcp --url …</code> instead.
      </p>
    </div>
  )
}

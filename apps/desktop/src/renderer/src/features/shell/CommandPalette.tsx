import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Command } from 'cmdk'
import { Activity, BookOpen, FileCode2, FileSpreadsheet, FileText, Rows3, ShieldCheck, Eye, GitCompare, Moon, Network, Plug, Plus, RefreshCw, Settings, Sparkles, Sun, Table2, TerminalSquare, Unplug } from 'lucide-react'
import { Kbd } from '@/components/ui/Input'
import { api, modKey } from '@/lib/api'
import { runCommand } from '@/lib/commands'
import { exportDataDictionary } from '@/lib/dictionary'
import { queryFile } from '@/lib/files'
import { fuzzyScore } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { useSettings } from '@/store/settings'
import { useUi } from '@/store/ui'
import { useWorkspace } from '@/store/workspace'
import { DriverIcon } from '../connections/drivers'
import { connectAndSelect, useCurrentConnectionId } from '../sidebar/Sidebar'
import { useT } from '@/lib/i18n'

export function CommandPalette() {
  const mode = useUi((s) => s.palette)
  const setUi = useUi((s) => s.set)
  const connectionId = useCurrentConnectionId()
  const schema = useConnections((s) => (connectionId ? s.runtime[connectionId]?.schema : undefined))
  const connections = useConnections((s) => s.list)
  const openTab = useWorkspace((s) => s.open)
  const [search, setSearch] = useState('')
  const t = useT()
  const close = () => {
    setUi({ palette: undefined })
    setSearch('')
  }
  const run = (fn: () => void) => {
    close()
    fn()
  }

  const tables = useMemo(() => {
    if (!schema) return []
    const q = search.trim()
    const list = q
      ? schema.tables
          .map((t) => ({ t, score: fuzzyScore(t.name, q) }))
          .filter((x) => x.score >= 0)
          .sort((a, b) => b.score - a.score)
          .map((x) => x.t)
      : schema.tables
    return list.slice(0, mode === 'tables' ? 200 : 30)
  }, [schema, search, mode])

  if (!mode) return null
  const dark = useSettings.getState().dark

  const commands: { id: string; label: string; icon: React.ReactNode; shortcut?: string; run: () => void; needsConnection?: boolean }[] = [
    { id: 'new-query', label: t('New query tab'), icon: <TerminalSquare size={14} />, shortcut: `${modKey}T`, run: () => runCommand('new-query'), needsConnection: true },
    { id: 'query-file', label: t('Query a CSV, Parquet, JSON or Excel file…'), icon: <FileSpreadsheet size={14} />, run: () => void queryFile() },
    { id: 'new-connection', label: t('New connection…'), icon: <Plus size={14} />, run: () => setUi({ modal: { kind: 'connection' } }) },
    { id: 'diagram', label: t('Open ER diagram'), icon: <Network size={14} />, run: () => connectionId && openTab({ kind: 'diagram', connectionId, title: t('ER diagram') }), needsConnection: true },
    { id: 'compare', label: t('Compare schemas…'), icon: <GitCompare size={14} />, run: () => connectionId && openTab({ kind: 'compare', connectionId, title: t('Schema compare') }, { reuse: false }), needsConnection: true },
    { id: 'activity', label: t('Server activity'), icon: <Activity size={14} />, run: () => connectionId && openTab({ kind: 'activity', connectionId, title: t('Server activity') }), needsConnection: true },
    { id: 'dictionary-html', label: t('Export data dictionary (HTML)…'), icon: <FileText size={14} />, run: () => connectionId && void exportDataDictionary(connectionId, 'html'), needsConnection: true },
    { id: 'dictionary-md', label: t('Export data dictionary (Markdown)…'), icon: <FileText size={14} />, run: () => connectionId && void exportDataDictionary(connectionId, 'markdown'), needsConnection: true },
    { id: 'datacompare', label: t('Compare table data…'), icon: <Rows3 size={14} />, run: () => connectionId && openTab({ kind: 'datacompare', connectionId, sourceId: connectionId, title: t('Data compare') }, { reuse: false }), needsConnection: true },
    { id: 'roles', label: t('Users & roles'), icon: <ShieldCheck size={14} />, run: () => connectionId && openTab({ kind: 'roles', connectionId, title: t('Users & roles') }), needsConnection: true },
    { id: 'model-new', label: t('New model (DBML)'), icon: <FileCode2 size={14} />, run: () => connectionId && openTab({ kind: 'model', connectionId, title: t('Model'), text: '' }, { reuse: false }), needsConnection: true },
    {
      id: 'model-open',
      label: t('Open model (.dbml)…'),
      icon: <FileCode2 size={14} />,
      run: () => {
        if (!connectionId) return
        const kb = useConnections.getState().list.find((c) => c.id === connectionId)?.knowledgeBasePath
        void api.openModelFile(undefined, kb).then((f) => f && openTab({ kind: 'model', connectionId, title: f.path.split(/[\\/]/).pop() ?? t('Model'), text: f.text, path: f.path }, { reuse: false }))
      },
      needsConnection: true,
    },
    { id: 'knowledge', label: t('Open knowledge base'), icon: <BookOpen size={14} />, run: () => connectionId && openTab({ kind: 'knowledge', connectionId, title: t('Knowledge base') }), needsConnection: true },
    { id: 'refresh', label: t('Refresh schema'), icon: <RefreshCw size={14} />, shortcut: 'F5', run: () => runCommand('refresh-schema'), needsConnection: true },
    { id: 'ai', label: t('Toggle AI assistant'), icon: <Sparkles size={14} />, shortcut: `${modKey}J`, run: () => runCommand('toggle-ai') },
    { id: 'sidebar', label: t('Toggle sidebar'), icon: <Eye size={14} />, shortcut: `${modKey}B`, run: () => runCommand('toggle-sidebar') },
    { id: 'theme', label: dark ? t('Switch to light theme') : t('Switch to dark theme'), icon: dark ? <Sun size={14} /> : <Moon size={14} />, run: () => void useSettings.getState().update({ theme: dark ? 'light' : 'dark' }) },
    { id: 'settings', label: t('Settings…'), icon: <Settings size={14} />, shortcut: `${modKey},`, run: () => setUi({ modal: { kind: 'settings' } }) },
    { id: 'disconnect', label: t('Disconnect'), icon: <Unplug size={14} />, run: () => runCommand('disconnect'), needsConnection: true },
  ]

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 pt-[12vh] dark:bg-black/45" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <Command
        label={t('Command palette')}
        shouldFilter={mode === 'commands'}
        className="w-[600px] max-w-[92vw] overflow-hidden rounded-xl border border-line bg-elevated shadow-pop"
        onKeyDown={(e) => e.key === 'Escape' && close()}
      >
        <Command.Input
          autoFocus
          value={search}
          onValueChange={setSearch}
          placeholder={mode === 'tables' ? t('Open table…') : t('Type a command or table name…')}
          className="h-12 w-full border-b border-line bg-transparent px-4 text-[14px] outline-none placeholder:text-fg-faint"
        />
        <Command.List className="max-h-[420px] overflow-auto p-1.5 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-fg-faint [&_[cmdk-group-heading]]:uppercase">
          <Command.Empty className="p-6 text-center text-[12.5px] text-fg-faint">{t('No results')}</Command.Empty>
          {tables.length > 0 && connectionId && (
            <Command.Group heading={t('Tables')}>
              {tables.map((t) => (
                <Item
                  key={`${t.schema}.${t.name}`}
                  value={`table ${t.schema ?? ''}.${t.name}`}
                  onSelect={() => run(() => openTab({ kind: 'table', connectionId, table: { schema: t.schema, name: t.name }, title: t.name }))}
                  icon={t.type === 'table' ? <Table2 size={14} className="text-accent" /> : <Eye size={14} className="text-info" />}
                  label={t.name}
                  hint={t.schema && t.schema !== schema?.defaultSchema ? t.schema : undefined}
                />
              ))}
            </Command.Group>
          )}
          {mode === 'commands' && (
            <>
              <Command.Group heading={t('Commands')}>
                {commands
                  .filter((c) => !c.needsConnection || connectionId)
                  .map((c) => (
                    <Item key={c.id} value={c.label} onSelect={() => run(c.run)} icon={c.icon} label={c.label} shortcut={c.shortcut} />
                  ))}
              </Command.Group>
              <Command.Group heading={t('Connections')}>
                {connections.map((c) => (
                  <Item key={c.id} value={`connect ${c.name}`} onSelect={() => run(() => void connectAndSelect(c.id))} icon={<DriverIcon driver={c.driver} size={14} />} label={c.name} hint={<Plug size={12} />} />
                ))}
              </Command.Group>
            </>
          )}
        </Command.List>
      </Command>
    </div>,
    document.body,
  )
}

function Item({ value, onSelect, icon, label, hint, shortcut }: { value: string; onSelect: () => void; icon: React.ReactNode; label: string; hint?: React.ReactNode; shortcut?: string }) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex h-8 cursor-default items-center gap-2.5 rounded-md px-2 text-[13px] data-[selected=true]:bg-accent data-[selected=true]:text-accent-fg [&[data-selected=true]_*]:text-accent-fg"
    >
      <span className="flex w-4 justify-center text-fg-muted">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {hint && <span className="text-[11.5px] text-fg-faint">{hint}</span>}
      {shortcut && <Kbd>{shortcut}</Kbd>}
    </Command.Item>
  )
}

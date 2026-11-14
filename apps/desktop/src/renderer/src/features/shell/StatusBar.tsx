import { lookById } from '@/lib/looks'
import { Database, Sparkles } from 'lucide-react'
import { useConnections } from '@/store/connections'
import { useSettings } from '@/store/settings'
import { useUi } from '@/store/ui'
import { useActiveTab } from '@/store/workspace'
import { formatCount } from '@/lib/utils'
import { driverLabel } from '../connections/drivers'
import { StatusDot, useCurrentConnectionId } from '../sidebar/Sidebar'
import { tp, useT } from '@/lib/i18n'

export function StatusBar() {
  const connectionId = useCurrentConnectionId()
  const connection = useConnections((s) => s.list.find((c) => c.id === connectionId))
  const runtime = useConnections((s) => (connectionId ? s.runtime[connectionId] : undefined))
  const info = useSettings((s) => s.info)
  const lookEmoji = useSettings((s) => lookById(s.settings?.look).emoji)
  const tab = useActiveTab()
  const setUi = useUi((s) => s.set)
  const t = useT()
  return (
    <div className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-subtle px-2.5 text-[11.5px] text-fg-muted">
      {connection ? (
        <>
          <span className="flex items-center gap-1.5">
            <StatusDot id={connection.id} />
            <span className="font-medium text-fg">{connection.name}</span>
          </span>
          <span className="flex items-center gap-1">
            <Database size={11} />
            {runtime?.serverInfo ? `${runtime.serverInfo.product} ${runtime.serverInfo.version}` : driverLabel(connection.driver)}
          </span>
          {runtime?.schema && <span>{tp(runtime.schema.tables.filter((x) => x.type === 'table').length, { one: '{n} table', many: '{n} tables' }, { n: formatCount(runtime.schema.tables.filter((x) => x.type === 'table').length) })}</span>}
          {tab?.kind === 'table' && <span className="truncate">{tab.table.schema ? `${tab.table.schema}.` : ''}{tab.table.name}</span>}
        </>
      ) : null}
      <div className="flex-1" />
      <button type="button" className="flex items-center gap-1 hover:text-fg" onClick={() => setUi({ aiPanelVisible: !useUi.getState().aiPanelVisible })}>
        <Sparkles size={11} /> AI
      </button>
      {info?.portable && <span title={info.dataDir}>{t('Portable')}</span>}
      <span className="text-fg-faint">
        {lookEmoji && <span className="mr-1" aria-hidden>{lookEmoji}</span>}v{info?.version}
      </span>
    </div>
  )
}

import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Eye, Link2, Search, Shapes, Table2 } from 'lucide-react'
import type { DezignSqlObject, TableInfo } from '@dbmastermind/core/browser'
import { Input } from '@/components/ui/Input'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
export const tableKey = (t: { schema?: string; name: string }) => `${t.schema ?? ''}.${t.name}`

export type BrowserRequest =
  | { kind: 'locate'; key: string }
  | { kind: 'table'; key: string }
  | { kind: 'relationship'; key: string; fk: string }

/**
 * The model's objects in a tree, as DeZign's object browser lists them: tables, relationships, domains and views,
 * found by name (without diacritics). A click shows the object on the diagram, a double-click opens its dialog.
 */
export function ObjectBrowser({
  tables,
  domains,
  views,
  onRequest,
  onViews,
  onDomains,
}: {
  tables: TableInfo[]
  domains: { name: string; dataType: string }[]
  views: DezignSqlObject[]
  onRequest: (request: BrowserRequest) => void
  onViews?: () => void
  onDomains?: () => void
}) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [closed, setClosed] = useState<Record<string, boolean>>({ relationships: true })
  const [current, setCurrent] = useState<string>()
  const q = fold(query.trim())
  const matches = (...texts: (string | undefined)[]) => !q || texts.some((x) => x && fold(x).includes(q))
  const sorted = useMemo(() => [...tables].filter((x) => x.type !== 'view').sort((a, b) => tableKey(a).localeCompare(tableKey(b))), [tables])
  const shownTables = sorted.filter((x) => matches(x.name, x.comment ?? undefined, ...x.columns.map((c) => c.name)))
  const relationships = sorted.flatMap((x) => x.foreignKeys.filter((f) => !f.virtual).map((f) => ({ table: x, fk: f })))
  const shownRelationships = relationships.filter(({ table, fk }) => matches(fk.name, table.name, fk.refTable))
  const shownDomains = domains.filter((d) => matches(d.name, d.dataType))
  const shownViews = views.filter((v) => v.kind === 'view' && matches(v.name))
  const schemas = new Set(sorted.map((x) => x.schema ?? '')).size > 1
  const label = (x: { schema?: string; name: string }) => (schemas && x.schema ? `${x.schema}.${x.name}` : x.name)

  const group = (id: string, title: string, count: number, icon: React.ReactNode, children: React.ReactNode) => {
    // A search opens every group that has something.
    const open = q ? count > 0 : !closed[id]
    return (
      <div>
        <button type="button" className="flex h-7 w-full items-center gap-1 px-2 text-left text-[11.5px] font-semibold tracking-wide text-fg-muted uppercase hover:bg-subtle" onClick={() => setClosed({ ...closed, [id]: !closed[id] })} data-testid={`browser-group-${id}`}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {icon}
          <span className="flex-1">{title}</span>
          <span className="font-normal text-fg-faint">{count}</span>
        </button>
        {open && children}
      </div>
    )
  }
  const item = (id: string, text: React.ReactNode, hint: string | undefined, onClick: () => void, onDoubleClick?: () => void, testId?: string) => (
    <button
      key={id}
      type="button"
      className={cn('flex h-6 w-full items-center gap-1.5 truncate pr-2 pl-7 text-left text-[12.5px] hover:bg-subtle', current === id && 'bg-accent-soft')}
      onClick={() => {
        setCurrent(id)
        onClick()
      }}
      onDoubleClick={onDoubleClick}
      title={hint}
      data-testid={testId}
    >
      {text}
    </button>
  )

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="object-browser">
      <div className="relative shrink-0 border-b border-line p-1.5">
        <Search size={12} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-fg-faint" />
        <Input inputSize="sm" className="pl-7" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('Find a table, column, relationship…')} data-testid="browser-search" />
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {group(
          'tables',
          t('Tables'),
          shownTables.length,
          <Table2 size={12} />,
          shownTables.map((x) =>
            item(
              `t:${tableKey(x)}`,
              <>
                <span className="truncate">{label(x)}</span>
                <span className="ml-auto shrink-0 text-[11px] text-fg-faint">{x.columns.length}</span>
              </>,
              x.comment ?? undefined,
              () => onRequest({ kind: 'locate', key: tableKey(x) }),
              () => onRequest({ kind: 'table', key: tableKey(x) }),
              `browser-table-${x.name}`,
            ),
          ),
        )}
        {group(
          'relationships',
          t('Relationships'),
          shownRelationships.length,
          <Link2 size={12} />,
          shownRelationships.map(({ table, fk }) =>
            item(
              `r:${tableKey(table)}:${fk.name}`,
              <span className="truncate">
                {table.name} → {fk.refTable}
                {fk.name && <span className="ml-1.5 font-mono text-[11px] text-fg-faint">{fk.name}</span>}
              </span>,
              `${table.name}(${fk.columns.join(', ')}) → ${fk.refTable}(${fk.refColumns.join(', ')})`,
              () => onRequest({ kind: 'locate', key: tableKey(table) }),
              () => onRequest({ kind: 'relationship', key: tableKey(table), fk: fk.name }),
              `browser-relationship-${fk.name}`,
            ),
          ),
        )}
        {domains.length > 0 &&
          group(
            'domains',
            t('Domains'),
            shownDomains.length,
            <Shapes size={12} />,
            shownDomains.map((d) =>
              item(
                `d:${d.name}`,
                <>
                  <span className="truncate">{d.name}</span>
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-fg-faint">{d.dataType}</span>
                </>,
                undefined,
                () => {},
                onDomains,
              ),
            ),
          )}
        {views.some((v) => v.kind === 'view') &&
          group(
            'views',
            t('Views'),
            shownViews.length,
            <Eye size={12} />,
            shownViews.map((v) => item(`v:${v.schema ?? ''}.${v.name}`, <span className="truncate">{v.schema ? `${v.schema}.${v.name}` : v.name}</span>, undefined, () => {}, onViews)),
          )}
      </div>
    </div>
  )
}

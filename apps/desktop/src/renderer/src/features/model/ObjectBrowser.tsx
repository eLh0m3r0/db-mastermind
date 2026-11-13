import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Code2, Eye, FolderTree, Hash, Link2, ListOrdered, Package, Plus, ListTodo, Search, Shapes, Table2, Tag, Zap } from 'lucide-react'
import { attributePackages, type DezignLabel, type DezignSqlObject, type TableInfo } from '@dbmastermind/core/browser'
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
  enums,
  groups,
  onEnums,
  onGroups,
  labels,
}: {
  tables: TableInfo[]
  domains: { name: string; dataType: string }[]
  views: DezignSqlObject[]
  onRequest: (request: BrowserRequest) => void
  /** Opens the dialog of the project's SQL objects (on the one given). */
  onViews?: (start?: string) => void
  onDomains?: () => void
  /** A model of its own (not DeZign's): its enums and table groups, edited in their dialogs. */
  enums?: Record<string, string[]>
  groups?: Record<string, string[]>
  onEnums?: () => void
  onGroups?: () => void
  /** The labels the project defines (DeZign's "Labeled objects"). */
  labels?: DezignLabel[]
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
  const shownCode = (kind: DezignSqlObject['kind']) => views.filter((v) => v.kind === kind && v.id && matches(v.name, v.table))
  const packages = useMemo(() => attributePackages(tables), [tables])
  const shownPackages = packages.filter((p) => matches(p.name, ...p.columns.map((c) => c.name)))
  const schemas = new Set(sorted.map((x) => x.schema ?? '')).size > 1
  const label = (x: { schema?: string; name: string }) => (schemas && x.schema ? `${x.schema}.${x.name}` : x.name)
  // DeZign's to-do list: every table and column with something still to do.
  const todos = sorted.flatMap((x) => [...(x.todo ? [{ table: x, text: label(x), todo: x.todo }] : []), ...x.columns.filter((c) => c.todo).map((c) => ({ table: x, text: `${label(x)}.${c.name}`, todo: c.todo! }))])
  const shownTodos = todos.filter((x) => matches(x.text, x.todo))
  // What carries each label: tables, and columns as `table.column`.
  const labeled = (labels ?? []).map((l) => {
    const is = (list: string[] | undefined) => !!list?.some((x) => x.toLowerCase() === l.name.toLowerCase())
    const objects = sorted.flatMap((x) => [...(is(x.labels) ? [{ table: x, text: label(x) }] : []), ...x.columns.filter((c) => is(c.labels)).map((c) => ({ table: x, text: `${label(x)}.${c.name}` }))])
    return { label: l, objects: objects.filter((o) => matches(l.name, o.text)) }
  })

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
      // (Enter opens what a double-click opens; Space finds it on the diagram.)
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || !onDoubleClick) return
        e.preventDefault()
        setCurrent(id)
        onDoubleClick()
      }}
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
        {packages.length > 0 &&
          group(
            'packages',
            t('Attribute packages'),
            shownPackages.length,
            <Package size={12} />,
            shownPackages.map((p) =>
              item(
                `p:${p.name}`,
                <>
                  <span className="truncate">{p.name}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-fg-faint" title={t('Used by {n} tables', { n: String(p.tables) })}>
                    {p.tables}
                  </span>
                </>,
                p.columns.map((c) => `${c.name} ${c.dataType}`).join('\n'),
                () => {},
                undefined,
                `browser-package-${p.name}`,
              ),
            ),
          )}
        {todos.length > 0 &&
          group(
            'todo',
            t('To-do list'),
            shownTodos.length,
            <ListTodo size={12} />,
            shownTodos.map((x) =>
              item(
                `todo:${x.text}`,
                <>
                  <span className="shrink-0 truncate">{x.text}</span>
                  <span className="ml-auto min-w-0 truncate pl-2 text-[11px] text-fg-muted">{x.todo.split('\n')[0]}</span>
                </>,
                x.todo,
                () => onRequest({ kind: 'locate', key: tableKey(x.table) }),
                () => onRequest({ kind: 'table', key: tableKey(x.table) }),
                `browser-todo-${x.text}`,
              ),
            ),
          )}
        {labeled.some((l) => l.objects.length) &&
          group(
            'labels',
            t('Labeled objects'),
            labeled.reduce((n, l) => n + l.objects.length, 0),
            <Tag size={12} />,
            labeled
              .filter((l) => l.objects.length)
              .map((l) => (
                <div key={l.label.id}>
                  <div className="flex h-6 items-center gap-1.5 pl-5 text-[12px] font-medium text-fg-muted">
                    <Tag size={10} />
                    <span className="truncate">{l.label.name}</span>
                    <span className="ml-auto pr-2 text-[11px] font-normal text-fg-faint">{l.objects.length}</span>
                  </div>
                  {l.objects.map((o) => item(`l:${l.label.id}:${o.text}`, <span className="truncate">{o.text}</span>, undefined, () => onRequest({ kind: 'locate', key: tableKey(o.table) }), () => onRequest({ kind: 'table', key: tableKey(o.table) }), `browser-labeled-${o.text}`))}
                </div>
              )),
          )}
        {views.some((v) => v.kind === 'view') &&
          group(
            'views',
            t('Views'),
            shownViews.length,
            <Eye size={12} />,
            shownViews.map((v) => item(`v:${v.schema ?? ''}.${v.name}`, <span className="truncate">{v.schema ? `${v.schema}.${v.name}` : v.name}</span>, undefined, () => {}, () => onViews?.(v.id))),
          )}
        {(
          [
            ['trigger', 'Triggers', <Zap key="i" size={12} />],
            ['procedure', 'Procedures', <Code2 key="i" size={12} />],
            ['sequence', 'Sequences', <Hash key="i" size={12} />],
          ] as const
        ).map(
          ([kind, title, icon]) =>
            views.some((v) => v.kind === kind && v.id) &&
            group(
              kind,
              t(title),
              shownCode(kind).length,
              icon,
              shownCode(kind).map((v) => item(`${kind}:${v.id}`, <span className="truncate">{kind === 'trigger' && v.table ? `${v.table}.${v.name}` : v.schema ? `${v.schema}.${v.name}` : v.name}</span>, undefined, () => {}, () => onViews?.(v.id), `browser-${kind}-${v.name}`)),
            ),
        )}
        {onEnums &&
          group(
            'enums',
            t('Enums'),
            Object.keys(enums ?? {}).filter((n) => matches(n)).length,
            <ListOrdered size={12} />,
            <>
              {Object.entries(enums ?? {})
                .filter(([n]) => matches(n))
                .map(([n, values]) => item(`e:${n}`, <span className="truncate">{n}</span>, values.join(', '), onEnums, onEnums, `browser-enum-${n}`))}
              {item('e:+', <span className="flex items-center gap-1 text-fg-muted"><Plus size={11} />{t('Edit enums…')}</span>, undefined, onEnums, undefined, 'browser-enums-edit')}
            </>,
          )}
        {onGroups &&
          group(
            'groups',
            t('Table groups'),
            Object.keys(groups ?? {}).filter((n) => matches(n)).length,
            <FolderTree size={12} />,
            <>
              {Object.entries(groups ?? {})
                .filter(([n]) => matches(n))
                .map(([n, members]) => item(`g:${n}`, <><span className="truncate">{n}</span><span className="ml-auto shrink-0 text-[11px] text-fg-faint">{members.length}</span></>, members.join(', '), onGroups, onGroups, `browser-group-item-${n}`))}
              {item('g:+', <span className="flex items-center gap-1 text-fg-muted"><Plus size={11} />{t('Edit table groups…')}</span>, undefined, onGroups, undefined, 'browser-groups-edit')}
            </>,
          )}
      </div>
    </div>
  )
}

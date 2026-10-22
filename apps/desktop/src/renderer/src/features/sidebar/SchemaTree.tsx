import { useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ChevronRight,
  Code2,
  Copy,
  Eye,
  EyeOff,
  FileText,
  FileCode2,
  Hash,
  KeyRound,
  Layers,
  Link2,
  Network,
  Pin,
  PinOff,
  RefreshCw,
  Rows3,
  Search,
  Sparkles,
  Table2,
  TerminalSquare,
} from 'lucide-react'
import { getDialect, qualify, type SchemaSnapshot, type TableInfo } from '@dbmastermind/core/browser'
import type { StoredConnection } from '@shared/api'
import { IconButton } from '@/components/ui/Button'
import { openMenu } from '@/components/ui/ContextMenu'
import { Input } from '@/components/ui/Input'
import { Spinner } from '@/components/ui/Spinner'
import { exportDataDictionary } from '@/lib/dictionary'
import { copyText, cn, formatCount, fuzzyScore } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { askAi } from '@/store/ui'
import { useWorkspace } from '@/store/workspace'
import { tp, useT } from '@/lib/i18n'

type Node =
  | { kind: 'schema'; key: string; name: string; count: number; depth: 0 }
  | { kind: 'group'; key: string; label: string; count: number; depth: number; groupKey: string }
  | { kind: 'hidden'; key: string; count: number; depth: number }
  | { kind: 'table'; key: string; table: TableInfo; depth: number }
  | { kind: 'column'; key: string; table: TableInfo; column: TableInfo['columns'][number]; depth: number }
  | { kind: 'routine'; key: string; name: string; schema?: string; routineKind: string; depth: number }

const ROW = 24

export function generateSql(kind: 'select' | 'insert' | 'update' | 'delete' | 'count', table: TableInfo, connection: StoredConnection): string {
  const d = getDialect(connection.driver)
  const name = qualify(d, { schema: table.schema, name: table.name })
  const cols = table.columns.map((c) => d.quoteIdent(c.name))
  const key = table.primaryKey.length ? table.primaryKey : table.columns.slice(0, 1).map((c) => c.name)
  const where = key.map((k) => `${d.quoteIdent(k)} = ?`).join(' AND ')
  switch (kind) {
    case 'select':
      return connection.driver === 'mssql'
        ? `SELECT TOP 100\n  ${cols.join(',\n  ')}\nFROM ${name};`
        : `SELECT\n  ${cols.join(',\n  ')}\nFROM ${name}\nLIMIT 100;`
    case 'count':
      return `SELECT COUNT(*) FROM ${name};`
    case 'insert': {
      const insertable = table.columns.filter((c) => !c.isIdentity && !c.isGenerated)
      return `INSERT INTO ${name} (\n  ${insertable.map((c) => d.quoteIdent(c.name)).join(',\n  ')}\n) VALUES (\n  ${insertable.map(() => '?').join(',\n  ')}\n);`
    }
    case 'update': {
      const settable = table.columns.filter((c) => !c.isPrimaryKey && !c.isIdentity && !c.isGenerated)
      return `UPDATE ${name}\nSET\n  ${settable.map((c) => `${d.quoteIdent(c.name)} = ?`).join(',\n  ')}\nWHERE ${where};`
    }
    case 'delete':
      return `DELETE FROM ${name}\nWHERE ${where};`
  }
}

const pinKey = (t: TableInfo) => (t.schema ? `${t.schema}.${t.name}` : t.name)

export const EXPLAIN_TABLE_PROMPT =
  'Explain the table {table}: what it stores, what its columns mean (look at a few sample rows to decode statuses and codes), how it relates to other tables, and two or three typical queries. Use the knowledge base if it documents this table.'

export function SchemaTree({ connection, schema }: { connection: StoredConnection; schema?: SchemaSnapshot }) {
  const runtime = useConnections((s) => s.runtime[connection.id])
  const loadSchema = useConnections((s) => s.loadSchema)
  const togglePin = useConnections((s) => s.togglePin)
  const setHiddenSchemas = useConnections((s) => s.setHiddenSchemas)
  const openTab = useWorkspace((s) => s.open)
  const newQuery = useWorkspace((s) => s.newQuery)
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [collapsedSchemas, setCollapsedSchemas] = useState<Set<string>>(() => new Set())
  const scrollRef = useRef<HTMLDivElement>(null)
  const tr = useT()

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const nodes = useMemo<Node[]>(() => {
    if (!schema) return []
    const q = filter.trim()
    const matches = (t: TableInfo) => !q || fuzzyScore(t.name, q) >= 0 || t.columns.some((c) => c.name.toLowerCase() === q.toLowerCase())
    const out: Node[] = []
    const pinned = (connection.pinnedTables ?? []).map((p) => schema.tables.find((t) => pinKey(t) === p)).filter((t): t is TableInfo => !!t)
    if (pinned.length && !q) {
      const groupKey = 'g::Pinned'
      out.push({ kind: 'group', key: groupKey, label: 'Pinned', count: pinned.length, depth: 0, groupKey })
      if (!expanded.has(`${groupKey}:collapsed`)) {
        for (const t of pinned) {
          const key = `p:${pinKey(t)}`
          out.push({ kind: 'table', key, table: t, depth: 1 })
          if (expanded.has(key)) for (const c of t.columns) out.push({ kind: 'column', key: `${key}.${c.name}`, table: t, column: c, depth: 2 })
        }
      }
    }
    const hidden = new Set(connection.hiddenSchemas ?? [])
    const allSchemas = schema.schemas.length ? schema.schemas : [...new Set(schema.tables.map((t) => t.schema ?? ''))]
    const schemaNames = allSchemas.filter((s) => !hidden.has(s))
    const hiddenCount = allSchemas.length - schemaNames.length
    const multi = schemaNames.length > 1
    const ordered = [...schemaNames].sort((a, b) => (a === schema.defaultSchema ? -1 : b === schema.defaultSchema ? 1 : a.localeCompare(b)))
    for (const s of ordered) {
      const tables = schema.tables.filter((t) => (t.schema ?? '') === s && matches(t))
      const routines = schema.routines.filter((r) => (r.schema ?? '') === s && (!q || fuzzyScore(r.name, q) >= 0))
      if (q && tables.length === 0 && routines.length === 0) continue
      if (!q && tables.length === 0 && routines.length === 0 && s !== schema.defaultSchema) {
        if (multi) out.push({ kind: 'schema', key: `s:${s}`, name: s, count: 0, depth: 0 })
        continue
      }
      const schemaKey = `s:${s}`
      const base = multi ? 1 : 0
      if (multi) {
        out.push({ kind: 'schema', key: schemaKey, name: s, count: tables.length, depth: 0 })
        if (collapsedSchemas.has(schemaKey) && !q) continue
      }
      const sorted = q ? [...tables].sort((a, b) => fuzzyScore(b.name, q) - fuzzyScore(a.name, q)) : tables
      const groups: [string, TableInfo[]][] = [
        ['Tables', sorted.filter((t) => t.type === 'table')],
        ['Views', sorted.filter((t) => t.type !== 'table')],
      ]
      for (const [label, items] of groups) {
        if (!items.length) continue
        const groupKey = `g:${s}:${label}`
        out.push({ kind: 'group', key: groupKey, label, count: items.length, depth: base, groupKey })
        if (expanded.has(`${groupKey}:collapsed`) && !q) continue
        for (const t of items) {
          const key = `t:${s}.${t.name}`
          out.push({ kind: 'table', key, table: t, depth: base + 1 })
          if (expanded.has(key)) {
            for (const c of t.columns) out.push({ kind: 'column', key: `${key}.${c.name}`, table: t, column: c, depth: base + 2 })
          }
        }
      }
      if (routines.length) {
        const groupKey = `g:${s}:Routines`
        out.push({ kind: 'group', key: groupKey, label: 'Functions & procedures', count: routines.length, depth: base, groupKey })
        if (!expanded.has(`${groupKey}:collapsed`) || q) {
          for (const r of routines) {
            out.push({ kind: 'routine', key: `r:${s}.${r.name}.${r.arguments ?? ''}`, name: r.name, schema: r.schema, routineKind: r.kind, depth: base + 1 })
          }
        }
      }
    }
    if (hiddenCount) out.push({ kind: 'hidden', key: 'hidden', count: hiddenCount, depth: 0 })
    return out
  }, [schema, filter, expanded, collapsedSchemas, connection.pinnedTables, connection.hiddenSchemas])

  const virtualizer = useVirtualizer({
    count: nodes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 20,
  })

  const openTable = (t: TableInfo) =>
    openTab({ kind: 'table', connectionId: connection.id, table: { schema: t.schema, name: t.name }, title: t.name })

  const tableMenu = (e: React.MouseEvent, t: TableInfo) => {
    const d = getDialect(connection.driver)
    openMenu(e, [
      { label: tr('Open data'), icon: <Table2 size={13} />, onClick: () => openTable(t) },
      { label: tr('Open structure'), icon: <Layers size={13} />, onClick: () => openTab({ kind: 'structure', connectionId: connection.id, table: { schema: t.schema, name: t.name }, title: tr('{name} · structure', { name: t.name }) }) },
      { label: tr('Show in diagram'), icon: <Network size={13} />, onClick: () => openTab({ kind: 'diagram', connectionId: connection.id, title: tr('Diagram: {name}', { name: t.name }), focus: t.name }) },
      {
        label: tr('Compare data with…'),
        icon: <Rows3 size={13} />,
        onClick: () =>
          openTab(
            { kind: 'datacompare', connectionId: connection.id, sourceId: connection.id, sourceTable: { schema: t.schema, name: t.name }, title: tr('Data: {name}', { name: t.name }) },
            { reuse: false },
          ),
      },
      connection.pinnedTables?.includes(pinKey(t))
        ? { label: tr('Unpin'), icon: <PinOff size={13} />, onClick: () => togglePin(connection.id, pinKey(t)) }
        : { label: tr('Pin to top'), icon: <Pin size={13} />, onClick: () => togglePin(connection.id, pinKey(t)) },
      {
        label: tr('Explain with AI'),
        icon: <Sparkles size={13} />,
        onClick: () => askAi({ prompt: tr(EXPLAIN_TABLE_PROMPT, { table: t.schema ? `${t.schema}.${t.name}` : t.name }), send: true }),
      },
      'separator',
      { label: tr('New query: SELECT'), icon: <TerminalSquare size={13} />, onClick: () => newQuery(connection.id, generateSql('select', t, connection), t.name) },
      {
        label: tr('Generate SQL'),
        icon: <FileCode2 size={13} />,
        submenu: (['select', 'insert', 'update', 'delete', 'count'] as const).map((k) => ({
          label: k.toUpperCase(),
          onClick: () => newQuery(connection.id, generateSql(k, t, connection), `${k.toUpperCase()} ${t.name}`),
        })),
      },
      'separator',
      { label: tr('Copy name'), icon: <Copy size={13} />, onClick: () => void copyText(t.name) },
      { label: tr('Copy qualified name'), onClick: () => void copyText(qualify(d, { schema: t.schema, name: t.name })) },
      { label: tr('Copy column list'), onClick: () => void copyText(t.columns.map((c) => d.quoteIdent(c.name)).join(', ')) },
    ])
  }

  if (!schema) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-[12px] text-fg-faint">
        {runtime?.schemaError ? (
          <>
            <span className="text-danger">{runtime.schemaError}</span>
            <button type="button" className="text-accent hover:underline" onClick={() => void loadSchema(connection.id, true)}>
              {tr('Retry')}
            </button>
          </>
        ) : (
          <>
            <Spinner size={16} />
            {tr('Loading schema…')}
          </>
        )}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-2 pt-1 pb-1.5">
        <Input
          inputSize="sm"
          className="flex-1"
          placeholder={tr('Filter {n} tables…', { n: formatCount(schema.tables.length) })}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setFilter('')
            if (e.key === 'Enter') {
              const first = nodes.find((n) => n.kind === 'table')
              if (first?.kind === 'table') openTable(first.table)
            }
          }}
          leading={<Search size={12} />}
          data-sidebar-filter
        />
        <IconButton label={`${tr('Refresh schema')} (F5)`} onClick={() => void loadSchema(connection.id, true)}>
          <RefreshCw size={13} className={runtime?.schemaLoading ? 'animate-spin' : ''} />
        </IconButton>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto pb-2">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const node = nodes[vi.index]!
            const pad = 8 + node.depth * 12
            const style = { top: vi.start, height: ROW, paddingLeft: pad }
            const rowClass = 'absolute inset-x-1 flex items-center gap-1.5 rounded-md pr-2 text-[12.5px] hover:bg-hover'
            if (node.kind === 'schema') {
              const collapsed = collapsedSchemas.has(node.key) && !filter
              return (
                <div
                  key={node.key}
                  className={cn(rowClass, 'font-medium')}
                  style={style}
                  onContextMenu={(e) =>
                    openMenu(e, [
                      { label: tr('Hide schema'), icon: <EyeOff size={13} />, onClick: () => setHiddenSchemas(connection.id, [...(connection.hiddenSchemas ?? []), node.name]) },
                      'separator',
                      { label: tr('Data dictionary (HTML)…'), icon: <FileText size={13} />, onClick: () => void exportDataDictionary(connection.id, 'html', [node.name]) },
                      { label: tr('Data dictionary (Markdown)…'), icon: <FileText size={13} />, onClick: () => void exportDataDictionary(connection.id, 'markdown', [node.name]) },
                    ])
                  }
                  onClick={() =>
                    setCollapsedSchemas((prev) => {
                      const next = new Set(prev)
                      if (next.has(node.key)) next.delete(node.key)
                      else next.add(node.key)
                      return next
                    })
                  }
                >
                  <ChevronRight size={12} className={cn('shrink-0 text-fg-faint transition-transform', !collapsed && 'rotate-90')} />
                  <Layers size={13} className="shrink-0 text-fg-muted" />
                  <span className="truncate">{node.name}</span>
                  <span className="ml-auto text-[11px] text-fg-faint">{node.count || ''}</span>
                </div>
              )
            }
            if (node.kind === 'hidden') {
              return (
                <div key={node.key} className={cn(rowClass, 'text-[11.5px] text-fg-faint')} style={style} onClick={() => setHiddenSchemas(connection.id, [])}>
                  <EyeOff size={12} className="shrink-0" />
                  <span className="truncate">{tp(node.count, { one: '{n} hidden schema', many: '{n} hidden schemas' })}</span>
                  <span className="ml-auto text-accent">{tr('Show')}</span>
                </div>
              )
            }
            if (node.kind === 'group') {
              const collapsed = expanded.has(`${node.groupKey}:collapsed`) && !filter
              return (
                <div key={node.key} className={cn(rowClass, 'text-[11px] font-semibold tracking-wide text-fg-faint uppercase')} style={style} onClick={() => toggle(`${node.groupKey}:collapsed`)}>
                  <ChevronRight size={11} className={cn('shrink-0 transition-transform', !collapsed && 'rotate-90')} />
                  <span>{tr(node.label)}</span>
                  <span className="ml-auto font-normal">{node.count}</span>
                </div>
              )
            }
            if (node.kind === 'table') {
              const t = node.table
              const open = expanded.has(node.key)
              return (
                <div
                  key={node.key}
                  className={rowClass}
                  style={style}
                  title={[t.schema ? `${t.schema}.${t.name}` : t.name, t.comment, t.rowEstimate != null && t.rowEstimate >= 0 ? tr('≈ {n} rows', { n: formatCount(t.rowEstimate) }) : null].filter(Boolean).join('\n')}
                  onClick={() => openTable(t)}
                  onContextMenu={(e) => tableMenu(e, t)}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', qualify(getDialect(connection.driver), { schema: t.schema, name: t.name }))}
                >
                  <button
                    type="button"
                    className="-ml-1 flex h-5 w-4 shrink-0 items-center justify-center text-fg-faint hover:text-fg"
                    onClick={(e) => {
                      e.stopPropagation()
                      toggle(node.key)
                    }}
                    aria-label={open ? tr('Collapse') : tr('Expand')}
                  >
                    <ChevronRight size={12} className={cn('transition-transform', open && 'rotate-90')} />
                  </button>
                  {t.type === 'table' ? <Table2 size={13} className="shrink-0 text-accent" /> : <Eye size={13} className="shrink-0 text-info" />}
                  <span className="truncate">{t.name}</span>
                  {t.rowEstimate != null && t.rowEstimate > 0 && (
                    <span className="ml-auto shrink-0 pl-1 text-[10.5px] text-fg-faint tabular-nums">{compact(t.rowEstimate)}</span>
                  )}
                </div>
              )
            }
            if (node.kind === 'column') {
              const c = node.column
              const fk = node.table.foreignKeys.find((f) => f.columns.includes(c.name))
              return (
                <div
                  key={node.key}
                  className={cn(rowClass, 'text-fg-muted')}
                  style={style}
                  title={[`${c.name} ${c.dataType}${c.nullable ? '' : ' NOT NULL'}`, c.defaultValue ? `${tr('default')} ${c.defaultValue}` : null, fk ? `→ ${fk.refTable}.${fk.refColumns.join(', ')}` : null, c.comment].filter(Boolean).join('\n')}
                  onDoubleClick={() => void copyText(c.name)}
                  onContextMenu={(e) =>
                    openMenu(e, [
                      { label: tr('Copy name'), icon: <Copy size={13} />, onClick: () => void copyText(c.name) },
                      ...(fk
                        ? [{ label: tr('Open {table}', { table: fk.refTable }), icon: <Link2 size={13} />, onClick: () => openTab({ kind: 'table', connectionId: connection.id, table: { schema: fk.refSchema, name: fk.refTable }, title: fk.refTable }) }]
                        : []),
                    ])
                  }
                >
                  {c.isPrimaryKey ? (
                    <KeyRound size={11} className="shrink-0 text-warning" />
                  ) : fk ? (
                    <Link2 size={11} className="shrink-0 text-info" />
                  ) : (
                    <Hash size={11} className="shrink-0 text-fg-faint" />
                  )}
                  <span className={cn('truncate', c.isPrimaryKey && 'text-fg')}>{c.name}</span>
                  <span className="ml-auto shrink-0 truncate pl-2 font-mono text-[10.5px] text-fg-faint">{c.dataType}</span>
                </div>
              )
            }
            return (
              <div key={node.key} className={cn(rowClass, 'text-fg-muted')} style={style} title={`${node.routineKind} ${node.name}`}>
                <Code2 size={12} className="shrink-0 text-fg-faint" />
                <span className="truncate">{node.name}</span>
              </div>
            )
          })}
        </div>
        {nodes.length === 0 && <div className="p-4 text-center text-[12px] text-fg-faint">{filter ? tr('No matches') : tr('No tables')}</div>}
      </div>
    </div>
  )
}

function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
  return `${(n / 1_000_000_000).toFixed(1)}B`
}

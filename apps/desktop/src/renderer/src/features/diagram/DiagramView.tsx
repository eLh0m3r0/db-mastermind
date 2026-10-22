import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import ELK from 'elkjs/lib/elk.bundled.js'
import { toPng, toSvg } from 'html-to-image'
import { Bookmark, Copy, Download, Eye, FileCode2, KeyRound, LayoutGrid, Link2, Network, PencilRuler, Plus, Route, Search, Table2, Undo2 } from 'lucide-react'
import {
  designId,
  designToTableInfo,
  diffTable,
  diffTables,
  findJoinPath,
  findTable,
  getDialect,
  incomingReferences,
  joinPathSql,
  toDesignTable,
  type DesignTable,
  type SchemaSnapshot,
  type TableInfo,
} from '@dbmastermind/core/browser'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { api } from '@/lib/api'
import { openMenu } from '@/components/ui/ContextMenu'
import { EmptyState } from '@/components/ui/EmptyState'
import { Checkbox, Input, Select } from '@/components/ui/Input'
import { Spinner } from '@/components/ui/Spinner'
import { cn, copyText, errorMessage, fuzzyScore } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { useSettings } from '@/store/settings'
import { toast } from '@/store/ui'
import { useWorkspace, type DiagramTab } from '@/store/workspace'
import type { SavedDiagram } from '@shared/api'
import { MigrationModal } from './MigrationModal'
import { TableEditor } from './TableEditor'
import { t, tp, useT } from '@/lib/i18n'

const elk = new ELK()
const HEADER = 32
const ROW = 22
const WIDTH = 240

type DesignStatus = 'live' | 'modified' | 'new' | 'dropped'

interface TableNodeData extends Record<string, unknown> {
  table: TableInfo
  status: DesignStatus
  design: boolean
  keysOnly: boolean
  highlighted: boolean
  dimmed: boolean
  focus: boolean
  fkColumns: Set<string>
  referencedColumns: Set<string>
}

function visibleColumns(t: TableInfo, keysOnly: boolean, fkColumns: Set<string>, referenced: Set<string>) {
  return keysOnly ? t.columns.filter((c) => c.isPrimaryKey || fkColumns.has(c.name) || referenced.has(c.name)) : t.columns
}

const TableNode = memo(function TableNode({ data }: NodeProps<Node<TableNodeData>>) {
  const { table, keysOnly, fkColumns, referencedColumns } = data
  const cols = visibleColumns(table, keysOnly, fkColumns, referencedColumns)
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-elevated shadow-sm transition-opacity',
        data.focus ? 'border-accent ring-2 ring-accent-soft' : data.highlighted ? 'border-accent/70' : 'border-line-strong',
        data.status === 'new' && 'border-success ring-2 ring-success-soft',
        data.status === 'modified' && 'border-warning ring-2 ring-warning-soft',
        data.status === 'dropped' && 'border-dashed border-danger opacity-60',
        data.dimmed && 'opacity-35',
        data.design && 'cursor-pointer',
      )}
      style={{ width: WIDTH }}
    >
      <div
        className={cn('flex items-center gap-1.5 px-2.5 text-[12px] font-semibold', table.type === 'table' ? 'bg-accent text-accent-fg' : 'bg-info text-white')}
        style={{ height: HEADER }}
        title={table.comment ?? undefined}
      >
        {table.type === 'table' ? <Table2 size={12} /> : <Eye size={12} />}
        <span className="truncate">{table.name}</span>
        {data.status !== 'live' ? (
          <span className="ml-auto rounded bg-white/25 px-1 text-[9.5px] font-bold uppercase">{t(data.status)}</span>
        ) : (
          table.schema && <span className="ml-auto truncate text-[10px] font-normal opacity-75">{table.schema}</span>
        )}
      </div>
      {cols.map((c) => (
        <div key={c.name} className="relative flex items-center gap-1.5 border-t border-line px-2.5 text-[11px]" style={{ height: ROW }} title={c.comment ?? undefined}>
          <Handle type="target" position={Position.Left} id={`t-${c.name}`} className={cn('!h-1.5 !w-1.5 !min-w-0 !border-0', data.design ? '!bg-accent/50' : '!bg-transparent')} />
          {c.isPrimaryKey ? (
            <KeyRound size={10} className="shrink-0 text-warning" />
          ) : fkColumns.has(c.name) ? (
            <Link2 size={10} className="shrink-0 text-info" />
          ) : (
            <span className="w-[10px] shrink-0" />
          )}
          <span className={cn('truncate', c.isPrimaryKey && 'font-semibold')}>{c.name}</span>
          <span className="ml-auto max-w-[45%] shrink-0 truncate font-mono text-[10px] text-fg-faint">{c.dataType}</span>
          {!c.nullable && !c.isPrimaryKey && <span className="text-[9px] text-fg-faint">NN</span>}
          <Handle type="source" position={Position.Right} id={`s-${c.name}`} className={cn('!h-1.5 !w-1.5 !min-w-0 !border-0', data.design ? '!h-2.5 !w-2.5 !bg-accent' : '!bg-transparent')} />
        </div>
      ))}
      {keysOnly && cols.length < table.columns.length && (
        <div className="border-t border-line px-2.5 text-[10.5px] text-fg-faint" style={{ height: ROW, lineHeight: `${ROW}px` }}>
          + {table.columns.length - cols.length} more columns
        </div>
      )}
    </div>
  )
})

const nodeTypes = { table: TableNode }

/** Tables within `depth` foreign-key hops of `focus`. */
function neighbourhood(snapshot: SchemaSnapshot, focus: TableInfo, depth: number): Set<string> {
  const key = (t: TableInfo) => `${t.schema ?? ''}.${t.name}`
  const seen = new Set([key(focus)])
  let frontier = [focus]
  for (let d = 0; d < depth; d++) {
    const next: TableInfo[] = []
    for (const t of frontier) {
      const neighbours = [
        ...t.foreignKeys.map((fk) => findTable(snapshot, { schema: fk.refSchema ?? t.schema, name: fk.refTable })),
        ...incomingReferences(snapshot, t).map((r) => r.table),
      ]
      for (const n of neighbours) {
        if (n && !seen.has(key(n))) {
          seen.add(key(n))
          next.push(n)
        }
      }
    }
    frontier = next
  }
  return seen
}

function nodeHeight(t: TableInfo, keysOnly: boolean, fk: Set<string>, ref: Set<string>): number {
  const visible = visibleColumns(t, keysOnly, fk, ref).length
  return HEADER + visible * ROW + (keysOnly && visible < t.columns.length ? ROW : 0) + 2
}

function DiagramInner({ tab }: { tab: DiagramTab }) {
  const tr = useT()
  const runtime = useConnections((s) => s.runtime[tab.connectionId])
  const loadSchema = useConnections((s) => s.loadSchema)
  const openTab = useWorkspace((s) => s.open)
  const updateTab = useWorkspace((s) => s.update)
  const dark = useSettings((s) => s.dark)
  const schema = runtime?.schema
  const flow = useReactFlow()
  const wrapper = useRef<HTMLDivElement>(null)

  const [schemaFilter, setSchemaFilter] = useState<string>('')
  const [focusName, setFocusName] = useState<string | undefined>(tab.focus)
  const [depth, setDepth] = useState(1)
  /** Second table: show only the join path from the focused table to it. */
  const [pathTo, setPathTo] = useState<string>()
  const [keysOnly, setKeysOnly] = useState(false)
  const [search, setSearch] = useState('')
  const [hovered, setHovered] = useState<string | null>(null)
  const [layouting, setLayouting] = useState(false)
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TableNodeData>>([])
  const connection = useConnections((s) => s.list.find((c) => c.id === tab.connectionId))
  const newQuery = useWorkspace((s) => s.newQuery)
  const [design, setDesign] = useState(!!tab.startDesign || (!!tab.design && Object.keys(tab.design).length > 0))
  const [selected, setSelected] = useState<string | null>(tab.startDesign ?? null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const drafts = useMemo(() => tab.design ?? {}, [tab.design])
  const setDrafts = (next: Record<string, DesignTable>) => updateTab(tab.id, { design: next })

  useEffect(() => {
    if (!schema) void loadSchema(tab.connectionId)
  }, [schema, loadSchema, tab.connectionId])

  useEffect(() => {
    if (!schema || schemaFilter) return
    // Prefer the default schema, unless it's empty and another one has the tables.
    const count = (s: string) => schema.tables.filter((t) => (t.schema ?? '') === s).length
    const preferred = schema.defaultSchema && count(schema.defaultSchema) > 0 ? schema.defaultSchema : [...schema.schemas].sort((a, b) => count(b) - count(a))[0]
    setSchemaFilter(preferred ?? '*')
  }, [schema, schemaFilter])

  const joinPath = useMemo(
    () => (schema && focusName && pathTo ? findJoinPath(schema, { name: focusName }, { name: pathTo }) : undefined),
    [schema, focusName, pathTo],
  )

  const liveTables = useMemo(() => {
    if (!schema) return []
    if (joinPath?.length) return [joinPath[0]!.from, ...joinPath.map((s) => s.to)]
    if (focusName) {
      const focus = findTable(schema, { name: focusName })
      if (focus) {
        const keys = neighbourhood(schema, focus, depth)
        return schema.tables.filter((t) => keys.has(`${t.schema ?? ''}.${t.name}`))
      }
    }
    if (tab.tables) {
      const keys = new Set(tab.tables)
      return schema.tables.filter((t) => keys.has(`${t.schema ?? ''}.${t.name}`))
    }
    const all = schemaFilter === '*' ? schema.tables : schema.tables.filter((t) => (t.schema ?? '') === schemaFilter || (!t.schema && !schemaFilter))
    return all.slice(0, 400)
  }, [schema, focusName, depth, schemaFilter, joinPath, tab.tables])

  const keyOf = (t: { schema?: string; name: string }) => `${t.schema ?? ''}.${t.name}`
  /** What the canvas shows: live tables with drafts applied, plus new tables. */
  const display = useMemo(() => {
    const out: { key: string; info: TableInfo; status: DesignStatus }[] = liveTables.map((t) => {
      const draft = drafts[keyOf(t)]
      if (!draft) return { key: keyOf(t), info: t, status: 'live' }
      const changed = diffTable(t, draft).length > 0
      return { key: keyOf(t), info: designToTableInfo(draft), status: draft.dropped ? 'dropped' : changed ? 'modified' : 'live' }
    })
    for (const [key, draft] of Object.entries(drafts)) {
      if (!draft.originalName && !draft.dropped) out.push({ key, info: designToTableInfo(draft), status: 'new' })
    }
    return out
  }, [liveTables, drafts])
  const tables = useMemo(() => display.map((d) => d.info), [display])
  const keyByName = useMemo(() => new Map(display.map((d) => [d.info.name, d.key])), [display])

  // After the schema changes (e.g. the migration ran), drop drafts that are now applied and flag stale ones.
  const staleDesign = useMemo(() => {
    if (!schema) return false
    return Object.values(drafts).some((d) => {
      if (!d.originalName) return false
      const live = schema.tables.find((t) => t.name === d.originalName && (t.schema ?? '') === (d.schema ?? ''))
      return !live || d.columns.some((c) => c.originalName && !live.columns.some((x) => x.name === c.originalName))
    })
  }, [schema, drafts])
  useEffect(() => {
    if (!schema || !Object.keys(drafts).length || staleDesign) return
    const next = Object.fromEntries(
      Object.entries(drafts).filter(([, d]) => {
        if (!d.originalName) return !schema.tables.some((t) => t.name === d.name && (t.schema ?? '') === (d.schema ?? ''))
        const live = schema.tables.find((t) => t.name === d.originalName && (t.schema ?? '') === (d.schema ?? ''))
        return live ? diffTable(live, d).length > 0 : true
      }),
    )
    if (Object.keys(next).length !== Object.keys(drafts).length) setDrafts(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema?.capturedAt])

  const changes = useMemo(() => {
    if (!schema || !Object.keys(drafts).length) return []
    return diffTables(schema.tables, Object.values(drafts))
  }, [schema, drafts])

  const columnSets = useMemo(() => {
    const fk = new Map<string, Set<string>>()
    const ref = new Map<string, Set<string>>()
    for (const t of tables) {
      fk.set(t.name, new Set(t.foreignKeys.flatMap((f) => f.columns)))
      for (const f of t.foreignKeys) {
        const s = ref.get(f.refTable) ?? new Set<string>()
        f.refColumns.forEach((c) => s.add(c))
        ref.set(f.refTable, s)
      }
    }
    return { fk, ref }
  }, [tables])

  const edges = useMemo<Edge[]>(() => {
    const names = new Set(tables.map((t) => t.name))
    const out: Edge[] = []
    for (const t of tables) {
      for (const fk of t.foreignKeys) {
        if (!names.has(fk.refTable)) continue
        const source = keyByName.get(t.name)!
        const targetKey = keyByName.get(fk.refTable)
        if (!targetKey) continue
        const active = hovered === source || hovered === targetKey
        const optional = fk.columns.some((c) => t.columns.find((x) => x.name === c)?.nullable)
        out.push({
          id: `${source}:${fk.name}`,
          source,
          target: targetKey,
          sourceHandle: `s-${fk.columns[0]}`,
          targetHandle: `t-${fk.refColumns[0]}`,
          type: 'smoothstep',
          animated: active,
          markerStart: 'crow-many',
          markerEnd: optional ? 'crow-zero-one' : 'crow-one',
          style: {
            stroke: active ? 'var(--accent)' : fk.virtual ? 'var(--warning)' : 'var(--text-faint)',
            strokeWidth: active ? 2 : 1.3,
            strokeDasharray: fk.virtual ? '5 4' : undefined,
          },
          label: active ? fk.columns.join(', ') : undefined,
          labelStyle: { fontSize: 10, fill: 'var(--text-muted)' },
          labelBgStyle: { fill: 'var(--bg-elevated)' },
        })
      }
    }
    return out
  }, [tables, hovered, keyByName])

  const latest = useRef({ display, columnSets, edges })
  latest.current = { display, columnSets, edges }
  const nodeData = (d: (typeof display)[number]): TableNodeData => ({
    table: d.info,
    status: d.status,
    design,
    keysOnly,
    highlighted: false,
    dimmed: false,
    focus: d.info.name === focusName,
    fkColumns: columnSets.fk.get(d.info.name) ?? new Set(),
    referencedColumns: columnSets.ref.get(d.info.name) ?? new Set(),
  })
  // Re-layout only when the set of tables changes, not on every edit.
  const structure = `${liveTables.map(keyOf).join('|')}#${keysOnly}`

  const layout = useCallback(async () => {
    const { display, columnSets, edges } = latest.current
    const tables = display.map((d) => d.info)
    if (!tables.length) {
      setNodes([])
      return
    }
    setLayouting(true)
    try {
      const graph = await elk.layout({
        id: 'root',
        layoutOptions: {
          'elk.algorithm': 'layered',
          'elk.direction': 'RIGHT',
          'elk.layered.spacing.nodeNodeBetweenLayers': '90',
          'elk.spacing.nodeNode': '36',
          'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
          'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
          'elk.separateConnectedComponents': 'true',
          'elk.spacing.componentComponent': '70',
        },
        children: display.map(({ key, info: t }) => ({
          id: key,
          width: WIDTH,
          height: nodeHeight(t, keysOnly, columnSets.fk.get(t.name) ?? new Set(), columnSets.ref.get(t.name) ?? new Set()),
        })),
        edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
      })
      const saved = tab.positions ?? {}
      const placed = display.map((d) => saved[d.key]).filter((p): p is { x: number; y: number } => !!p)
      // Tables new to an arranged diagram go in a column right of the existing ones instead of on top of them.
      let nextX = placed.length ? Math.max(...placed.map((p) => p.x)) + WIDTH + 90 : 0
      let nextY = placed.length ? Math.min(...placed.map((p) => p.y)) : 0
      const positions: Record<string, { x: number; y: number }> = {}
      for (const d of display) {
        const laid = graph.children?.find((c) => c.id === d.key)
        let position = saved[d.key] ?? drafts[d.key]?.position
        if (!position && placed.length) {
          position = { x: nextX, y: nextY }
          nextY += (laid?.height ?? 200) + 36
          if (nextY > 2400) {
            nextX += WIDTH + 90
            nextY = Math.min(...placed.map((p) => p.y))
          }
        }
        positions[d.key] = position ?? { x: Math.round(laid?.x ?? 0), y: Math.round(laid?.y ?? 0) }
      }
      setNodes(display.map((d) => ({ id: d.key, type: 'table', position: positions[d.key]!, data: nodeData(d) })))
      requestAnimationFrame(() => flow.fitView({ padding: 0.15, duration: 300, maxZoom: 1 }))
      // In a custom diagram, pin the layout so adding a table doesn't rearrange the others.
      if (tab.tables && display.some((d) => !saved[d.key])) updateTab(tab.id, { positions: { ...saved, ...positions } })
    } finally {
      setLayouting(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure, focusName])

  useEffect(() => {
    void layout()
  }, [layout])

  // Edits update node contents in place; new tables appear without moving the others.
  useEffect(() => {
    setNodes((ns) => {
      const byId = new Map(ns.map((n) => [n.id, n]))
      const center = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
      return display.map((d, i) => {
        const existing = byId.get(d.key)
        return existing
          ? { ...existing, data: { ...nodeData(d), highlighted: existing.data.highlighted, dimmed: existing.data.dimmed } }
          : { id: d.key, type: 'table', position: drafts[d.key]?.position ?? { x: center.x + i * 8, y: center.y + i * 8 }, data: nodeData(d) }
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display, columnSets, design])

  // Hover highlighting without re-running layout.
  useEffect(() => {
    if (!hovered) {
      setNodes((ns) => ns.map((n) => (n.data.highlighted || n.data.dimmed ? { ...n, data: { ...n.data, highlighted: false, dimmed: false } } : n)))
      return
    }
    const related = new Set([hovered])
    for (const e of edges) {
      if (e.source === hovered) related.add(e.target)
      if (e.target === hovered) related.add(e.source)
    }
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, highlighted: related.has(n.id) && n.id !== hovered, dimmed: !related.has(n.id) } })))
  }, [hovered, edges, setNodes])

  const resetLayout = () => {
    updateTab(tab.id, { positions: undefined })
    tab.positions = undefined
    void layout()
  }

  const exportImage = async (format: 'png' | 'svg') => {
    const el = wrapper.current?.querySelector<HTMLElement>('.react-flow__viewport')
    if (!el) return
    try {
      flow.fitView({ padding: 0.05 })
      await new Promise((r) => setTimeout(r, 350))
      const options = { backgroundColor: dark ? '#16181d' : '#ffffff', pixelRatio: 2, filter: (node: HTMLElement) => !node.classList?.contains('react-flow__minimap') }
      const url = format === 'png' ? await toPng(wrapper.current!.querySelector('.react-flow') as HTMLElement, options) : await toSvg(wrapper.current!.querySelector('.react-flow') as HTMLElement, options)
      const a = document.createElement('a')
      a.href = url
      a.download = `${tab.title.replace(/[^\w.-]+/g, '_')}.${format}`
      a.click()
    } catch (err) {
      toast({ kind: 'error', message: tr('Export failed'), detail: errorMessage(err) })
    }
  }

  const exportMermaid = () => {
    const lines = ['erDiagram']
    for (const t of tables) {
      lines.push(`  ${t.name} {`)
      for (const c of t.columns) lines.push(`    ${c.dataType.replace(/[^\w]/g, '_')} ${c.name}${c.isPrimaryKey ? ' PK' : t.foreignKeys.some((f) => f.columns.includes(c.name)) ? ' FK' : ''}`)
      lines.push('  }')
    }
    for (const t of tables) for (const fk of t.foreignKeys) lines.push(`  ${fk.refTable} ||--o{ ${t.name} : "${fk.columns.join(', ')}"`)
    void navigator.clipboard.writeText(lines.join('\n'))
    toast({ kind: 'success', message: tr('Mermaid diagram copied to clipboard') })
  }

  const exportDbml = () => {
    const out: string[] = []
    for (const t of tables) {
      out.push(`Table ${t.schema && t.schema !== schema?.defaultSchema ? `${t.schema}.` : ''}${t.name} {`)
      for (const c of t.columns) {
        const attrs = [c.isPrimaryKey ? 'pk' : '', c.isIdentity ? 'increment' : '', c.nullable ? '' : 'not null', c.comment ? `note: '${c.comment.replaceAll("'", "\\'")}'` : ''].filter(Boolean)
        out.push(`  ${c.name} ${c.dataType.replace(/\s+/g, '_')}${attrs.length ? ` [${attrs.join(', ')}]` : ''}`)
      }
      if (t.comment) out.push(`  Note: '${t.comment.replaceAll("'", "\\'")}'`)
      out.push('}', '')
    }
    for (const t of tables) for (const fk of t.foreignKeys) fk.columns.forEach((c, i) => out.push(`Ref: ${t.name}.${c} > ${fk.refTable}.${fk.refColumns[i]}`))
    void navigator.clipboard.writeText(out.join('\n'))
    toast({ kind: 'success', message: tr('DBML copied to clipboard'), detail: tr('Paste it into dbdiagram.io or a .dbml file.') })
  }

  /** Draft for a node, creating one from the live table on first edit. */
  const draftFor = (key: string): DesignTable | undefined => {
    if (drafts[key]) return drafts[key]
    const live = liveTables.find((t) => keyOf(t) === key)
    return live ? toDesignTable(live) : undefined
  }
  const updateDraft = (key: string, table: DesignTable) => setDrafts({ ...drafts, [key]: table })
  const addTable = () => {
    const key = designId('new')
    const pkType = connection?.driver === 'sqlite' ? 'INTEGER' : connection?.driver === 'postgres' ? 'bigint' : 'bigint'
    // Place new tables to the right of the diagram so they never cover existing ones.
    const right = nodes.reduce((m, n) => Math.max(m, n.position.x + WIDTH), 0)
    const top = nodes.reduce((m, n) => Math.min(m, n.position.y), Number.POSITIVE_INFINITY)
    const center = { x: right + 80, y: Number.isFinite(top) ? top : 0 }
    updateDraft(key, {
      id: key,
      schema: schemaFilter && schemaFilter !== '*' ? schemaFilter : schema?.defaultSchema,
      name: `new_table_${Object.values(drafts).filter((d) => !d.originalName).length + 1}`,
      columns: [{ id: designId('c'), name: 'id', dataType: pkType, nullable: false, identity: true }],
      primaryKey: ['id'],
      foreignKeys: [],
      indexes: [],
      position: center,
    })
    setSelected(key)
  }
  const onConnect = (c: { source: string | null; target: string | null; sourceHandle?: string | null; targetHandle?: string | null }) => {
    if (!design || !c.source || !c.target) return
    const from = draftFor(c.source)
    const to = display.find((d) => d.key === c.target)?.info
    if (!from || !to) return
    const column = c.sourceHandle?.replace(/^s-/, '') ?? ''
    const refColumn = c.targetHandle?.replace(/^t-/, '') ?? to.primaryKey[0] ?? ''
    updateDraft(c.source, {
      ...from,
      foreignKeys: [...from.foreignKeys, { id: designId('f'), columns: [column], refSchema: to.schema, refTable: to.name, refColumns: [refColumn] }],
    })
    toast({ kind: 'info', message: tr('Foreign key {from} → {to} added to the design', { from: `${from.name}.${column}`, to: `${to.name}.${refColumn}` }) })
  }
  const selectedDraft = selected ? draftFor(selected) : undefined

  const [naming, setNaming] = useState(false)

  /** Search result: adds the table to a custom diagram, otherwise focuses on it. */
  const pickTable = (t: TableInfo) => {
    if (tab.tables && !focusName) {
      if (!tab.tables.includes(keyOf(t))) updateTab(tab.id, { tables: [...tab.tables, keyOf(t)] })
    } else setFocusName(t.name)
    setSearch('')
  }

  const addRelated = (t: TableInfo) => {
    if (!schema || !tab.tables) return
    const keys = neighbourhood(schema, t, 1)
    updateTab(tab.id, { tables: [...new Set([...tab.tables, ...keys])] })
  }

  const currentPositions = () => Object.fromEntries(nodes.map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }]))

  const saveAs = async (name: string) => {
    const tables = liveTables.map(keyOf)
    const d = await api.saveDiagram({ connectionId: tab.connectionId, name, tables, positions: currentPositions() })
    setFocusName(undefined)
    setPathTo(undefined)
    updateTab(tab.id, { savedId: d.id, tables, positions: d.positions, title: name })
    setNaming(false)
    toast({ kind: 'success', message: tr('Diagram saved') })
  }

  // Saved diagrams keep themselves up to date: tables added/removed and nodes moved.
  useEffect(() => {
    if (!tab.savedId || !tab.tables || focusName) return
    const timer = setTimeout(() => {
      void api.saveDiagram({ id: tab.savedId, connectionId: tab.connectionId, name: tab.title, tables: tab.tables!, positions: { ...currentPositions(), ...tab.positions } })
    }, 600)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.savedId, tab.tables, tab.positions])

  const matches = useMemo(() => {
    const q = search.trim()
    if (!q || !schema) return []
    return schema.tables
      .map((t) => ({ t, s: fuzzyScore(t.name, q) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 8)
      .map((x) => x.t)
  }, [search, schema])

  if (!schema) {
    return (
      <div className="flex h-full items-center justify-center text-fg-faint">
        <Spinner size={18} />
      </div>
    )
  }
  if (schema.tables.length === 0) return <EmptyState icon={<Network size={26} />} title={tr('No tables to show')} />

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 overflow-x-auto border-b border-line px-2 whitespace-nowrap [scrollbar-width:none]">
        <div className="relative shrink-0">
          <Input
            inputSize="sm"
            className="w-56"
            placeholder={tab.tables && !focusName ? tr('Add table…') : tr('Focus on table…')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            leading={<Search size={12} />}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches[0]) {
                pickTable(matches[0])
                setSearch('')
              }
            }}
          />
          {matches.length > 0 && (
            <div className="absolute top-8 left-0 z-20 w-64 rounded-md border border-line bg-elevated p-1 shadow-pop">
              {matches.map((t) => (
                <button
                  key={`${t.schema}.${t.name}`}
                  type="button"
                  className="flex h-7 w-full items-center gap-2 rounded px-2 text-left text-[12px] hover:bg-hover"
                  onClick={() => {
                    pickTable(t)
                    setSearch('')
                  }}
                >
                  <Table2 size={12} className="text-accent" /> {t.name}
                </button>
              ))}
            </div>
          )}
        </div>
        {focusName ? (
          <>
            <span className="flex items-center gap-1 rounded-md bg-accent-soft px-2 py-0.5 text-[12px] text-accent">
              {focusName}
              <button
                type="button"
                className="ml-1 hover:text-fg"
                onClick={() => {
                  setFocusName(undefined)
                  setPathTo(undefined)
                }}
                aria-label={tr('Show whole schema')}
              >
                ×
              </button>
            </span>
            {!pathTo && (
              <Select inputSize="sm" className="h-7 w-28" value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
                {[1, 2, 3, 4].map((d) => (
                  <option key={d} value={d}>
                    {tp(d, { one: '{n} hop', many: '{n} hops' })}
                  </option>
                ))}
              </Select>
            )}
            <Input
              inputSize="sm"
              className="w-44"
              list="diagram-path-tables"
              placeholder={tr('Join path to…')}
              leading={<Route size={12} />}
              value={pathTo ?? ''}
              onChange={(e) => setPathTo(schema.tables.some((t) => t.name === e.target.value) ? e.target.value : e.target.value || undefined)}
            />
            <datalist id="diagram-path-tables">
              {schema.tables
                .filter((t) => t.name !== focusName)
                .map((t) => (
                  <option key={`${t.schema}.${t.name}`} value={t.name} />
                ))}
            </datalist>
          </>
        ) : (
          schema.schemas.length > 1 && (
            <Select inputSize="sm" className="h-7 w-40" value={schemaFilter} onChange={(e) => setSchemaFilter(e.target.value)}>
              {schema.schemas.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
              <option value="*">{tr('All schemas')}</option>
            </Select>
          )
        )}
        <Checkbox checked={keysOnly} onChange={setKeysOnly} label={tr('Keys only')} />
        {!design && (
          <span className="shrink-0 text-[11.5px] text-fg-faint">
            {tp(tables.length, { one: '{n} table', many: '{n} tables' })} · {tp(edges.length, { one: '{n} relationship', many: '{n} relationships' })}
          </span>
        )}
        <div className="flex-1" />
        {layouting && <Spinner size={13} className="text-fg-faint" />}
        {design && (
          <>
            <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={addTable}>
              {tr('New table')}
            </Button>
            {Object.keys(drafts).length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                icon={<Undo2 size={13} />}
                onClick={() => {
                  if (window.confirm(tr('Discard all design changes?'))) {
                    setDrafts({})
                    setSelected(null)
                  }
                }}
              >
                {tr('Discard')}
              </Button>
            )}
            <Button size="sm" variant={changes.length ? 'primary' : 'secondary'} icon={<FileCode2 size={13} />} disabled={!changes.length} onClick={() => setReviewOpen(true)}>
              {tr('Review migration')}{changes.length ? ` (${changes.length})` : ''}
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant={design ? 'subtle' : 'ghost'}
          icon={<PencilRuler size={13} />}
          onClick={() => {
            setDesign((v) => !v)
            setSelected(null)
          }}
          title={tr('Design changes to the schema on the diagram and generate a migration script')}
        >
          {design ? tr('Designing') : tr('Design')}
        </Button>
        <Button size="sm" variant="ghost" icon={<LayoutGrid size={13} />} onClick={resetLayout}>
          {tr('Auto layout')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<Bookmark size={13} />}
          onClick={async (e) => {
            const anchor = e.currentTarget
            const list: SavedDiagram[] = await api.listDiagrams(tab.connectionId)
            openMenu(anchor, [
              { label: tr('Save as new diagram…'), icon: <Plus size={13} />, onClick: () => setNaming(true) },
              ...(tab.savedId
                ? [
                    {
                      label: tr('Delete this diagram'),
                      danger: true,
                      onClick: () => {
                        if (!window.confirm(tr('Delete diagram “{name}”?', { name: tab.title }))) return
                        void api.deleteDiagram(tab.savedId!).then(() => {
                          updateTab(tab.id, { savedId: undefined, tables: undefined, title: tr('ER diagram') })
                        })
                      },
                    },
                  ]
                : []),
              ...(list.length ? ['separator' as const] : []),
              ...list.map((d) => ({
                label: d.name,
                icon: <Network size={13} />,
                onClick: () => openTab({ kind: 'diagram', connectionId: tab.connectionId, title: d.name, tables: d.tables, positions: d.positions, savedId: d.id }, { reuse: false }),
              })),
            ])
          }}
        >
          {tab.savedId ? tab.title : tr('Diagrams')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<Download size={13} />}
          onClick={(e) =>
            openMenu(e.currentTarget, [
              { label: tr('PNG image'), onClick: () => void exportImage('png') },
              { label: tr('SVG image'), onClick: () => void exportImage('svg') },
              'separator',
              { label: tr('Copy as Mermaid'), onClick: exportMermaid },
              { label: tr('Copy as DBML (dbdiagram.io)'), onClick: exportDbml },
            ])
          }
        >
          {tr('Export')}
        </Button>
      </div>
      {staleDesign && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-warning-soft px-3 text-[12px] text-warning">
          {tr('The database schema changed since this design was started (maybe the migration already ran).')}
          <Button size="xs" onClick={() => setDrafts({})}>
            {tr('Discard design')}
          </Button>
        </div>
      )}
      {design && (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-accent-soft px-3 text-[12px]">
          <PencilRuler size={13} className="text-accent" />
          <span>
            <b>{tr('Design mode.')}</b> {tr('Click a table to edit it, drag from a column dot to another table to add a foreign key. Nothing changes in the database until you run the generated migration.')}
          </span>
        </div>
      )}
      {focusName && pathTo && schema.tables.some((t) => t.name === pathTo) && (
        <div className={cn('flex h-8 shrink-0 items-center gap-2 border-b border-line px-3 text-[12px]', joinPath ? 'bg-subtle' : 'bg-warning-soft text-warning')}>
          <Route size={13} className={joinPath ? 'text-accent' : ''} />
          {joinPath ? (
            <>
              <span className="truncate font-medium">{[joinPath[0]?.from.name ?? focusName, ...joinPath.map((s) => s.to.name)].join(' → ')}</span>
              <span className="shrink-0 text-fg-faint">{tp(joinPath.length, { one: '{n} join', many: '{n} joins' })}</span>
              <div className="flex-1" />
              {connection && joinPath.length > 0 && (
                <>
                  <Button size="xs" variant="ghost" icon={<Copy size={12} />} onClick={() => void copyText(joinPathSql(joinPath, getDialect(connection.driver).quoteIdent, schema.defaultSchema))}>
                    {tr('Copy SQL')}
                  </Button>
                  <Button
                    size="xs"
                    variant="primary"
                    onClick={() => newQuery(tab.connectionId, `${joinPathSql(joinPath, getDialect(connection.driver).quoteIdent, schema.defaultSchema)};`, `${focusName} → ${pathTo}`)}
                  >
                    {tr('Open as query')}
                  </Button>
                </>
              )}
            </>
          ) : (
            <span>{tr('No chain of foreign keys connects {from} and {to}.', { from: focusName, to: pathTo })}</span>
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
      <div ref={wrapper} className="min-h-0 min-w-0 flex-1">
        <svg width="0" height="0" className="absolute">
          <defs>
            {/* At the path start with auto-start-reverse, +x points into the source node: prongs spread at the node edge (x=15). */}
            <marker id="crow-many" viewBox="0 0 16 16" refX="15" refY="8" markerWidth="16" markerHeight="16" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
              <path d="M3 8 L15 1 M3 8 L15 8 M3 8 L15 15" fill="none" stroke="var(--text-muted)" strokeWidth="1.2" />
            </marker>
            <marker id="crow-one" viewBox="0 0 16 16" refX="15" refY="8" markerWidth="16" markerHeight="16" orient="auto" markerUnits="userSpaceOnUse">
              <path d="M10 2 L10 14 M6 2 L6 14" fill="none" stroke="var(--text-muted)" strokeWidth="1.2" />
            </marker>
            <marker id="crow-zero-one" viewBox="0 0 20 16" refX="19" refY="8" markerWidth="20" markerHeight="16" orient="auto" markerUnits="userSpaceOnUse">
              <circle cx="5" cy="8" r="3.2" fill="var(--bg)" stroke="var(--text-muted)" strokeWidth="1.2" />
              <path d="M13 2 L13 14" fill="none" stroke="var(--text-muted)" strokeWidth="1.2" />
            </marker>
          </defs>
        </svg>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          nodesConnectable={design}
          onNodeClick={(_, n) => design && setSelected(n.id)}
          onPaneClick={() => setSelected(null)}
          onNodeMouseEnter={(_, n) => setHovered(n.id)}
          onNodeMouseLeave={() => setHovered(null)}
          onNodeDragStop={(_, node) => {
            if (drafts[node.id] && !drafts[node.id]!.originalName) {
              updateDraft(node.id, { ...drafts[node.id]!, position: node.position })
              return
            }
            const positions = { ...(tab.positions ?? {}), [node.id]: node.position }
            updateTab(tab.id, { positions })
          }}
          onNodeDoubleClick={(_, n) => openTab({ kind: 'table', connectionId: tab.connectionId, table: { schema: n.data.table.schema, name: n.data.table.name }, title: n.data.table.name })}
          onNodeContextMenu={(e, n) =>
            openMenu(e, [
              { label: tr('Open data'), icon: <Table2 size={13} />, onClick: () => openTab({ kind: 'table', connectionId: tab.connectionId, table: { schema: n.data.table.schema, name: n.data.table.name }, title: n.data.table.name }) },
              { label: tr('Open structure'), onClick: () => openTab({ kind: 'structure', connectionId: tab.connectionId, table: { schema: n.data.table.schema, name: n.data.table.name }, title: tr('{name} · structure', { name: n.data.table.name }) }) },
              { label: tr('Focus here'), icon: <Network size={13} />, onClick: () => setFocusName(n.data.table.name) },
              ...(tab.tables && !focusName
                ? [
                    'separator' as const,
                    { label: tr('Add related tables'), icon: <Plus size={13} />, onClick: () => addRelated(n.data.table) },
                    { label: tr('Remove from diagram'), onClick: () => updateTab(tab.id, { tables: tab.tables!.filter((k) => k !== keyOf(n.data.table)) }) },
                  ]
                : []),
            ])
          }
          colorMode={dark ? 'dark' : 'light'}
          minZoom={0.05}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          fitView
          fitViewOptions={{ maxZoom: 1 }}
          onlyRenderVisibleElements={tables.length > 80}
          defaultEdgeOptions={{ markerEnd: { type: MarkerType.Arrow } }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--border-strong)" />
          <Controls showInteractive={false} />
          {tables.length > 12 && (
            <MiniMap
              pannable
              zoomable
              nodeColor={() => 'var(--accent-soft)'}
              nodeStrokeColor={() => 'var(--accent)'}
              bgColor="var(--bg-subtle)"
              maskColor={dark ? 'rgba(0,0,0,0.45)' : 'rgba(15,23,42,0.06)'}
              style={{ width: 180, height: 120, border: '1px solid var(--border)', borderRadius: 8 }}
            />
          )}
        </ReactFlow>
      </div>
      {design && selected && selectedDraft && connection && (
        <TableEditor
          key={selected}
          table={selectedDraft}
          driver={connection.driver}
          allTables={tables}
          onChange={(t) => updateDraft(selected, t)}
          onRevert={
            drafts[selected]?.originalName
              ? () => {
                  const next = { ...drafts }
                  delete next[selected]
                  setDrafts(next)
                }
              : undefined
          }
          onClose={() => setSelected(null)}
        />
      )}
      </div>
      <DiagramNameModal open={naming} onClose={() => setNaming(false)} onSave={(name) => void saveAs(name)} />
      {connection && schema && (
        <MigrationModal
          open={reviewOpen}
          onClose={() => setReviewOpen(false)}
          changes={changes}
          driver={connection.driver}
          tables={schema.tables}
          connectionId={tab.connectionId}
          onOpenInEditor={(sql) => {
            setReviewOpen(false)
            newQuery(tab.connectionId, sql, tr('Migration'))
          }}
        />
      )}
    </div>
  )
}

export function DiagramView({ tab }: { tab: DiagramTab }) {
  return (
    <ReactFlowProvider>
      <DiagramInner tab={tab} />
    </ReactFlowProvider>
  )
}

function DiagramNameModal({ open, onClose, onSave }: { open: boolean; onClose: () => void; onSave: (name: string) => void }) {
  const tr = useT()
  const [name, setName] = useState('')
  useEffect(() => {
    if (open) setName('')
  }, [open])
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tr('Save diagram')}
      width={400}
      footer={
        <>
          <div className="flex-1" />
          <Button onClick={onClose}>{tr('Cancel')}</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => onSave(name.trim())}>
            {tr('Save')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) onSave(name.trim())
        }}
        className="flex flex-col gap-2"
      >
        <Input autoFocus placeholder={tr('e.g. Sales, Billing, Warehouse')} value={name} onChange={(e) => setName(e.target.value)} />
        <p className="text-[11.5px] text-fg-faint">{tr('The diagram keeps the tables shown now and their positions. Add or remove tables later; changes are saved automatically.')}</p>
      </form>
    </Modal>
  )
}

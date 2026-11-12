import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  getSmoothStepPath,
  getViewportForBounds,
  Handle,
  MarkerType,
  MiniMap,
  NodeResizeControl,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useConnection,
  useNodesState,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import ELK from 'elkjs/lib/elk.bundled.js'
import { toPng, toSvg } from 'html-to-image'
import { AlignHorizontalJustifyStart, AlignVerticalJustifyStart, AlignHorizontalSpaceAround, AlignVerticalSpaceAround, Bookmark, Copy, Download, Trash2, Eye, FileCode2, KeyRound, LayoutGrid, Link2, Network, PencilRuler, Plus, Route, Search, Layers, Redo, Sparkles, SquareDashed, StickyNote, Table2, Undo, Undo2, Users, X } from 'lucide-react'
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
  buildDataDictionary,
  toDbml,
  toDesignTable,
  toMermaid,
  toPlantUml,
  type DesignTable,
  type DriverId,
  type SchemaSnapshot,
  type TableInfo,
} from '@dbmastermind/core/browser'
import { Button, IconButton } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { api, keys } from '@/lib/api'
import { openMenu } from '@/components/ui/ContextMenu'
import { EmptyState } from '@/components/ui/EmptyState'
import { Checkbox, Input, Select } from '@/components/ui/Input'
import { Spinner } from '@/components/ui/Spinner'
import { cn, copyText, errorMessage, fuzzyScore, uid } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { useSettings } from '@/store/settings'
import { askAi, toast } from '@/store/ui'
import { driverLabel } from '../connections/drivers'
import { useWorkspace, type DiagramTab } from '@/store/workspace'
import type { SavedDiagram, DiagramNote, DiagramDisplay } from '@shared/api'
import { MigrationModal } from './MigrationModal'
import { TableEditor } from './TableEditor'
import { TableDialog } from './TableDialog'
import { RelationshipDialog } from './RelationshipDialog'
import { formatDate, t, tp, useT } from '@/lib/i18n'
import { askText, confirmAction } from '@/components/ui/ConfirmDialog'

const elk = new ELK()
const HEADER = 32
const ROW = 22
const WIDTH = 240

type DesignStatus = 'live' | 'modified' | 'new' | 'dropped'

interface TableNodeData extends Record<string, unknown> {
  table: TableInfo
  status: DesignStatus
  design: boolean
  /** Which columns and what of them the box shows (a DeZign diagram's own setting, or the toolbar's). */
  shown: Shown
  highlighted: boolean
  dimmed: boolean
  focus: boolean
  fkColumns: Set<string>
  referencedColumns: Set<string>
  /** Series palette index (1–8) for the header, when the user colored the table. */
  color?: number
}

type DezignColumnsShown = DiagramDisplay['columns']
/** What a table box shows: DeZign's attribute display level and data type display, and columns hidden in this box. */
export interface Shown {
  columns: DezignColumnsShown
  types: 'none' | 'type' | 'domain'
  hidden?: string[]
}
const ALL: DiagramDisplay = { columns: 'all', types: 'type' }

function visibleColumns(t: TableInfo, shown: Shown, fkColumns: Set<string>, referenced: Set<string>) {
  const hidden = new Set(shown.hidden ?? [])
  const cols = t.columns.filter((c) => !hidden.has(c.name))
  switch (shown.columns) {
    case 'keys':
      return cols.filter((c) => c.isPrimaryKey || fkColumns.has(c.name) || referenced.has(c.name))
    case 'primary':
      return cols.filter((c) => c.isPrimaryKey)
    case 'none':
      return []
    case 'first10':
      return cols.slice(0, 10)
    case 'first20':
      return cols.slice(0, 20)
    default:
      return cols
  }
}
/** The "+ n more columns" line: where a level leaves columns out, not where the user hid some on purpose. */
const showsMore = (shown: Shown) => shown.columns === 'keys' || shown.columns === 'first10' || shown.columns === 'first20'

const TableNode = memo(function TableNode({ data }: NodeProps<Node<TableNodeData>>) {
  const { table, shown, fkColumns, referencedColumns } = data
  const cols = visibleColumns(table, shown, fkColumns, referencedColumns)
  // Relationship lines of columns the box does not show end at its header.
  const offBox = table.columns.filter((c) => !cols.includes(c) && (fkColumns.has(c.name) || referencedColumns.has(c.name)))
  // While a key is being dragged, the whole table is where it can be dropped (a column's own dot still names that column).
  const connecting = useConnection((c) => c.inProgress)
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
        className={cn('relative flex items-center gap-1.5 px-2.5 text-[12px] font-semibold', table.type === 'table' ? 'bg-accent text-accent-fg' : 'bg-info text-white', data.color && 'text-white', data.design && table.type === 'table' && 'pr-6')}
        // Darkened series colors keep white text readable in both themes.
        style={{ height: HEADER, ...(data.color ? { background: `color-mix(in srgb, var(--series-${data.color}) 78%, black)` } : {}) }}
        title={table.comment ?? undefined}
      >
        {table.type === 'table' ? <Table2 size={12} /> : <Eye size={12} />}
        <span className="truncate">{table.name}</span>
        {data.status !== 'live' ? (
          <span className="ml-auto rounded bg-white/25 px-1 text-[9.5px] font-bold uppercase">{t(data.status)}</span>
        ) : (
          table.schema && <span className="ml-auto truncate text-[10px] font-normal opacity-75">{table.schema}</span>
        )}
        {/* Dragged to another table: this table gets the key column and the foreign key (as drawing a relationship does in DeZign). */}
        {/* (Always there, as the library measures a node's handles once: shown and live only while designing.) */}
        {table.type === 'table' && (
          <Handle
            type="source"
            position={Position.Right}
            id="s-*"
            isConnectable={data.design}
            title={data.design ? t('Drag to another table: adds the key column and the foreign key') : undefined}
            className={cn('!right-2.5 !z-20 !h-3 !w-3 !min-w-0', data.design ? '!border-2 !border-white !bg-success' : '!pointer-events-none !border-0 !bg-transparent')}
          />
        )}
      </div>
      {/* While a key is dragged the whole table takes the drop (a column's own dot, above it, still names that column). */}
      {table.type === 'table' && (
        <Handle type="target" position={Position.Left} id="t-*" isConnectable={data.design} className={cn('!inset-0 !z-[5] !h-full !w-full !transform-none !rounded-none !border-0 !bg-transparent', data.design && connecting ? '!pointer-events-auto' : '!pointer-events-none')} />
      )}
      {cols.map((c) => (
        <div key={c.name} className="relative flex items-center gap-1.5 border-t border-line px-2.5 text-[11px]" style={{ height: ROW }} title={c.comment ?? undefined}>
          <Handle type="target" position={Position.Left} id={`t-${c.name}`} className={cn('!z-10 !h-1.5 !w-1.5 !min-w-0 !border-0', data.design ? '!bg-accent/50' : '!bg-transparent')} />
          {c.isPrimaryKey ? (
            <KeyRound size={10} className="shrink-0 text-warning" />
          ) : fkColumns.has(c.name) ? (
            <Link2 size={10} className="shrink-0 text-info" />
          ) : (
            <span className="w-[10px] shrink-0" />
          )}
          <span className={cn('truncate', c.isPrimaryKey && 'font-semibold')}>{c.name}</span>
          {shown.types !== 'none' && <span className="ml-auto max-w-[45%] shrink-0 truncate font-mono text-[10px] text-fg-faint">{shown.types === 'domain' && c.domain ? c.domain : c.dataType}</span>}
          {!c.nullable && !c.isPrimaryKey && <span className="text-[9px] text-fg-faint">NN</span>}
          <Handle type="source" position={Position.Right} id={`s-${c.name}`} className={cn('!z-10 !h-1.5 !w-1.5 !min-w-0 !border-0', data.design ? '!h-2.5 !w-2.5 !bg-accent' : '!bg-transparent')} />
        </div>
      ))}
      {offBox.map((c) => (
        <span key={c.name}>
          <Handle type="target" position={Position.Left} id={`t-${c.name}`} isConnectable={false} className="!pointer-events-none !opacity-0" style={{ top: HEADER / 2 }} />
          <Handle type="source" position={Position.Right} id={`s-${c.name}`} isConnectable={false} className="!pointer-events-none !opacity-0" style={{ top: HEADER / 2 }} />
        </span>
      ))}
      {showsMore(shown) && cols.length < table.columns.length && (
        <div className="border-t border-line px-2.5 text-[10.5px] text-fg-faint" style={{ height: ROW, lineHeight: `${ROW}px` }}>
          + {table.columns.length - cols.length} more columns
        </div>
      )}
    </div>
  )
})

interface NoteNodeData extends Record<string, unknown> {
  text: string
  /** Just added: the cursor goes in so typing starts the note. */
  autoFocus?: boolean
  onChange: (text: string) => void
  onDelete: () => void
}

/** A sticky note: free text on the canvas, saved with the diagram. */
const NoteNode = memo(function NoteNode({ data }: NodeProps<Node<NoteNodeData>>) {
  const tr = useT()
  const [text, setText] = useState(data.text)
  useEffect(() => setText(data.text), [data.text])
  // Saved while typing (not only on blur), so a note survives quitting the app with the cursor still in it.
  const save = useRef(data.onChange)
  save.current = data.onChange
  useEffect(() => {
    if (text === data.text) return
    const timer = setTimeout(() => save.current(text), 400)
    return () => clearTimeout(timer)
  }, [text, data.text])
  const area = useRef<HTMLTextAreaElement>(null)
  // React Flow shows a node only once it's measured, and a hidden field can't take focus: retry for a few frames.
  useEffect(() => {
    if (!data.autoFocus) return
    let frames = 0
    let id = 0
    const tryFocus = () => {
      area.current?.focus()
      if (document.activeElement !== area.current && ++frames < 20) id = requestAnimationFrame(tryFocus)
    }
    id = requestAnimationFrame(tryFocus)
    return () => cancelAnimationFrame(id)
  }, [data.autoFocus])
  return (
    <div className="group relative w-[220px] rounded-md border border-warning/50 bg-[color-mix(in_srgb,var(--warning)_14%,var(--bg))] p-2 shadow-sm">
      <textarea
        ref={area}
        value={text}
        placeholder={tr('Note…')}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== data.text && data.onChange(text)}
        // Grows with the text, wrapped lines included.
        className="nodrag nowheel min-h-[2.6em] w-full resize-none overflow-hidden bg-transparent text-[12px] leading-snug text-fg outline-none [field-sizing:content] placeholder:text-fg-faint"
      />
      <button
        type="button"
        aria-label={tr('Delete note')}
        onClick={data.onDelete}
        className="absolute -top-2 -right-2 hidden h-5 w-5 items-center justify-center rounded-full border border-line bg-elevated text-fg-muted group-hover:flex hover:text-danger"
      >
        <X size={11} />
      </button>
    </div>
  )
})

/**
 * A captioned frame behind the tables (DeZign's group box): it shows what belongs together. Only its caption bar
 * and its corner take the pointer, to move and to resize it; the tables inside stay clickable.
 */
const BoxNode = memo(function BoxNode({ data }: NodeProps<Node<{ title: string; w: number; h: number; onResize: (w: number, h: number) => void }>>) {
  return (
    <div style={{ width: data.w, height: data.h }} className="pointer-events-none rounded-lg border-2 border-dashed border-fg-faint/50 bg-accent/5" data-testid="diagram-box">
      <div className="dbm-box-handle pointer-events-auto cursor-move px-3 py-1.5 text-[13px] font-semibold text-fg-muted" title={t('Drag to move the frame; right-click to rename or remove it')}>
        {data.title || '\u00a0'}
      </div>
      <NodeResizeControl
        position="bottom-right"
        minWidth={80}
        minHeight={60}
        className="pointer-events-auto !h-3 !w-3 !border-0 !bg-fg-faint/60"
        onResizeEnd={(_, p) => data.onResize(Math.round(p.width), Math.round(p.height))}
      />
    </div>
  )
})

const nodeTypes = { table: TableNode, note: NoteNode, box: BoxNode }

/** CSS properties kept when the diagram is exported as an image (see exportImage). */
const EXPORT_STYLE_PROPERTIES = [
  'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'box-sizing', 'overflow-x', 'overflow-y', 'visibility', 'opacity',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'transform', 'transform-origin',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-style', 'border-right-style',
  'border-bottom-style', 'border-left-style', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius',
  'background-color', 'background-image', 'box-shadow', 'outline-style', 'outline-width', 'outline-color',
  'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant-numeric', 'line-height', 'letter-spacing',
  'text-align', 'text-transform', 'text-overflow', 'white-space', 'word-break', 'vertical-align', 'text-decoration-line',
  'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'align-items', 'align-self', 'justify-content',
  'gap', 'row-gap', 'column-gap', 'grid-template-columns', 'grid-template-rows',
  'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'stroke-opacity',
  'marker-start', 'marker-end',
  // Theme variables that inline styles (edge strokes, markers, notes) refer to.
  '--text-muted', '--text-faint', '--warning', '--bg', '--bg-subtle', '--bg-elevated', '--accent', '--accent-soft', '--border', '--border-strong',
]
const isNote = (id: string) => id.startsWith('note:')

/** Asked from outside the canvas (the model's object browser); `n` makes the same request again a new one. */
export type DiagramRequest = ({ kind: 'locate'; key: string } | { kind: 'table'; key: string } | { kind: 'relationship'; key: string; fk: string }) & { n: number }

/** Names for the series palette colors, in palette order. */
const COLOR_NAMES = ['Blue', 'Orange', 'Teal', 'Yellow', 'Pink', 'Green', 'Purple', 'Red']

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

type Point = { x: number; y: number }

/** Vertical center of a column's row (where its handles sit), from the node's top edge (1px border included). */
function columnY(t: TableInfo, shown: Shown, fk: Set<string>, ref: Set<string>, column: string): number {
  const i = visibleColumns(t, shown, fk, ref).findIndex((c) => c.name === column)
  // (A column the box does not show: its line ends at the header.)
  if (i === -1) return HEADER / 2
  return 1 + HEADER + i * ROW + ROW / 2
}

/** SVG path through orthogonal points with rounded corners. */
function roundedPath(points: Point[], radius = 6): string {
  let d = `M ${points[0]!.x} ${points[0]!.y}`
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1]!, points[i]!, points[i + 1]!]
    const r = Math.min(radius, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2)
    const before = { x: b.x - Math.sign(b.x - a.x) * r, y: b.y - Math.sign(b.y - a.y) * r }
    const after = { x: b.x + Math.sign(c.x - b.x) * r, y: b.y + Math.sign(c.y - b.y) * r }
    d += ` L ${before.x} ${before.y} Q ${b.x} ${b.y} ${after.x} ${after.y}`
  }
  const last = points[points.length - 1]!
  return `${d} L ${last.x} ${last.y}`
}

/**
 * A relationship line along the route the layout computed (no crossings where avoidable); when a table was moved
 * since, the route no longer fits and the line falls back to a plain step path.
 */
const RoutedEdge = memo(function RoutedEdge(props: EdgeProps<Edge<{ route?: Point[] }>>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerStart, markerEnd, style, label, labelStyle, labelBgStyle } = props
  const route = data?.route
  const fits = !!route && route.length >= 2 && Math.abs(route[0]!.x - sourceX) < 6 && Math.abs(route[0]!.y - sourceY) < 6 && Math.abs(route.at(-1)!.x - targetX) < 6 && Math.abs(route.at(-1)!.y - targetY) < 6
  if (fits) {
    // Snap the route's ends to the real handle positions (a few pixels from the layout's ports), keeping it orthogonal.
    const inner = route.slice(1, -1).map((p) => ({ ...p }))
    if (inner.length) {
      if (Math.abs(inner[0]!.y - route[0]!.y) < 1) inner[0]!.y = sourceY
      if (Math.abs(inner.at(-1)!.y - route.at(-1)!.y) < 1) inner.at(-1)!.y = targetY
    } else if (Math.abs(sourceY - targetY) > 0.5) {
      const midX = (sourceX + targetX) / 2
      inner.push({ x: midX, y: sourceY }, { x: midX, y: targetY })
    }
    const points = [{ x: sourceX, y: sourceY }, ...inner, { x: targetX, y: targetY }]
    const mid = points[Math.floor(points.length / 2)]!
    return <BaseEdge className="dbm-routed" path={roundedPath(points)} markerStart={markerStart} markerEnd={markerEnd} style={style} label={label} labelX={mid.x} labelY={mid.y} labelStyle={labelStyle} labelBgStyle={labelBgStyle} />
  }
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 6 })
  return <BaseEdge className="dbm-stepped" path={path} markerStart={markerStart} markerEnd={markerEnd} style={style} label={label} labelX={labelX} labelY={labelY} labelStyle={labelStyle} labelBgStyle={labelBgStyle} />
})

const edgeTypes = { routed: RoutedEdge }

function nodeHeight(t: TableInfo, shown: Shown, fk: Set<string>, ref: Set<string>): number {
  const visible = visibleColumns(t, shown, fk, ref).length
  return HEADER + visible * ROW + (showsMore(shown) && visible < t.columns.length ? ROW : 0) + 2
}

function DiagramInner({ tab, model, modelDriver, domains, dashNonIdentifying, request, onApplyModel, onLayout }: { tab: DiagramTab; model?: SchemaSnapshot; modelDriver?: DriverId; domains?: { name: string; dataType: string }[]; dashNonIdentifying?: boolean; request?: DiagramRequest; onApplyModel?: (tables: TableInfo[]) => void; onLayout?: (patch: Partial<Pick<DiagramTab, 'positions' | 'notes' | 'colors' | 'tables' | 'display' | 'boxes'>>) => void }) {
  const tr = useT()
  const runtime = useConnections((s) => s.runtime[tab.connectionId])
  const loadSchema = useConnections((s) => s.loadSchema)
  const openTab = useWorkspace((s) => s.open)
  const updateTab = useWorkspace((s) => s.update)
  const patchLayout = (patch: Partial<Pick<DiagramTab, 'positions' | 'notes' | 'colors' | 'tables' | 'display' | 'boxes'>>) => (onLayout ? onLayout(patch) : updateTab(tab.id, patch))
  const dark = useSettings((s) => s.dark)
  // A model (DBML) replaces the live schema; designing it writes the result back to the DBML text.
  const schema = model ?? runtime?.schema
  const flow = useReactFlow()
  const wrapper = useRef<HTMLDivElement>(null)

  const [schemaFilter, setSchemaFilter] = useState<string>('')
  const [focusName, setFocusName] = useState<string | undefined>(tab.focus)
  const [depth, setDepth] = useState(1)
  /** Second table: show only the join path from the focused table to it. */
  const [pathTo, setPathTo] = useState<string>()
  // A DeZign diagram's own display setting; the toolbar changes it (and Save takes it to the project).
  const shownAs: DiagramDisplay = tab.display ?? ALL
  const shownFor = (key: string): Shown => ({ columns: shownAs.columns, types: shownAs.types, hidden: shownAs.hidden?.[key] })
  const [search, setSearch] = useState('')
  const [hovered, setHovered] = useState<string | null>(null)
  const [layouting, setLayouting] = useState(false)
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TableNodeData>>([])
  const connection = useConnections((s) => s.list.find((c) => c.id === tab.connectionId))
  // A model needs no database to be edited: without a connection the table editor works for the model's own.
  const editorDriver = connection?.driver ?? (model ? (modelDriver ?? 'postgres') : undefined)
  const newQuery = useWorkspace((s) => s.newQuery)
  const [design, setDesign] = useState(!!tab.startDesign || (!!tab.design && Object.keys(tab.design).length > 0))
  const [selected, setSelected] = useState<string | null>(tab.startDesign ?? null)
  // A relationship clicked on the canvas: the child table's panel shows its foreign key.
  const [focusFk, setFocusFk] = useState<string | undefined>()
  // DeZign's dialogs for a model: a table's (double-click) and a relationship's (double-click on its line).
  // (The draft is taken when the dialog opens: a table not edited yet gets a fresh draft, with new ids, each render.)
  const [dialog, setDialog] = useState<{ kind: 'table'; key: string; table: DesignTable } | { kind: 'relationship'; key: string; fk: string; table: DesignTable } | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const drafts = useMemo(() => tab.design ?? {}, [tab.design])
  // Changes arriving from outside (the AI assistant) switch the designer on.
  const draftCount = Object.keys(drafts).length
  useEffect(() => {
    if (draftCount > 0) setDesign(true)
  }, [draftCount])
  // Undo/redo of design changes. Quick successive edits (typing a name) count as one step.
  // Each step keeps the tables' drafts and where the tables stood: moving or lining them up is undone too.
  type Step = { drafts: Record<string, DesignTable>; positions?: Record<string, { x: number; y: number }> }
  const history = useRef<{ past: Step[]; future: Step[]; at: number; key?: string }>({ past: [], future: [], at: 0 })
  const [, setHistoryVersion] = useState(0)
  const setDrafts = (next: Record<string, DesignTable>, record = true) => {
    if (record) {
      const h = history.current
      const now = Date.now()
      const changed = [...new Set([...Object.keys(drafts), ...Object.keys(next)])].filter((k) => drafts[k] !== next[k])
      const key = changed.length === 1 ? changed[0] : undefined
      // Successive edits of one table within a moment (typing a name) are one step; adding or removing a table,
      // column, foreign key or index always starts a new one.
      const shape = (t: DesignTable | undefined) => (t ? `${t.columns.length}/${t.foreignKeys.length}/${t.indexes.length}/${t.dropped ? 1 : 0}` : '')
      const typing = key && key === h.key && drafts[key] && next[key] && shape(drafts[key]) === shape(next[key]) && now - h.at < 800
      if (!typing) h.past = [...h.past.slice(-99), { drafts, positions: tab.positions }]
      h.at = now
      h.key = key
      h.future = []
      setHistoryVersion((v) => v + 1)
    }
    updateTab(tab.id, { design: next })
  }
  /** A move of tables as a step of its own (before the new positions are saved). */
  const rememberLayout = () => {
    const h = history.current
    h.past = [...h.past.slice(-99), { drafts, positions: tab.positions ?? currentPositions() }]
    h.at = 0
    h.key = undefined
    h.future = []
    setHistoryVersion((v) => v + 1)
  }
  const restore = (step: Step) => {
    updateTab(tab.id, { design: step.drafts })
    if (step.positions && JSON.stringify(step.positions) !== JSON.stringify(tab.positions)) {
      const at = step.positions
      setNodes((list) => list.map((n) => (at[n.id] ? { ...n, position: at[n.id]! } : n)))
      patchLayout({ positions: at })
    }
  }
  const undoDesign = () => {
    const h = history.current
    const prev = h.past.pop()
    if (!prev) return
    h.future.push({ drafts, positions: tab.positions })
    h.at = 0
    setHistoryVersion((v) => v + 1)
    restore(prev)
  }
  const redoDesign = () => {
    const h = history.current
    const next = h.future.pop()
    if (!next) return
    h.past.push({ drafts, positions: tab.positions })
    h.at = 0
    setHistoryVersion((v) => v + 1)
    restore(next)
  }
  const undoRef = useRef({ undoDesign, redoDesign })
  undoRef.current = { undoDesign, redoDesign }
  useEffect(() => {
    if (!design) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' && e.key.toLowerCase() !== 'y') return
      // Text fields keep their own undo.
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, select, .cm-editor')) return
      if (!wrapper.current?.isConnected || wrapper.current.offsetParent === null) return
      e.preventDefault()
      if (e.key.toLowerCase() === 'y' || e.shiftKey) undoRef.current.redoDesign()
      else undoRef.current.undoDesign()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [design])

  useEffect(() => {
    if (!schema && !model) void loadSchema(tab.connectionId)
  }, [schema, model, loadSchema, tab.connectionId])

  // Schemas hidden in the explorer stay out of the diagram's picker (unless that would leave none).
  const visibleSchemas = useMemo(() => {
    if (!schema) return []
    const hidden = new Set(connection?.hiddenSchemas ?? [])
    const shown = schema.schemas.filter((s) => !hidden.has(s))
    return shown.length ? shown : schema.schemas
  }, [schema, connection?.hiddenSchemas])

  useEffect(() => {
    if (!schema || schemaFilter) return
    // A model shows all its schemas, as DeZign draws a whole model on its diagram.
    if (model) return setSchemaFilter('*')
    // Prefer the default schema, unless it's hidden or empty and another one has the tables.
    const count = (s: string) => schema.tables.filter((t) => (t.schema ?? '') === s).length
    const preferred =
      schema.defaultSchema && visibleSchemas.includes(schema.defaultSchema) && count(schema.defaultSchema) > 0
        ? schema.defaultSchema
        : [...visibleSchemas].sort((a, b) => count(b) - count(a))[0]
    setSchemaFilter(preferred ?? '*')
  }, [schema, schemaFilter, visibleSchemas])

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
      // A model takes whatever the editor changed, also what no ALTER would say (the order of columns, the name of a key).
      const changed = diffTable(t, draft).length > 0 || (!!model && JSON.stringify(designToTableInfo(toDesignTable(t))) !== JSON.stringify(designToTableInfo(draft)))
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
    if (Object.keys(next).length !== Object.keys(drafts).length) setDrafts(next, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema?.capturedAt])

  const changes = useMemo(() => {
    if (!schema || !Object.keys(drafts).length) return []
    return diffTables(schema.tables, Object.values(drafts))
  }, [schema, drafts])

  // (For a model: also the tables changed in ways a migration would not list.)
  const pending = changes.length || display.filter((d) => d.status === 'modified' || d.status === 'new' || d.status === 'dropped').length

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

  // Orthogonal routes from the last auto layout, by edge id.
  const [routes, setRoutes] = useState<Record<string, Point[]>>({})

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
        // Identifying: the parent's key is part of the child's own key (DeZign draws it solid, the others dashed).
        const identifying = fk.columns.length > 0 && fk.columns.every((c) => t.primaryKey.includes(c))
        out.push({
          id: `${source}:${fk.name}`,
          source,
          target: targetKey,
          sourceHandle: `s-${fk.columns[0]}`,
          targetHandle: `t-${fk.refColumns[0]}`,
          type: 'routed',
          data: { route: routes[`${source}:${fk.name}`] },
          animated: active,
          // The child's end says how many rows one parent has (a model's cardinality); the parent's, whether one is needed.
          markerStart: fk.cardinality === 'exactly-one' ? 'crow-one' : fk.cardinality === 'zero-or-one' ? 'crow-zero-one' : 'crow-many',
          markerEnd: optional ? 'crow-zero-one' : 'crow-one',
          style: {
            stroke: active ? 'var(--accent)' : fk.virtual ? 'var(--warning)' : 'var(--text-faint)',
            strokeWidth: active ? 2 : 1.3,
            strokeDasharray: fk.virtual ? '5 4' : dashNonIdentifying && !identifying ? '6 4' : undefined,
          },
          label: active ? fk.columns.join(', ') : undefined,
          labelStyle: { fontSize: 10, fill: 'var(--text-muted)' },
          labelBgStyle: { fill: 'var(--bg-elevated)' },
        })
      }
    }
    return out
  }, [tables, hovered, keyByName, routes, dashNonIdentifying])

  const latest = useRef({ display, columnSets, edges })
  latest.current = { display, columnSets, edges }
  const nodeData = (d: (typeof display)[number]): TableNodeData => ({
    table: d.info,
    status: d.status,
    design,
    shown: shownFor(d.key),
    highlighted: false,
    dimmed: false,
    focus: d.info.name === focusName,
    fkColumns: columnSets.fk.get(d.info.name) ?? new Set(),
    referencedColumns: columnSets.ref.get(d.info.name) ?? new Set(),
    color: tab.colors?.[d.key],
  })
  // Re-layout only when the set of tables changes, not on every edit.
  const structure = `${liveTables.map(keyOf).join('|')}#${shownAs.columns}#${JSON.stringify(shownAs.hidden ?? {})}`

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
        // Ports at the exact rows the lines attach to let the layout untangle them; orthogonal routes are drawn as is.
        layoutOptions: {
          'elk.algorithm': 'layered',
          'elk.direction': 'RIGHT',
          'elk.edgeRouting': 'ORTHOGONAL',
          'elk.layered.spacing.nodeNodeBetweenLayers': '110',
          'elk.layered.spacing.edgeNodeBetweenLayers': '24',
          'elk.spacing.edgeEdge': '10',
          'elk.spacing.nodeNode': '36',
          'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
          'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
          'elk.layered.thoroughness': '60',
          'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
          'elk.layered.cycleBreaking.strategy': 'GREEDY',
          // Long FK chains would otherwise become one endless row: wrap them into rows close to a screen's shape.
          'elk.layered.wrapping.strategy': 'MULTI_EDGE',
          'elk.aspectRatio': '1.6',
          'elk.separateConnectedComponents': 'true',
          'elk.spacing.componentComponent': '70',
        },
        children: display.map(({ key, info: t }) => {
          const fk = columnSets.fk.get(t.name) ?? new Set<string>()
          const ref = columnSets.ref.get(t.name) ?? new Set<string>()
          const out = new Set(edges.filter((e) => e.source === key).map((e) => e.sourceHandle!.slice(2)))
          const inn = new Set(edges.filter((e) => e.target === key).map((e) => e.targetHandle!.slice(2)))
          return {
            id: key,
            width: WIDTH,
            height: nodeHeight(t, shownFor(key), fk, ref),
            layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
            ports: [
              ...[...out].map((c) => ({ id: `${key}::s-${c}`, x: WIDTH, y: columnY(t, shownFor(key), fk, ref, c), width: 0, height: 0, layoutOptions: { 'elk.port.side': 'EAST' } })),
              ...[...inn].map((c) => ({ id: `${key}::t-${c}`, x: 0, y: columnY(t, shownFor(key), fk, ref, c), width: 0, height: 0, layoutOptions: { 'elk.port.side': 'WEST' } })),
            ],
          }
        }),
        edges: edges.map((e) => ({ id: e.id, sources: [`${e.source}::${e.sourceHandle}`], targets: [`${e.target}::${e.targetHandle}`] })),
      })
      const nextRoutes: Record<string, Point[]> = {}
      for (const e of graph.edges ?? []) {
        const section = (e as { sections?: { startPoint: Point; endPoint: Point; bendPoints?: Point[] }[] }).sections?.[0]
        if (section) nextRoutes[e.id] = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]
      }
      setRoutes(nextRoutes)
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
      // The view is fitted to where the tables are, not to the ones already drawn: a large diagram draws only the
      // tables in view, and fitting to those left a third of a 300-table model outside the window.
      const boxes = display.map((d) => ({ ...positions[d.key]!, bottom: positions[d.key]!.y + HEADER + ROW * d.info.columns.length }))
      const left = Math.min(...boxes.map((b) => b.x))
      const top = Math.min(...boxes.map((b) => b.y))
      const bounds = { x: left, y: top, width: Math.max(...boxes.map((b) => b.x)) + WIDTH - left, height: Math.max(...boxes.map((b) => b.bottom)) - top }
      requestAnimationFrame(() => {
        const pane = wrapper.current?.querySelector<HTMLElement>('.react-flow')
        if (!pane || !boxes.length || !pane.clientWidth) return void flow.fitView({ padding: 0.15, duration: 300, maxZoom: 1 })
        void flow.setViewport(getViewportForBounds(bounds, pane.clientWidth, pane.clientHeight, 0.05, 1, 0.1), { duration: 300 })
      })
      // In a custom diagram, pin the layout so adding a table doesn't rearrange the others.
      if (tab.tables && display.some((d) => !saved[d.key])) patchLayout({ positions: { ...saved, ...positions } })
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
  }, [display, columnSets, design, tab.colors])

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
    patchLayout({ positions: undefined })
    tab.positions = undefined
    void layout()
  }

  const exportImage = async (format: 'png' | 'svg') => {
    const el = wrapper.current?.querySelector<HTMLElement>('.react-flow__viewport')
    if (!el) return
    try {
      flow.fitView({ padding: 0.05 })
      await new Promise((r) => setTimeout(r, 350))
      const options = {
        backgroundColor: dark ? '#16181d' : '#ffffff',
        pixelRatio: 2,
        // The picture, without the minimap and the zoom buttons.
        filter: (node: HTMLElement) => !node.classList?.contains('react-flow__minimap') && !node.classList?.contains('react-flow__controls') && !node.classList?.contains('react-flow__panel'),
        // Only what the diagram's look depends on: copying every computed style made a 7-table SVG 9 MB.
        includeStyleProperties: EXPORT_STYLE_PROPERTIES,
      }
      const url = format === 'png' ? await toPng(wrapper.current!.querySelector('.react-flow') as HTMLElement, options) : await toSvg(wrapper.current!.querySelector('.react-flow') as HTMLElement, options)
      const path = await api.saveImageFile(url, `${tab.title.replace(/[^\w.-]+/g, '_')}.${format}`)
      if (path) toast({ kind: 'success', message: tr('Diagram saved'), detail: path, action: { label: tr('Show in folder'), run: () => void api.showItemInFolder(path) } })
    } catch (err) {
      toast({ kind: 'error', message: tr('Export failed'), detail: errorMessage(err) })
    }
  }

  /** PDF for paper: the whole diagram on one page, or at readable size on as many A4 pages as it takes. */
  const exportPdf = async (pages: 'one' | 'many') => {
    const root = wrapper.current?.querySelector<HTMLElement>('.react-flow')
    if (!root) return
    try {
      flow.fitView({ padding: 0.05 })
      await new Promise((r) => setTimeout(r, 350))
      const zoom = flow.getZoom() || 1
      const svg = await toSvg(root, {
        // Paper is white whatever the theme.
        backgroundColor: '#ffffff',
        filter: (node: HTMLElement) => !node.classList?.contains('react-flow__minimap') && !node.classList?.contains('react-flow__controls') && !node.classList?.contains('react-flow__panel') && !node.classList?.contains('react-flow__background'),
        includeStyleProperties: EXPORT_STYLE_PROPERTIES,
      })
      const path = await api.saveDiagramPdf({ svg, name: tab.title, width: Math.round(root.clientWidth / zoom), height: Math.round(root.clientHeight / zoom), pages })
      if (path) toast({ kind: 'success', message: tr('Diagram saved'), detail: path, action: { label: tr('Show in folder'), run: () => void api.showItemInFolder(path) } })
    } catch (err) {
      toast({ kind: 'error', message: tr('Export failed'), detail: errorMessage(err) })
    }
  }

  const exportMermaid = () => {
    void navigator.clipboard.writeText(toMermaid(tables))
    toast({ kind: 'success', message: tr('Mermaid diagram copied to clipboard') })
  }

  const exportPlantUml = () => {
    void navigator.clipboard.writeText(toPlantUml(tables))
    toast({ kind: 'success', message: tr('PlantUML diagram copied to clipboard') })
  }

  /** Model documents get the same HTML data dictionary as live databases (DBML notes become column comments). */
  const exportDictionary = () => {
    if (!schema) return
    const html = buildDataDictionary({ ...schema, tables }, { format: 'html', title: tab.title })
    const a = document.createElement('a')
    a.href = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
    a.download = `${tab.title.replace(/[^\w.-]+/g, '_')} - data dictionary.html`
    a.click()
  }

  const exportDbml = () => {
    void navigator.clipboard.writeText(toDbml(tables, { defaultSchema: schema?.defaultSchema }))
    toast({ kind: 'success', message: tr('DBML copied to clipboard'), detail: tr('Paste it into dbdiagram.io or a .dbml file.') })
  }

  /** Draft for a node, creating one from the live table on first edit. */
  const draftFor = (key: string): DesignTable | undefined => {
    if (drafts[key]) return drafts[key]
    const live = liveTables.find((t) => keyOf(t) === key)
    return live ? toDesignTable(live) : undefined
  }
  const updateDraft = (key: string, table: DesignTable) => {
    // Dropping a table that doesn't exist yet just discards it.
    if (table.dropped && !table.originalName) {
      const next = { ...drafts }
      delete next[key]
      setDrafts(next)
      setSelected(null)
      return
    }
    const next = { ...drafts, [key]: table }
    // In a model, a table renamed or moved to another schema takes the relationships that point at it along
    // (a database renames them by itself; a model is only text).
    const before = draftFor(key)
    if (model && before && (before.name !== table.name || (before.schema ?? '') !== (table.schema ?? ''))) {
      const follow = (draft: DesignTable) => {
        let touched = false
        const foreignKeys = draft.foreignKeys.map((f) => {
          if (f.refTable !== before.name || (f.refSchema ?? draft.schema ?? '') !== (before.schema ?? '')) return f
          touched = true
          return { ...f, refTable: table.name, refSchema: table.schema }
        })
        return touched ? { ...draft, foreignKeys } : draft
      }
      next[key] = follow(table)
      for (const d of display) {
        if (d.key === key) continue
        const draft = next[d.key] ?? draftFor(d.key)
        if (!draft) continue
        const followed = follow(draft)
        if (followed !== draft) next[d.key] = followed
      }
    }
    setDrafts(next)
  }
  const designWithAi = async () => {
    const request = await askText({
      title: tr('Design with AI'),
      message: tr('What should change? E.g. "add soft delete to all customer tables" or "move the address into its own table"'),
      multiline: true,
      confirmLabel: tr('Ask AI'),
    })
    if (!request || !connection) return
    const shown = display.filter((d) => d.status !== 'dropped').map((d) => d.info)
    askAi({
      prompt: tr(
        'Change this {db} database design: {request}\n\nReply with a short explanation and one ```dbml block with only the tables you add or change, each complete (all columns, keys and indexes), using {db} column types. To drop a table, put a line `// drop table name` in the block. I will review it as a migration. Current tables:\n\n```dbml\n{model}```',
        { db: driverLabel(connection.driver), request: request.trim(), model: toDbml(shown, { defaultSchema: schema?.defaultSchema }) },
      ),
      send: true,
    })
  }

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
    // It goes to the right of everything, often off-screen: bring it into view.
    requestAnimationFrame(() => flow.setCenter(center.x + WIDTH / 2, center.y + 120, { zoom: Math.max(flow.getZoom(), 0.8), duration: 300 }))
  }
  /** Tables taken out of the model: new ones disappear, the others are marked dropped (their panel keeps them again). */
  const dropTables = (keys: string[]) => {
    const next = { ...drafts }
    for (const key of keys) {
      const draft = draftFor(key)
      if (!draft) continue
      if (!draft.originalName) delete next[key]
      else next[key] = { ...draft, dropped: true }
    }
    setDesign(true)
    setDrafts(next)
    if (selected && keys.includes(selected) && !next[selected]) setSelected(null)
  }
  /** A copy of a table under a free name next to it: columns, keys, indexes and checks; its relationships too. */
  const duplicateTable = (key: string) => {
    const from = draftFor(key)
    if (!from) return
    const taken = new Set(display.map((d) => d.info.name.toLowerCase()))
    let name = `${from.name}_copy`
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${from.name}_copy${n}`
    const id = designId('new')
    const at = nodes.find((x) => x.id === key)?.position ?? { x: 0, y: 0 }
    updateDraft(id, {
      ...from,
      id,
      name,
      originalName: undefined,
      dropped: false,
      columns: from.columns.map((c) => ({ ...c, id: designId('c'), originalName: undefined })),
      // (Named keys and indexes would repeat the original's names: the copy's are left to the database.)
      foreignKeys: from.foreignKeys.map((f) => ({ ...f, id: designId('f'), originalName: undefined, name: undefined })),
      indexes: from.indexes.map((i) => ({ ...i, id: designId('i'), originalName: undefined, name: undefined })),
      checks: from.checks?.map((c) => ({ ...c, name: undefined })),
      position: { x: at.x + 54, y: at.y + 54 },
    })
    setDesign(true)
    setSelected(id)
  }
  // A request from the object browser: show the table (selected, in the middle), or open a dialog.
  useEffect(() => {
    if (!request) return
    const target = nodes.find((n) => n.id === request.key)
    if (request.kind === 'locate') {
      if (!target) return
      setNodes((list) => list.map((n) => (n.selected !== (n.id === request.key) ? { ...n, selected: n.id === request.key } : n)))
      flow.setCenter(target.position.x + WIDTH / 2, target.position.y + 80, { zoom: Math.max(flow.getZoom(), 0.8), duration: 300 })
      return
    }
    if (!model || !onApplyModel) return
    const draft = draftFor(request.key)
    if (!draft) return
    setDesign(true)
    if (request.kind === 'table') return setDialog({ kind: 'table', key: request.key, table: draft })
    const at = designToTableInfo(draft).foreignKeys.findIndex((f) => f.name === request.fk)
    const fk = at >= 0 ? draft.foreignKeys[at] : undefined
    if (fk) setDialog({ kind: 'relationship', key: request.key, fk: fk.id, table: draft })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.n])
  /** Lines the selected tables up on their left or top edge, or spreads them evenly. */
  const arrange = (how: 'left' | 'top' | 'spread-x' | 'spread-y') => {
    const picked = nodes.filter((n) => n.selected && !isNote(n.id))
    if (picked.length < 2) return
    const size = (n: (typeof picked)[number]) => ({ w: n.measured?.width ?? WIDTH, h: n.measured?.height ?? 120 })
    const moved = new Map<string, { x: number; y: number }>()
    if (how === 'left') {
      const x = Math.min(...picked.map((n) => n.position.x))
      for (const n of picked) moved.set(n.id, { x, y: n.position.y })
    } else if (how === 'top') {
      const y = Math.min(...picked.map((n) => n.position.y))
      for (const n of picked) moved.set(n.id, { x: n.position.x, y })
    } else {
      // Equal gaps between neighbours, the outer two stay where they are.
      const axis = how === 'spread-x' ? 'x' : 'y'
      const sorted = [...picked].sort((a, b) => a.position[axis] - b.position[axis])
      const extent = (n: (typeof picked)[number]) => (axis === 'x' ? size(n).w : size(n).h)
      const first = sorted[0]!
      const last = sorted.at(-1)!
      const total = sorted.reduce((sum, n) => sum + extent(n), 0)
      const gap = (last.position[axis] + extent(last) - first.position[axis] - total) / (sorted.length - 1)
      let at = first.position[axis]
      for (const n of sorted) {
        moved.set(n.id, { ...n.position, [axis]: Math.round(at) })
        at += extent(n) + gap
      }
    }
    rememberLayout()
    setNodes((list) => list.map((n) => (moved.has(n.id) ? { ...n, position: moved.get(n.id)! } : n)))
    const positions = { ...currentPositions(), ...(tab.positions ?? {}) }
    for (const [id, p] of moved) {
      if (drafts[id] && !drafts[id]!.originalName) continue
      positions[id] = p
    }
    patchLayout({ positions })
    const fresh = Object.fromEntries([...moved].filter(([id]) => drafts[id] && !drafts[id]!.originalName).map(([id, p]) => [id, { ...drafts[id]!, position: p }]))
    if (Object.keys(fresh).length) setDrafts({ ...drafts, ...fresh })
  }
  const selectedCount = nodes.filter((n) => n.selected && !isNote(n.id)).length
  const onConnect = (c: { source: string | null; target: string | null; sourceHandle?: string | null; targetHandle?: string | null }) => {
    if (!design || !c.source || !c.target) return
    const from = draftFor(c.source)
    const to = display.find((d) => d.key === c.target)?.info
    if (!from || !to) return
    if (c.sourceHandle === 's-*') {
      // From the table itself: its key to the other table is made here, a column for each column of that table's
      // primary key. One that is already there under the name is the key (as DeZign reuses it).
      if (!to.primaryKey.length) return toast({ kind: 'warning', message: tr('{table} has no primary key to point at', { table: to.name }) })
      const columns = [...from.columns]
      const names = to.primaryKey.map((pk) => {
        const key = to.columns.find((x) => x.name === pk)!
        const plain = pk.toLowerCase() === 'id' || from.columns.some((x) => x.name.toLowerCase() === pk.toLowerCase() && from.primaryKey.includes(x.name) && from.name !== to.name) ? `${to.name}_${pk}` : pk
        const name = from.name === to.name ? `parent_${pk}` : plain
        if (!columns.some((x) => x.name.toLowerCase() === name.toLowerCase())) {
          const dataType = /^bigserial$/i.test(key.dataType) ? 'bigint' : /^(small)?serial$/i.test(key.dataType) ? 'integer' : key.dataType
          columns.push({ id: designId('c'), name, dataType, nullable: true, ...(key.domain ? { domain: key.domain } : {}) })
        }
        return columns.find((x) => x.name.toLowerCase() === name.toLowerCase())!.name
      })
      updateDraft(c.source, { ...from, columns, foreignKeys: [...from.foreignKeys, { id: designId('f'), columns: names, refSchema: to.schema, refTable: to.name, refColumns: [...to.primaryKey] }] })
      return toast({ kind: 'info', message: tr('Foreign key {from} → {to} added to the design', { from: `${from.name}.${names.join(', ')}`, to: `${to.name}.${to.primaryKey.join(', ')}` }) })
    }
    const column = c.sourceHandle?.replace(/^s-/, '') ?? ''
    const dropped = c.targetHandle?.replace(/^t-/, '')
    const refColumn = (dropped === '*' ? undefined : dropped) ?? to.primaryKey[0] ?? ''
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
      if (!tab.tables.includes(keyOf(t))) patchLayout({ tables: [...tab.tables, keyOf(t)] })
    } else setFocusName(t.name)
    setSearch('')
  }

  const addRelated = (t: TableInfo) => {
    if (!schema || !tab.tables) return
    const keys = neighbourhood(schema, t, 1)
    patchLayout({ tables: [...new Set([...tab.tables, ...keys])] })
  }

  const currentPositions = () => Object.fromEntries(nodes.map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }]))

  // Sticky notes live in their own node list so table re-layouts never drop them.
  const [noteNodes, setNoteNodes, onNoteNodesChange] = useNodesState<Node<NoteNodeData>>([])
  const latestBoxes = useRef(tab.boxes)
  latestBoxes.current = tab.boxes
  const setBoxes = (boxes: NonNullable<DiagramTab['boxes']>) => patchLayout({ boxes })
  // Their ids start like a note's, so nothing that acts on tables takes them for one.
  const boxNodes = useMemo(
    () =>
      (tab.boxes ?? []).map((box) => ({
        id: `note:box:${box.id}`,
        type: 'box',
        position: { x: box.x, y: box.y },
        data: { title: box.title, w: box.w, h: box.h, onResize: (w: number, h: number) => setBoxes((latestBoxes.current ?? []).map((x) => (x.id === box.id ? { ...x, w, h } : x))) },
        dragHandle: '.dbm-box-handle',
        selectable: false,
        focusable: false,
        zIndex: -1,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab.boxes],
  )
  // Dragged frames show where they are going until the drop saves the place.
  const [boxDrag, setBoxDrag] = useState<{ id: string; x: number; y: number } | null>(null)
  const addBox = async () => {
    const title = await askText({ title: tr('New frame'), message: tr('A frame groups tables on the diagram (DeZign: group box). Drag it by its caption, resize it at its corner.'), confirmLabel: tr('Add') })
    if (!title) return
    const center = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
    setBoxes([...(tab.boxes ?? []), { id: uid('box'), title, x: Math.round(center.x - 200), y: Math.round(center.y - 150), w: 400, h: 300 }])
  }
  const latestNotes = useRef(tab.notes)
  latestNotes.current = tab.notes
  const setNotes = (notes: DiagramNote[]) => patchLayout({ notes: notes.length ? notes : undefined })
  const newNote = useRef<string | null>(null)
  useEffect(() => {
    setNoteNodes(
      (tab.notes ?? []).map((note) => ({
        id: `note:${note.id}`,
        type: 'note',
        position: { x: note.x, y: note.y },
        data: {
          text: note.text,
          autoFocus: newNote.current === note.id,
          onChange: (text: string) => setNotes((latestNotes.current ?? []).map((x) => (x.id === note.id ? { ...x, text } : x))),
          onDelete: () => setNotes((latestNotes.current ?? []).filter((x) => x.id !== note.id)),
        },
      })),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.notes])
  const addNote = () => {
    const center = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
    const id = uid('n')
    newNote.current = id
    setNotes([...(tab.notes ?? []), { id, text: '', x: Math.round(center.x), y: Math.round(center.y) }])
  }

  const saveAs = async (name: string) => {
    const tables = liveTables.map(keyOf)
    const d = await api.saveDiagram({ connectionId: tab.connectionId, name, tables, positions: currentPositions(), colors: tab.colors, notes: tab.notes })
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
      void api.saveDiagram({ id: tab.savedId, connectionId: tab.connectionId, name: tab.title, tables: tab.tables!, positions: { ...currentPositions(), ...tab.positions }, colors: tab.colors, notes: tab.notes })
    }, 600)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.savedId, tab.tables, tab.positions, tab.colors, tab.notes])

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
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-2 py-1 whitespace-nowrap">
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
              {schema.schemas.filter((s) => visibleSchemas.includes(s) || s === schemaFilter).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
              <option value="*">{tr('All schemas')}</option>
            </Select>
          )
        )}
        <Select
          inputSize="sm"
          className="h-7 w-auto text-[12px]"
          value={shownAs.columns}
          onChange={(e) => patchLayout({ display: { ...shownAs, columns: e.target.value as DezignColumnsShown } })}
          title={tr('Which columns the tables show')}
          data-testid="diagram-columns"
        >
          <option value="all">{tr('All columns')}</option>
          <option value="keys">{tr('Keys only')}</option>
          <option value="primary">{tr('Primary keys')}</option>
          <option value="first10">{tr('First 10 columns')}</option>
          <option value="first20">{tr('First 20 columns')}</option>
          <option value="none">{tr('Table names only')}</option>
        </Select>
        <Checkbox checked={shownAs.types !== 'none'} onChange={(on) => patchLayout({ display: { ...shownAs, types: on ? 'type' : 'none' } })} label={tr('Types')} />
        {!design && (
          <span className="shrink-0 text-[11.5px] text-fg-faint">
            {tp(tables.length, { one: '{n} table', many: '{n} tables' })} · {tp(edges.length, { one: '{n} relationship', many: '{n} relationships' })}
          </span>
        )}
        {/* The view actions wrap as one group when the window is narrow. */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
        {layouting && <Spinner size={13} className="text-fg-faint" />}
        {(!model || onApplyModel) && (
        <Button
          size="sm"
          variant={design ? 'subtle' : 'ghost'}
          icon={<PencilRuler size={13} />}
          onClick={() => {
            setDesign((v) => !v)
            setSelected(null)
          }}
          title={model ? tr('Edit the model visually: tables, columns, keys and indexes') : tr('Design changes to the schema on the diagram and generate a migration script')}
        >
          {design ? tr('Designing') : tr('Design')}
        </Button>
        )}
        <IconButton label={tr('Add a note')} onClick={addNote}>
          <StickyNote size={14} />
        </IconButton>
        <IconButton label={tr('Add a frame')} onClick={() => void addBox()} data-testid="diagram-add-box">
          <SquareDashed size={14} />
        </IconButton>
        <Button size="sm" variant="ghost" icon={<LayoutGrid size={13} />} onClick={resetLayout}>
          {tr('Auto layout')}
        </Button>
        {!model && (
        <Button
          size="sm"
          variant="ghost"
          icon={<Bookmark size={13} />}
          onClick={async (e) => {
            const anchor = e.currentTarget
            const list: SavedDiagram[] = await api.listDiagrams(tab.connectionId)
            openMenu(anchor, [
              { label: tr('Save as new diagram…'), icon: <Plus size={13} />, onClick: () => setNaming(true) },
              ...(useSettings.getState().settings?.teamFolder && tab.savedId && !tab.savedId.startsWith('team:')
                ? [
                    {
                      label: tr('Share with the team folder'),
                      icon: <Users size={13} />,
                      onClick: () =>
                        void api
                          .saveDiagram({ connectionId: tab.connectionId, name: tab.title, tables: tab.tables ?? liveTables.map(keyOf), positions: { ...currentPositions(), ...tab.positions }, colors: tab.colors, notes: tab.notes, team: true })
                          .then(
                            () => toast({ kind: 'success', message: tr('Shared with the team folder') }),
                            (err: unknown) => toast({ kind: 'error', message: tr('Could not share the diagram'), detail: errorMessage(err) }),
                          ),
                    },
                  ]
                : []),
              ...(tab.savedId
                ? [
                    {
                      label: tr('Delete this diagram'),
                      danger: true,
                      onClick: async () => {
                        if (!(await confirmAction({ title: tr('Delete diagram “{name}”?', { name: tab.title }), confirmLabel: tr('Delete'), danger: true }))) return
                        void api.deleteDiagram(tab.savedId!).then(() => {
                          updateTab(tab.id, { savedId: undefined, tables: undefined, title: tr('ER diagram') })
                        })
                      },
                    },
                  ]
                : []),
              ...(list.length ? ['separator' as const] : []),
              ...list.map((d) => ({
                label: d.team ? `${d.name} · ${tr('Team')}` : d.name,
                icon: d.team ? <Users size={13} /> : <Network size={13} />,
                onClick: () => openTab({ kind: 'diagram', connectionId: tab.connectionId, title: d.name, tables: d.tables, positions: d.positions, colors: d.colors, notes: d.notes, savedId: d.id }, { reuse: false }),
              })),
            ])
          }}
        >
          {tab.savedId ? tab.title : tr('Diagrams')}
        </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          icon={<Download size={13} />}
          onClick={(e) =>
            openMenu(e.currentTarget, [
              { label: tr('PNG image'), onClick: () => void exportImage('png') },
              { label: tr('SVG image'), onClick: () => void exportImage('svg') },
              { label: tr('PDF, one page'), onClick: () => void exportPdf('one') },
              { label: tr('PDF, readable size on several pages'), onClick: () => void exportPdf('many') },
              'separator',
              { label: tr('Copy as Mermaid'), onClick: exportMermaid },
              { label: tr('Copy as PlantUML'), onClick: exportPlantUml },
              { label: tr('Copy as DBML (dbdiagram.io)'), onClick: exportDbml },
              ...(model
                ? ['separator' as const, { label: tr('Data dictionary (HTML)…'), onClick: exportDictionary }]
                : [
                    'separator' as const,
                    {
                      label: tr('Edit as model (DBML)…'),
                      icon: <FileCode2 size={13} />,
                      onClick: () => openTab({ kind: 'model', connectionId: tab.connectionId, title: tr('Model'), text: toDbml(tables, { defaultSchema: schema.defaultSchema }) }, { reuse: false }),
                    },
                  ]),
            ])
          }
        >
          {tr('Export')}
        </Button>
        </div>
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
        // The design actions live in this bar (shown only while designing), so the toolbar above keeps room for the
        // view controls at any window width.
        <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-accent-soft px-2 py-1 text-[12px]">
          <PencilRuler size={13} className="ml-1 shrink-0 text-accent" />
          <b className="shrink-0">{tr('Design mode.')}</b>
          <span
            className="min-w-0 flex-1 truncate text-fg-muted"
            title={model
              ? tr('Click a table to edit it, drag from a column dot to another table to add a foreign key. Write to DBML puts the changes into the model text.')
              : tr('Click a table to edit it, drag from a column dot to another table to add a foreign key. Nothing changes in the database until you run the generated migration.')}
          >
            {model
              ? tr('Click a table to edit it, drag from a column dot to another table to add a foreign key. Write to DBML puts the changes into the model text.')
              : tr('Click a table to edit it, drag from a column dot to another table to add a foreign key. Nothing changes in the database until you run the generated migration.')}
          </span>
          <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={addTable}>
            {tr('New table')}
          </Button>
          {!model && (
            <Button size="sm" variant="ghost" icon={<Sparkles size={13} />} onClick={designWithAi} title={tr('Describe a change, e.g. "add soft delete to all customer tables"; the AI proposes it as design changes')}>
              {tr('Design with AI…')}
            </Button>
          )}
          {!model && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Layers size={13} />}
              onClick={async (e) => {
                const anchor = e.currentTarget
                const sets = await api.listChangeSets(tab.connectionId)
                openMenu(anchor, [
                  {
                    label: tr('Save these changes as…'),
                    disabled: !Object.keys(drafts).length,
                    onClick: async () => {
                      const name = await askText({ title: tr('Save these changes as…'), placeholder: tr('Name of the change set'), confirmLabel: tr('Save') })
                      if (!name) return
                      await api.saveChangeSet({ connectionId: tab.connectionId, name, design: drafts })
                      toast({ kind: 'success', message: tr('Change set “{name}” saved', { name }) })
                    },
                  },
                  ...(sets.length ? ['separator' as const] : []),
                  ...sets.map((cs) => ({
                    label: `${cs.name} · ${formatDate(cs.createdAt, 'date')}`,
                    submenu: [
                      {
                        label: tr('Load (replaces the current changes)'),
                        onClick: async () => {
                          if (Object.keys(drafts).length && !(await confirmAction({ title: tr('Replace the current design changes with “{name}”?', { name: cs.name }), confirmLabel: tr('Replace'), danger: true }))) return
                          setSelected(null)
                          setDrafts(cs.design)
                        },
                      },
                      { label: tr('Delete'), danger: true, onClick: () => void api.deleteChangeSet(cs.id) },
                    ],
                  })),
                ])
              }}
            >
              {tr('Change sets')}
            </Button>
          )}
          <IconButton label={`${tr('Undo')} (${keys('⌘Z')})`} disabled={!history.current.past.length} onClick={undoDesign}>
            <Undo size={14} />
          </IconButton>
          <IconButton label={`${tr('Redo')} (${keys('⇧⌘Z')})`} disabled={!history.current.future.length} onClick={redoDesign}>
            <Redo size={14} />
          </IconButton>
          {Object.keys(drafts).length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Undo2 size={13} />}
              onClick={async () => {
                if (await confirmAction({ title: tr('Discard all design changes?'), confirmLabel: tr('Discard'), danger: true })) {
                  setDrafts({})
                  setSelected(null)
                }
              }}
            >
              {tr('Discard')}
            </Button>
          )}
          {model && onApplyModel ? (
            <Button
              size="sm"
              variant={pending ? 'primary' : 'secondary'}
              icon={<FileCode2 size={13} />}
              disabled={!pending}
              title={tr('Write the tables on the canvas to the DBML text')}
              onClick={() => {
                // The whole model goes back: tables the canvas doesn't show now (another schema, a focus, past the
                // first 400) stay as they are and where they are, never left out.
                const shown = new Map(display.map((d) => [d.key, d]))
                const whole: TableInfo[] = []
                for (const t of schema?.tables ?? []) {
                  const d = shown.get(keyOf(t))
                  if (!d) whole.push(t)
                  else if (d.status !== 'dropped') whole.push(d.info)
                }
                for (const d of display) if (d.status === 'new') whole.push(d.info)
                onApplyModel(whole)
                history.current = { past: [], future: [], at: 0 }
                setSelected(null)
                setDrafts({}, false)
              }}
            >
              {tr('Write to DBML')}{pending ? ` (${pending})` : ''}
            </Button>
          ) : (
            <Button size="sm" variant={changes.length ? 'primary' : 'secondary'} icon={<FileCode2 size={13} />} disabled={!changes.length} onClick={() => setReviewOpen(true)}>
              {tr('Review migration')}{changes.length ? ` (${changes.length})` : ''}
            </Button>
          )}
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
          nodes={[...(boxNodes.map((b) => (boxDrag?.id === b.id ? { ...b, position: { x: boxDrag.x, y: boxDrag.y } } : b)) as unknown as typeof nodes), ...nodes, ...(noteNodes as unknown as typeof nodes)]}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={(changes) => {
            const forNote = (c: (typeof changes)[number]) => 'id' in c && isNote(c.id)
            // Delete / Backspace on tables: in a model being designed they are dropped (and can be kept again in
            // their panel); otherwise the key does nothing to a table (it used to hide it from the canvas only).
            const removed = changes.filter((c) => c.type === 'remove' && !isNote(c.id)).map((c) => (c as { id: string }).id)
            if (removed.length && model && design) dropTables(removed)
            changes = changes.filter((c) => !(c.type === 'remove' && !isNote(c.id)))
            onNodesChange(changes.filter((c) => !forNote(c)) as Parameters<typeof onNodesChange>[0])
            onNoteNodesChange(changes.filter(forNote) as Parameters<typeof onNoteNodesChange>[0])
          }}
          onConnect={onConnect}
          nodesConnectable={design}
          onNodeClick={(_, n) => {
            if (!design || isNote(n.id)) return
            setFocusFk(undefined)
            setSelected(n.id)
          }}
          onEdgeClick={(_, edge) => {
            // A relationship: the child table's panel with its foreign key (a model opens the designer for it).
            if (!design && !model) return
            if (!design) setDesign(true)
            setSelected(edge.source)
            setFocusFk(edge.id.slice(edge.source.length + 1))
          }}
          onEdgeDoubleClick={(_, edge) => {
            if (!model || !onApplyModel) return
            const draft = draftFor(edge.source)
            const name = edge.id.slice(edge.source.length + 1)
            const info = draft && designToTableInfo(draft)
            // The edge is named as the table info names the key (a generated name for an unnamed one).
            const at = info?.foreignKeys.findIndex((f) => f.name === name) ?? -1
            const fk = draft && at >= 0 ? draft.foreignKeys[at] : undefined
            if (!fk || !draft) return
            setDesign(true)
            setDialog({ kind: 'relationship', key: edge.source, fk: fk.id, table: draft })
          }}
          onPaneClick={() => {
            setSelected(null)
            setFocusFk(undefined)
          }}
          snapToGrid
          snapGrid={[18, 18]}
          deleteKeyCode={['Backspace', 'Delete']}
          onNodeMouseEnter={(_, n) => !isNote(n.id) && setHovered(n.id)}
          onNodeMouseLeave={() => setHovered(null)}
          onNodeDrag={(_, node) => node.id.startsWith('note:box:') && setBoxDrag({ id: node.id, x: node.position.x, y: node.position.y })}
          onNodeDragStop={(_, node) => {
            if (node.id.startsWith('note:box:')) {
              setBoxDrag(null)
              setBoxes((tab.boxes ?? []).map((x) => (`note:box:${x.id}` === node.id ? { ...x, x: Math.round(node.position.x), y: Math.round(node.position.y) } : x)))
              return
            }
            if (isNote(node.id)) {
              setNotes((tab.notes ?? []).map((x) => (`note:${x.id}` === node.id ? { ...x, x: Math.round(node.position.x), y: Math.round(node.position.y) } : x)))
              return
            }
            if (drafts[node.id] && !drafts[node.id]!.originalName) {
              updateDraft(node.id, { ...drafts[node.id]!, position: node.position })
              return
            }
            // Pin the whole layout, not just this table: otherwise the others come back from the "new tables go in
            // a column" rule after a restart instead of where they were.
            if (design) rememberLayout()
            const positions = { ...currentPositions(), ...(tab.positions ?? {}), [node.id]: node.position }
            patchLayout({ positions })
          }}
          onNodeDoubleClick={(_, n) => {
            if (isNote(n.id)) return
            // In a model, as in DeZign: the table's properties. In a database: its data.
            if (model && onApplyModel) {
              const table = draftFor(n.id)
              setDesign(true)
              if (table) setDialog({ kind: 'table', key: n.id, table })
              return
            }
            openTab({ kind: 'table', connectionId: tab.connectionId, table: { schema: n.data.table.schema, name: n.data.table.name }, title: n.data.table.name })
          }}
          onNodeContextMenu={(e, n) =>
            n.id.startsWith('note:box:')
              ? openMenu(e, [
                  {
                    label: tr('Rename frame…'),
                    onClick: async () => {
                      const box = tab.boxes?.find((x) => `note:box:${x.id}` === n.id)
                      const title = box && (await askText({ title: tr('Rename frame'), value: box.title, confirmLabel: tr('Rename') }))
                      if (box && title) setBoxes((tab.boxes ?? []).map((x) => (x.id === box.id ? { ...x, title } : x)))
                    },
                  },
                  { label: tr('Remove frame'), onClick: () => setBoxes((tab.boxes ?? []).filter((x) => `note:box:${x.id}` !== n.id)) },
                ])
              : !isNote(n.id) &&
            openMenu(e, [
              // (A model without a database has no data to open.)
              ...(connection
                ? [
                    { label: tr('Open data'), icon: <Table2 size={13} />, onClick: () => openTab({ kind: 'table', connectionId: tab.connectionId, table: { schema: n.data.table.schema, name: n.data.table.name }, title: n.data.table.name }) },
                    { label: tr('Open structure'), onClick: () => openTab({ kind: 'structure', connectionId: tab.connectionId, table: { schema: n.data.table.schema, name: n.data.table.name }, title: tr('{name} · structure', { name: n.data.table.name }) }) },
                  ]
                : []),
              { label: tr('Focus here'), icon: <Network size={13} />, onClick: () => setFocusName(n.data.table.name) },
              ...(model && onApplyModel
                ? [
                    'separator' as const,
                    { label: tr('Properties…'), icon: <PencilRuler size={13} />, onClick: () => { const table = draftFor(n.id); setDesign(true); if (table) setDialog({ kind: 'table', key: n.id, table }) } },
                    { label: tr('Duplicate table'), icon: <Copy size={13} />, onClick: () => duplicateTable(n.id) },
                    { label: tr('Delete table'), icon: <Trash2 size={13} />, onClick: () => dropTables([n.id]) },
                    'separator' as const,
                  ]
                : []),
              {
                label: tr('Color'),
                submenu: [
                  { label: tr('Default'), checked: !tab.colors?.[n.id], onClick: () => patchLayout({ colors: Object.fromEntries(Object.entries(tab.colors ?? {}).filter(([k]) => k !== n.id)) }) },
                  ...COLOR_NAMES.map((name, i) => ({
                    label: tr(name),
                    icon: <span className="block h-3 w-3 rounded-sm" style={{ background: `color-mix(in srgb, var(--series-${i + 1}) 78%, black)` }} />,
                    checked: tab.colors?.[n.id] === i + 1,
                    onClick: () => patchLayout({ colors: { ...tab.colors, [n.id]: i + 1 } }),
                  })),
                ],
              },
              {
                // Columns hidden in this table's box on this diagram (DeZign: Show/hide attributes).
                label: tr('Columns shown'),
                submenu: [
                  { label: tr('Show all columns'), checked: !shownAs.hidden?.[n.id]?.length, onClick: () => patchLayout({ display: { ...shownAs, hidden: { ...shownAs.hidden, [n.id]: [] } } }) },
                  'separator' as const,
                  ...n.data.table.columns.map((c) => {
                    const hidden = shownAs.hidden?.[n.id] ?? []
                    const on = !hidden.includes(c.name)
                    return { label: c.name, checked: on, onClick: () => patchLayout({ display: { ...shownAs, hidden: { ...shownAs.hidden, [n.id]: on ? [...hidden, c.name] : hidden.filter((x) => x !== c.name) } } }) }
                  }),
                ],
              },
              ...(tab.tables && !focusName
                ? [
                    'separator' as const,
                    { label: tr('Add related tables'), icon: <Plus size={13} />, onClick: () => addRelated(n.data.table) },
                    { label: tr('Remove from diagram'), onClick: () => patchLayout({ tables: tab.tables!.filter((k) => k !== keyOf(n.data.table)) }) },
                  ]
                : []),
            ])
          }
          colorMode={dark ? 'dark' : 'light'}
          minZoom={0.05}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          onlyRenderVisibleElements={tables.length > 80}
          defaultEdgeOptions={{ markerEnd: { type: MarkerType.Arrow } }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--border-strong)" />
          <Controls showInteractive={false} />
          {selectedCount >= 2 && (
            // Several tables selected (Shift-drag a box, or ⌘-click): line them up or spread them evenly.
            <Panel position="top-center" className="flex items-center gap-0.5 rounded-lg border border-line bg-elevated px-1.5 py-1 shadow-md" data-testid="arrange-bar">
              <span className="px-1.5 text-[11.5px] whitespace-nowrap text-fg-muted">{tr('{n} tables', { n: String(selectedCount) })}</span>
              <IconButton label={tr('Align left edges')} onClick={() => arrange('left')} data-testid="align-left">
                <AlignHorizontalJustifyStart size={14} />
              </IconButton>
              <IconButton label={tr('Align top edges')} onClick={() => arrange('top')} data-testid="align-top">
                <AlignVerticalJustifyStart size={14} />
              </IconButton>
              <IconButton label={tr('Spread evenly across')} onClick={() => arrange('spread-x')} data-testid="spread-x">
                <AlignHorizontalSpaceAround size={14} />
              </IconButton>
              <IconButton label={tr('Spread evenly down')} onClick={() => arrange('spread-y')} data-testid="spread-y">
                <AlignVerticalSpaceAround size={14} />
              </IconButton>
              {model && design && onApplyModel && (
                <IconButton label={tr('Delete the selected tables')} onClick={() => dropTables(nodes.filter((n) => n.selected && !isNote(n.id)).map((n) => n.id))} data-testid="delete-selected">
                  <Trash2 size={14} />
                </IconButton>
              )}
            </Panel>
          )}
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
      {design && selected && selectedDraft && editorDriver && (
        <TableEditor
          key={selected}
          table={selectedDraft}
          driver={editorDriver}
          allTables={tables}
          model={!!model}
          domains={domains}
          onChange={(t) => updateDraft(selected, t)}
          focusForeignKey={focusFk}
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
      {dialog?.kind === 'table' && editorDriver && (
        <TableDialog
          key={dialog.key}
          table={dialog.table}
          driver={editorDriver}
          allTables={tables}
          domains={domains}
          onApply={(t) => {
            updateDraft(dialog.key, t)
            setDialog(null)
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'relationship' && (
        <RelationshipDialog
          key={`${dialog.key}:${dialog.fk}`}
          child={dialog.table}
          foreignKey={dialog.fk}
          allTables={tables}
          onApply={(t) => {
            updateDraft(dialog.key, t)
            setDialog(null)
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {connection && schema && (
        <MigrationModal
          open={reviewOpen}
          onClose={() => setReviewOpen(false)}
          changes={changes}
          driver={connection.driver}
          tables={schema.tables}
          connectionId={tab.connectionId}
          onOpenInEditor={(sql, targetId) => {
            setReviewOpen(false)
            newQuery(targetId ?? tab.connectionId, sql, tr('Migration'))
          }}
        />
      )}
    </div>
  )
}

export function DiagramView({ tab, model, modelDriver, domains, dashNonIdentifying, request, onApplyModel, onLayout }: { tab: DiagramTab; model?: SchemaSnapshot; /** The database a model without a connection is written for (the table editor offers its types). */ modelDriver?: DriverId; /** The project's domains, offered for columns. */ domains?: { name: string; dataType: string }[]; /** Lines of relationships whose key is not part of the child's primary key are dashed, as DeZign draws them. */ dashNonIdentifying?: boolean; /** From the model's object browser: show a table, or open a table's or a relationship's dialog. */ request?: DiagramRequest; onApplyModel?: (tables: TableInfo[]) => void; /** Takes over storing positions, notes and colors (a model's named diagram keeps its own). */ onLayout?: (patch: Partial<Pick<DiagramTab, 'positions' | 'notes' | 'colors' | 'tables' | 'display' | 'boxes'>>) => void }) {
  return (
    <ReactFlowProvider>
      <DiagramInner tab={tab} model={model} modelDriver={modelDriver} domains={domains} dashNonIdentifying={dashNonIdentifying} request={request} onApplyModel={onApplyModel} onLayout={onLayout} />
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

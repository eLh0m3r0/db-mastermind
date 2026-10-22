import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp, ArrowUpRight, KeyRound, Link2 } from 'lucide-react'
import { cellToText, isBinaryValue, type CellValue, type ResultField, type SortSpec } from '@dbmastermind/core/browser'
import { cn } from '@/lib/utils'
import { t } from '@/lib/i18n'

export const ROW_HEIGHT = 26
const HEADER_HEIGHT = 30
const MIN_COL = 48
const MAX_AUTO_COL = 360
const ROW_HEADER_MIN = 44

export interface GridColumnMeta {
  dataType?: string
  isPrimaryKey?: boolean
  /** Foreign key target, shown as a link icon in cells. */
  foreignKey?: string
  comment?: string | null
  nullable?: boolean
}

export interface CellPos {
  row: number
  col: number
}

export interface GridSelection {
  anchor: CellPos
  focus: CellPos
}

export type RowState = 'inserted' | 'deleted' | undefined

export interface DataGridHandle {
  focus(): void
  getSelection(): GridSelection | null
  selectCell(pos: CellPos): void
  scrollToRow(row: number): void
  /** Opens the inline editor on the focused cell. */
  edit(): void
}

export interface DataGridProps {
  fields: ResultField[]
  rows: CellValue[][]
  columnMeta?: (GridColumnMeta | undefined)[]
  /** Row number shown in the gutter for row 0 (pagination offset). */
  rowNumberOffset?: number
  sort?: SortSpec[]
  onSortChange?: (sort: SortSpec[]) => void
  /** When set, cells can be edited; receives the new raw text or null. */
  onEdit?: (row: number, col: number, value: string | null) => void
  isCellEdited?: (row: number, col: number) => boolean
  rowState?: (row: number) => RowState
  onContextMenu?: (event: React.MouseEvent, pos: CellPos | null, selection: GridSelection | null) => void
  onCellActivate?: (pos: CellPos) => void
  onForeignKeyClick?: (pos: CellPos) => void
  onSelectionChange?: (selection: GridSelection | null) => void
  nullDisplay?: string
  /** Remembered column widths (by field name). */
  columnWidths?: Record<string, number>
  onColumnWidthsChange?: (widths: Record<string, number>) => void
  emptyMessage?: string
  className?: string
  ref?: Ref<DataGridHandle>
}

const numericType = /(int|serial|numeric|decimal|float|double|real|money|number|longlong|newdecimal|tiny|short|long)/i

function isNumericColumn(field: ResultField, meta: GridColumnMeta | undefined, sample: CellValue | undefined): boolean {
  const t = meta?.dataType ?? field.dataType
  if (t) return numericType.test(t) && !/interval|point/i.test(t)
  return typeof sample === 'number'
}

function estimateWidth(field: ResultField, rows: CellValue[][], col: number, dataType?: string): number {
  // Header shows the name, the type and the sort indicator.
  let max = field.name.length * 7.6 + Math.min((dataType ?? field.dataType ?? '').length, 18) * 6 + 44
  const n = Math.min(rows.length, 60)
  for (let i = 0; i < n; i++) {
    const v = rows[i]?.[col]
    const len = v === null || v === undefined ? 4 : Math.min(cellToText(v).length, 80)
    max = Math.max(max, len * 7.2 + 20)
  }
  return Math.round(Math.min(MAX_AUTO_COL, Math.max(MIN_COL + 20, max)))
}

function normalize(sel: GridSelection) {
  return {
    r0: Math.min(sel.anchor.row, sel.focus.row),
    r1: Math.max(sel.anchor.row, sel.focus.row),
    c0: Math.min(sel.anchor.col, sel.focus.col),
    c1: Math.max(sel.anchor.col, sel.focus.col),
  }
}

export function selectionBounds(sel: GridSelection) {
  return normalize(sel)
}

/** Tab-separated text of the selection; with header row when requested. Pastes cleanly into Excel. */
export function selectionToTsv(fields: ResultField[], rows: CellValue[][], sel: GridSelection, withHeader = false, nullText = ''): string {
  const { r0, r1, c0, c1 } = normalize(sel)
  const esc = (v: string) => (/[\t\n\r"]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v)
  const lines: string[] = []
  if (withHeader) lines.push(fields.slice(c0, c1 + 1).map((f) => esc(f.name)).join('\t'))
  for (let r = r0; r <= r1; r++) {
    const row = rows[r]
    if (!row) continue
    const cells: string[] = []
    for (let c = c0; c <= c1; c++) {
      const v = row[c] ?? null
      cells.push(v === null ? nullText : esc(cellToText(v)))
    }
    lines.push(cells.join('\t'))
  }
  return lines.join('\n')
}

const Cell = memo(function Cell({
  value,
  width,
  left,
  numeric,
  selected,
  focused,
  edited,
  fk,
  nullDisplay,
  onFkClick,
}: {
  value: CellValue
  width: number
  left: number
  numeric: boolean
  selected: boolean
  focused: boolean
  edited: boolean
  fk: boolean
  nullDisplay: string
  onFkClick?: () => void
}) {
  let content: React.ReactNode
  if (value === null || value === undefined) {
    content = <span className="text-null italic">{nullDisplay}</span>
  } else if (typeof value === 'boolean') {
    content = <span className={value ? 'text-success' : 'text-fg-muted'}>{String(value)}</span>
  } else if (isBinaryValue(value)) {
    content = <span className="text-fg-muted">{`0x${value.$binary.slice(0, 40)}${value.length > 20 ? '…' : ''}`}</span>
  } else {
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
    // Multi-line text collapses into one line in the grid.
    content = text.length > 400 ? `${text.slice(0, 400).replace(/\s+/g, ' ')}…` : text.replace(/[\r\n]+/g, ' ↵ ')
  }
  return (
    <div
      className={cn(
        'absolute top-0 flex h-full items-center overflow-hidden border-r border-b border-line px-2 whitespace-nowrap',
        numeric && 'justify-end font-mono text-[12px] tabular-nums',
        !numeric && 'font-mono text-[12px]',
        edited && 'bg-[var(--grid-edited)]',
        selected && 'bg-[var(--grid-selected)]',
        focused && 'outline-2 -outline-offset-2 outline-accent',
      )}
      style={{ left, width }}
    >
      <span className="min-w-0 truncate">{content}</span>
      {fk && value !== null && onFkClick && (
        <button
          type="button"
          tabIndex={-1}
          title={t('Open referenced row')}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onFkClick()
          }}
          className="ml-1 shrink-0 rounded text-fg-faint opacity-60 hover:bg-accent-soft hover:text-accent hover:opacity-100"
        >
          <ArrowUpRight size={13} />
        </button>
      )}
    </div>
  )
})

export function DataGrid({
  fields,
  rows,
  columnMeta,
  rowNumberOffset = 0,
  sort,
  onSortChange,
  onEdit,
  isCellEdited,
  rowState,
  onContextMenu,
  onCellActivate,
  onForeignKeyClick,
  onSelectionChange,
  nullDisplay = 'NULL',
  columnWidths,
  onColumnWidthsChange,
  emptyMessage,
  className,
  ref,
}: DataGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [selection, setSelectionState] = useState<GridSelection | null>(null)
  const [editing, setEditing] = useState<{ pos: CellPos; value: string } | null>(null)
  const dragging = useRef(false)

  const setSelection = useCallback(
    (sel: GridSelection | null) => {
      setSelectionState(sel)
      onSelectionChange?.(sel)
    },
    [onSelectionChange],
  )

  // Column widths: remembered → measured.
  const [widths, setWidths] = useState<number[]>([])
  const fieldsKey = fields.map((f) => f.name).join('\u0000')
  useLayoutEffect(() => {
    setWidths(fields.map((f, i) => columnWidths?.[f.name] ?? estimateWidth(f, rows, i, columnMeta?.[i]?.dataType)))
    // Only re-measure when the column set changes, not on every page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldsKey])

  // Keep the selection inside bounds when data changes.
  useEffect(() => {
    setSelectionState((sel) => {
      if (!sel) return sel
      const maxRow = rows.length - 1
      const maxCol = fields.length - 1
      if (maxRow < 0 || maxCol < 0) return null
      const clamp = (p: CellPos) => ({ row: Math.min(p.row, maxRow), col: Math.min(p.col, maxCol) })
      return { anchor: clamp(sel.anchor), focus: clamp(sel.focus) }
    })
  }, [rows.length, fields.length])

  const rowHeaderWidth = Math.max(ROW_HEADER_MIN, String(rowNumberOffset + rows.length).length * 8 + 18)
  const offsets = useMemo(() => {
    const out: number[] = []
    let x = rowHeaderWidth
    for (const w of widths) {
      out.push(x)
      x += w
    }
    out.push(x)
    return out
  }, [widths, rowHeaderWidth])
  const totalWidth = offsets[offsets.length - 1] ?? rowHeaderWidth

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    paddingStart: HEADER_HEIGHT,
  })
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: fields.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => widths[i] ?? 120,
    overscan: 4,
    paddingStart: rowHeaderWidth,
  })
  useEffect(() => colVirtualizer.measure(), [widths, colVirtualizer])

  const numeric = useMemo(
    () => fields.map((f, i) => isNumericColumn(f, columnMeta?.[i], rows.find((r) => r[i] !== null)?.[i])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fieldsKey, columnMeta, rows.length > 0],
  )

  const scrollIntoView = useCallback(
    (pos: CellPos) => {
      const el = scrollRef.current
      if (!el) return
      const top = HEADER_HEIGHT + pos.row * ROW_HEIGHT
      if (top - HEADER_HEIGHT < el.scrollTop) el.scrollTop = top - HEADER_HEIGHT
      else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight
      const left = offsets[pos.col] ?? 0
      const right = offsets[pos.col + 1] ?? left
      if (left - rowHeaderWidth < el.scrollLeft) el.scrollLeft = left - rowHeaderWidth
      else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth
    },
    [offsets, rowHeaderWidth],
  )

  const startEdit = useCallback(
    (pos: CellPos, initial?: string) => {
      if (!onEdit) return
      if (rowState?.(pos.row) === 'deleted') return
      const v = rows[pos.row]?.[pos.col] ?? null
      if (isBinaryValue(v)) return
      setEditing({ pos, value: initial ?? (v === null ? '' : cellToText(v)) })
    },
    [onEdit, rows, rowState],
  )

  useImperativeHandle(
    ref,
    () => ({
      focus: () => scrollRef.current?.focus(),
      getSelection: () => selection,
      selectCell: (pos) => {
        setSelection({ anchor: pos, focus: pos })
        scrollIntoView(pos)
      },
      scrollToRow: (row) => rowVirtualizer.scrollToIndex(row),
      edit: () => selection && startEdit(selection.focus),
    }),
    [selection, setSelection, scrollIntoView, rowVirtualizer, startEdit],
  )

  const commitEdit = useCallback(
    (value: string | null, move?: 'down' | 'right' | 'left') => {
      if (!editing || !onEdit) return
      const original = rows[editing.pos.row]?.[editing.pos.col] ?? null
      const originalText = original === null ? null : cellToText(original)
      if (value !== originalText) onEdit(editing.pos.row, editing.pos.col, value)
      const pos = editing.pos
      setEditing(null)
      let next = pos
      if (move === 'down') next = { row: Math.min(rows.length - 1, pos.row + 1), col: pos.col }
      if (move === 'right') next = { row: pos.row, col: Math.min(fields.length - 1, pos.col + 1) }
      if (move === 'left') next = { row: pos.row, col: Math.max(0, pos.col - 1) }
      setSelection({ anchor: next, focus: next })
      scrollIntoView(next)
      requestAnimationFrame(() => scrollRef.current?.focus())
    },
    [editing, onEdit, rows, fields.length, setSelection, scrollIntoView],
  )

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return
    if (rows.length === 0 || fields.length === 0) return
    const mod = e.metaKey || e.ctrlKey
    const sel = selection ?? { anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } }
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 300) / ROW_HEIGHT) - 2)
    const moves: Record<string, (p: CellPos) => CellPos> = {
      ArrowDown: (p) => ({ row: mod ? rows.length - 1 : Math.min(rows.length - 1, p.row + 1), col: p.col }),
      ArrowUp: (p) => ({ row: mod ? 0 : Math.max(0, p.row - 1), col: p.col }),
      ArrowRight: (p) => ({ row: p.row, col: mod ? fields.length - 1 : Math.min(fields.length - 1, p.col + 1) }),
      ArrowLeft: (p) => ({ row: p.row, col: mod ? 0 : Math.max(0, p.col - 1) }),
      PageDown: (p) => ({ row: Math.min(rows.length - 1, p.row + page), col: p.col }),
      PageUp: (p) => ({ row: Math.max(0, p.row - page), col: p.col }),
      Home: (p) => (mod ? { row: 0, col: 0 } : { row: p.row, col: 0 }),
      End: (p) => (mod ? { row: rows.length - 1, col: fields.length - 1 } : { row: p.row, col: fields.length - 1 }),
    }
    const move = moves[e.key]
    if (move) {
      e.preventDefault()
      const focus = move(sel.focus)
      setSelection(e.shiftKey ? { anchor: sel.anchor, focus } : { anchor: focus, focus })
      scrollIntoView(focus)
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const focus = e.shiftKey
        ? { row: sel.focus.row, col: Math.max(0, sel.focus.col - 1) }
        : { row: sel.focus.row, col: Math.min(fields.length - 1, sel.focus.col + 1) }
      setSelection({ anchor: focus, focus })
      scrollIntoView(focus)
      return
    }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      setSelection({ anchor: { row: 0, col: 0 }, focus: { row: rows.length - 1, col: fields.length - 1 } })
      return
    }
    if (mod && e.key.toLowerCase() === 'c') {
      e.preventDefault()
      void navigator.clipboard.writeText(selectionToTsv(fields, rows, sel, e.shiftKey))
      return
    }
    if (!selection) return
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault()
      if (onEdit) startEdit(selection.focus)
      else onCellActivate?.(selection.focus)
      return
    }
    if (onEdit && !mod && e.key.length === 1 && !e.altKey) {
      // Typing starts editing with the typed character, like a spreadsheet.
      e.preventDefault()
      startEdit(selection.focus, e.key)
    }
  }

  const posFromEvent = (e: React.MouseEvent): CellPos | null => {
    const el = scrollRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const x = e.clientX - rect.left + el.scrollLeft
    const y = e.clientY - rect.top + el.scrollTop - HEADER_HEIGHT
    if (y < 0) return null
    const row = Math.floor(y / ROW_HEIGHT)
    if (row < 0 || row >= rows.length) return null
    if (x < rowHeaderWidth) return { row, col: -1 }
    let col = -1
    for (let i = 0; i < widths.length; i++) {
      if (x >= offsets[i]! && x < offsets[i + 1]!) {
        col = i
        break
      }
    }
    return col === -1 ? null : { row, col }
  }

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const pos = posFromEvent(e)
    if (!pos) return
    if (editing) commitEdit(editing.value)
    if (pos.col === -1) {
      // Row header: select entire rows.
      const anchor = e.shiftKey && selection ? { row: selection.anchor.row, col: 0 } : { row: pos.row, col: 0 }
      setSelection({ anchor, focus: { row: pos.row, col: fields.length - 1 } })
    } else if (e.shiftKey && selection) {
      setSelection({ anchor: selection.anchor, focus: pos })
    } else {
      setSelection({ anchor: pos, focus: pos })
    }
    dragging.current = true
  }

  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragging.current || !selection || e.buttons !== 1) return
    const pos = posFromEvent(e)
    if (!pos) return
    const focus = { row: pos.row, col: pos.col === -1 ? selection.focus.col : pos.col }
    if (focus.row !== selection.focus.row || focus.col !== selection.focus.col) setSelection({ anchor: selection.anchor, focus })
  }

  useEffect(() => {
    const up = () => (dragging.current = false)
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  const onDoubleClick = (e: React.MouseEvent) => {
    const pos = posFromEvent(e)
    if (!pos || pos.col === -1) return
    if (onEdit) startEdit(pos)
    else onCellActivate?.(pos)
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    if (!onContextMenu) return
    e.preventDefault()
    const pos = posFromEvent(e)
    let sel = selection
    if (pos && pos.col >= 0) {
      const inside = sel && (() => {
        const b = normalize(sel)
        return pos.row >= b.r0 && pos.row <= b.r1 && pos.col >= b.c0 && pos.col <= b.c1
      })()
      if (!inside) {
        sel = { anchor: pos, focus: pos }
        setSelection(sel)
      }
    }
    onContextMenu(e, pos && pos.col >= 0 ? pos : null, sel)
  }

  // Column resizing.
  const resizeStart = useRef<{ col: number; x: number; width: number } | null>(null)
  const onResizeDown = (e: React.PointerEvent, col: number) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    resizeStart.current = { col, x: e.clientX, width: widths[col] ?? 100 }
  }
  const onResizeMove = (e: React.PointerEvent) => {
    const start = resizeStart.current
    if (!start) return
    const w = Math.max(MIN_COL, start.width + e.clientX - start.x)
    setWidths((prev) => prev.map((v, i) => (i === start.col ? w : v)))
  }
  const onResizeUp = () => {
    const start = resizeStart.current
    resizeStart.current = null
    if (start && onColumnWidthsChange) {
      onColumnWidthsChange(Object.fromEntries(fields.map((f, i) => [f.name, widths[i] ?? 100])))
    }
  }
  const autoFit = (col: number) => {
    const field = fields[col]
    if (!field) return
    const w = Math.min(800, estimateWidth(field, rows, col) * 1.15)
    setWidths((prev) => prev.map((v, i) => (i === col ? w : v)))
  }

  const toggleSort = (e: React.MouseEvent, name: string) => {
    if (!onSortChange) return
    const current = sort ?? []
    const existing = current.find((s) => s.column === name)
    let next: SortSpec[]
    const nextDir = !existing ? 'asc' : existing.direction === 'asc' ? 'desc' : null
    if (e.shiftKey) {
      next = current.filter((s) => s.column !== name)
      if (nextDir) next = existing ? current.map((s) => (s.column === name ? { ...s, direction: nextDir } : s)) : [...current, { column: name, direction: nextDir }]
    } else {
      next = nextDir ? [{ column: name, direction: nextDir }] : []
    }
    onSortChange(next)
  }

  const sel = selection ? normalize(selection) : null
  const virtualRows = rowVirtualizer.getVirtualItems()
  const virtualCols = colVirtualizer.getVirtualItems()
  const totalHeight = HEADER_HEIGHT + rows.length * ROW_HEIGHT

  const editor = editing && (
    <CellEditor
      key={`${editing.pos.row}:${editing.pos.col}`}
      initial={editing.value}
      top={HEADER_HEIGHT + editing.pos.row * ROW_HEIGHT}
      left={offsets[editing.pos.col] ?? 0}
      width={widths[editing.pos.col] ?? 120}
      nullable={columnMeta?.[editing.pos.col]?.nullable !== false}
      onCommit={commitEdit}
      onCancel={() => {
        setEditing(null)
        requestAnimationFrame(() => scrollRef.current?.focus())
      }}
    />
  )

  return (
    <div
      ref={scrollRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onDoubleClick={onDoubleClick}
      onContextMenu={handleContextMenu}
      className={cn('relative h-full w-full overflow-auto bg-bg text-fg outline-none', className)}
    >
      <div style={{ width: totalWidth, height: Math.max(totalHeight, HEADER_HEIGHT), position: 'relative' }}>
        {/* Header */}
        <div
          className="sticky top-0 z-20 border-b border-line-strong bg-[var(--grid-header)]"
          style={{ height: HEADER_HEIGHT, width: totalWidth }}
        >
          <div
            className="sticky left-0 z-10 flex h-full items-center justify-center border-r border-line bg-[var(--grid-header)] text-[11px] text-fg-faint"
            style={{ width: rowHeaderWidth }}
            onMouseDown={(e) => {
              e.stopPropagation()
              if (rows.length && fields.length)
                setSelection({ anchor: { row: 0, col: 0 }, focus: { row: rows.length - 1, col: fields.length - 1 } })
              scrollRef.current?.focus()
            }}
          >
            #
          </div>
          {virtualCols.map((vc) => {
            const field = fields[vc.index]!
            const meta = columnMeta?.[vc.index]
            const s = sort?.find((x) => x.column === field.name)
            const sortIndex = sort && sort.length > 1 && s ? sort.indexOf(s) + 1 : 0
            const colSelected = sel && vc.index >= sel.c0 && vc.index <= sel.c1
            return (
              <div
                key={vc.key}
                className={cn(
                  'group absolute top-0 flex h-full items-center gap-1 border-r border-line pr-1 pl-2 text-[12px] font-semibold',
                  onSortChange && 'cursor-pointer hover:bg-hover',
                  colSelected && 'bg-accent-soft',
                )}
                style={{ left: offsets[vc.index], width: widths[vc.index] }}
                title={[field.name, meta?.dataType ?? field.dataType, meta?.comment].filter(Boolean).join('\n')}
                onMouseDown={(e) => {
                  e.stopPropagation()
                  if (e.button !== 0) return
                  if (!onSortChange) {
                    // Select the whole column.
                    if (rows.length) setSelection({ anchor: { row: 0, col: vc.index }, focus: { row: rows.length - 1, col: vc.index } })
                    scrollRef.current?.focus()
                  }
                }}
                onClick={(e) => toggleSort(e, field.name)}
                onContextMenu={(e) => {
                  e.stopPropagation()
                  if (rows.length) setSelection({ anchor: { row: 0, col: vc.index }, focus: { row: rows.length - 1, col: vc.index } })
                  onContextMenu?.(e, { row: -1, col: vc.index }, null)
                  e.preventDefault()
                }}
              >
                {meta?.isPrimaryKey && <KeyRound size={11} className="shrink-0 text-warning" />}
                {meta?.foreignKey && !meta.isPrimaryKey && <Link2 size={11} className="shrink-0 text-info" />}
                <span className="min-w-0 truncate">{field.name}</span>
                {(meta?.dataType ?? field.dataType) && (
                  <span className="min-w-0 shrink truncate text-[10.5px] font-normal text-fg-faint">{meta?.dataType ?? field.dataType}</span>
                )}
                <span className="ml-auto flex shrink-0 items-center text-accent">
                  {s && (s.direction === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                  {sortIndex > 0 && <span className="text-[10px]">{sortIndex}</span>}
                </span>
                <div
                  className="absolute top-0 right-[-4px] z-10 h-full w-[8px] cursor-col-resize"
                  onPointerDown={(e) => onResizeDown(e, vc.index)}
                  onPointerMove={onResizeMove}
                  onPointerUp={onResizeUp}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    autoFit(vc.index)
                  }}
                />
              </div>
            )
          })}
        </div>

        {/* Rows */}
        {virtualRows.map((vr) => {
          const row = rows[vr.index]!
          const state = rowState?.(vr.index)
          const rowSelected = sel && vr.index >= sel.r0 && vr.index <= sel.r1
          return (
            <div
              key={vr.key}
              className={cn(
                'absolute left-0',
                vr.index % 2 === 1 && 'bg-[var(--grid-row-alt)]',
                state === 'inserted' && 'bg-[var(--grid-inserted)]',
                state === 'deleted' && 'bg-[var(--grid-deleted)] line-through decoration-danger/60',
              )}
              style={{ top: vr.start, height: ROW_HEIGHT, width: totalWidth }}
            >
              <div
                className={cn(
                  'sticky left-0 z-10 flex h-full items-center justify-end border-r border-b border-line bg-[var(--grid-header)] pr-2 text-[11px] text-fg-faint tabular-nums',
                  rowSelected && 'bg-accent-soft text-accent',
                )}
                style={{ width: rowHeaderWidth }}
              >
                {state === 'inserted' ? '+' : rowNumberOffset + vr.index + 1}
              </div>
              {virtualCols.map((vc) => {
                const c = vc.index
                const selected = !!sel && vr.index >= sel.r0 && vr.index <= sel.r1 && c >= sel.c0 && c <= sel.c1
                const focused = !!selection && selection.focus.row === vr.index && selection.focus.col === c
                return (
                  <Cell
                    key={vc.key}
                    value={row[c] ?? null}
                    left={offsets[c] ?? 0}
                    width={widths[c] ?? 100}
                    numeric={numeric[c] ?? false}
                    selected={selected && !(sel!.r0 === sel!.r1 && sel!.c0 === sel!.c1)}
                    focused={focused}
                    edited={isCellEdited?.(vr.index, c) ?? false}
                    fk={!!columnMeta?.[c]?.foreignKey}
                    nullDisplay={nullDisplay}
                    onFkClick={onForeignKeyClick ? () => onForeignKeyClick({ row: vr.index, col: c }) : undefined}
                  />
                )
              })}
            </div>
          )
        })}
        {editor}
      </div>
      {rows.length === 0 && (
        <div className="pointer-events-none absolute inset-x-0 top-[30px] flex justify-center p-8 text-[12.5px] text-fg-faint">{emptyMessage ?? t('No rows')}</div>
      )}
    </div>
  )
}

function CellEditor({
  initial,
  top,
  left,
  width,
  nullable,
  onCommit,
  onCancel,
}: {
  initial: string
  top: number
  left: number
  width: number
  nullable: boolean
  onCommit: (value: string | null, move?: 'down' | 'right' | 'left') => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const multiline = initial.includes('\n') || initial.length > 120
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    const len = el.value.length
    el.setSelectionRange(len, len)
  }, [])
  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    } else if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey) && !e.shiftKey) {
      e.preventDefault()
      onCommit(value, 'down')
    } else if (e.key === 'Tab') {
      e.preventDefault()
      onCommit(value, e.shiftKey ? 'left' : 'right')
    } else if (nullable && (e.metaKey || e.ctrlKey) && e.key === 'Backspace' && e.shiftKey) {
      // Cmd/Ctrl+Shift+Backspace sets NULL.
      e.preventDefault()
      onCommit(null, 'down')
    }
  }
  const common = {
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValue(e.target.value),
    onKeyDown,
    onBlur: () => onCommit(value),
    onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
    className:
      'absolute z-30 border-2 border-accent bg-bg px-[7px] font-mono text-[12px] text-fg shadow-pop outline-none',
  }
  return multiline ? (
    <textarea
      ref={ref}
      {...common}
      style={{ top, left, width: Math.max(width, 320), height: 140 }}
      className={cn(common.className, 'resize py-1')}
    />
  ) : (
    <input ref={ref} {...common} style={{ top, left, width: Math.max(width, 120), height: ROW_HEIGHT }} />
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Columns3,
  Copy,
  Download,
  Eye,
  EyeOff,
  Filter,
  KeyRound,
  Network,
  PanelRight,
  Plus,
  RefreshCw,
  Rows3,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  Pin,
  PinOff,
} from 'lucide-react'
import {
  cellToText,
  countActiveConditions,
  displayName,
  findTable,
  incomingReferences,
  newFilterId,
  referencedTable,
  type CellValue,
  type FilterGroup,
  type QueryResult,
  type RowChange,
  type SortSpec,
} from '@dbmastermind/core/browser'
import type { ExportFormat } from '@shared/api'
import { openCellViewer } from '@/components/grid/CellViewer'
import { DataGrid, selectionBounds, selectionToTsv, type DataGridHandle, type GridColumnMeta, type GridSelection } from '@/components/grid/DataGrid'
import { Button, IconButton } from '@/components/ui/Button'
import { openMenu, type MenuItem } from '@/components/ui/ContextMenu'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge, Input, Select } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { api, keys } from '@/lib/api'
import { columnView, loadColumnPrefs, pinnedCount, saveColumnPrefs, type ColumnPrefs } from '@/lib/columnPrefs'
import { copyText, errorMessage, formatCount, formatDuration, uid } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { useSettings } from '@/store/settings'
import { toast } from '@/store/ui'
import { useWorkspace, type TableTab } from '@/store/workspace'
import { copyRowsAs, EXPORT_FORMATS } from '../results/copy'
import { FilterBuilder, newCondition } from './FilterBuilder'
import { ImportModal } from './ImportModal'
import { RowDetails } from './RowDetails'
import { useAiAllowed } from '../ai/AiPermissions'
import { tp, useT } from '@/lib/i18n'
import { confirmAction } from '@/components/ui/ConfirmDialog'

type EditValue = string | null

interface PendingChanges {
  edits: Map<number, Record<string, EditValue>>
  inserted: Record<string, EditValue>[]
  deleted: Set<number>
}

/** Tab-separated text as copied from Excel / Google Sheets (quoted cells may contain tabs and newlines). */
function parseTsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const src = text.replace(/\r\n?/g, '\n').replace(/\n$/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === '\t') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  row.push(cell)
  rows.push(row)
  return rows
}

const emptyPending = (): PendingChanges => ({ edits: new Map(), inserted: [], deleted: new Set() })

function rootGroup(filter: TableTab['filter']): FilterGroup {
  if (filter?.kind === 'group') return filter
  return { kind: 'group', id: newFilterId(), combinator: 'and', children: filter ? [filter] : [] }
}

/** `active`: visible (loads data); `focused`: gets keyboard shortcuts (differs in a split view). */
export function TableView({ tab, active, focused = active }: { tab: TableTab; active: boolean; focused?: boolean }) {
  const runtime = useConnections((s) => s.runtime[tab.connectionId])
  const connection = useConnections((s) => s.list.find((c) => c.id === tab.connectionId))
  const loadSchema = useConnections((s) => s.loadSchema)
  const settings = useSettings((s) => s.settings)
  const updateTab = useWorkspace((s) => s.update)
  const openTab = useWorkspace((s) => s.open)
  const schema = runtime?.schema
  const table = schema ? findTable(schema, tab.table) : undefined

  const pageSize = settings?.pageSize ?? 200
  const [limit, setLimit] = useState(pageSize)
  const [offset, setOffset] = useState(0)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [total, setTotal] = useState<number | null>(null)
  const [counting, setCounting] = useState(false)
  const [showFilters, setShowFilters] = useState(countActiveConditions(tab.filter) > 0)
  const [draft, setDraft] = useState<FilterGroup>(() => rootGroup(tab.filter))
  const [pending, setPending] = useState<PendingChanges>(emptyPending)
  const [preview, setPreview] = useState<string[] | null>(null)
  /** Why the last apply was rolled back, shown in the review dialog next to the SQL. */
  const [applyError, setApplyError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [selection, setSelection] = useState<GridSelection | null>(null)
  const [showDetails, setShowDetails] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [aiFilter, setAiFilter] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const hasProvider = useSettings((st) => !!st.settings?.ai.activeProvider)
  const aiAllowed = useAiAllowed(connection)
  const aiReady = hasProvider && aiAllowed

  const suggestFilter = async () => {
    if (!aiFilter.trim()) return
    setAiBusy(true)
    try {
      const group = await api.aiSuggestFilter(tab.connectionId, tab.table, aiFilter.trim())
      setDraft(group)
      setShowFilters(true)
      applyFilter(group)
    } catch (err) {
      toast({ kind: 'error', message: t('Could not build a filter'), detail: errorMessage(err) })
    } finally {
      setAiBusy(false)
    }
  }
  const [lastSql, setLastSql] = useState('')
  const [duration, setDuration] = useState<number | null>(null)
  const grid = useRef<DataGridHandle>(null)
  const runId = useRef<string | null>(null)
  const t = useT()

  const appliedFilter = tab.filter
  const sort = tab.sort
  const readOnly = !!connection?.readOnly
  const primaryKey = table?.primaryKey ?? []
  const editable = !!table && table.type === 'table' && primaryKey.length > 0 && !readOnly
  const pendingCount = pending.edits.size + pending.inserted.length + pending.deleted.size

  // Sync the draft when the filter is replaced from outside (FK navigation, AI).
  const filterKey = JSON.stringify(tab.filter ?? null)
  useEffect(() => {
    setDraft(rootGroup(tab.filter))
    if (countActiveConditions(tab.filter) > 0) setShowFilters(true)
    setOffset(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey])

  useEffect(() => {
    if (!schema && runtime?.status !== 'connecting') void loadSchema(tab.connectionId)
  }, [schema, runtime?.status, loadSchema, tab.connectionId])

  const load = useCallback(async () => {
    if (runId.current) void api.cancelQuery(runId.current)
    const id = uid('run')
    runId.current = id
    setLoading(true)
    setError(null)
    const started = performance.now()
    try {
      const page = await api.fetchTable({
        connectionId: tab.connectionId,
        table: tab.table,
        filter: appliedFilter,
        sort,
        limit,
        offset,
        runId: id,
      })
      if (runId.current !== id) return
      setResult(page.result)
      setLastSql(page.sql)
      setDuration(performance.now() - started)
      setPending(emptyPending())
    } catch (err) {
      if (runId.current !== id) return
      setError(errorMessage(err))
    } finally {
      if (runId.current === id) {
        runId.current = null
        setLoading(false)
      }
    }
  }, [tab.connectionId, tab.table, appliedFilter, sort, limit, offset])

  const count = useCallback(async () => {
    setCounting(true)
    try {
      setTotal(await api.countTable({ connectionId: tab.connectionId, table: tab.table, filter: appliedFilter }))
    } catch {
      setTotal(null)
    } finally {
      setCounting(false)
    }
  }, [tab.connectionId, tab.table, appliedFilter])

  // Load when the tab first becomes visible and whenever the query changes.
  const loadedKey = useRef<string | null>(null)
  const queryKey = JSON.stringify([appliedFilter, sort, limit, offset, tab.table])
  useEffect(() => {
    if (!active || loadedKey.current === queryKey) return
    loadedKey.current = queryKey
    void load()
  }, [active, queryKey, load])

  const countKey = JSON.stringify([appliedFilter, tab.table])
  const countedKey = useRef<string | null>(null)
  useEffect(() => {
    if (!active || countedKey.current === countKey) return
    countedKey.current = countKey
    setTotal(null)
    void count()
  }, [active, countKey, count])

  const confirmDiscard = async () =>
    pendingCount === 0 ||
    confirmAction({ title: tp(pendingCount, { one: 'Discard {n} pending change?', many: 'Discard {n} pending changes?' }), confirmLabel: t('Discard'), danger: true })

  const applyFilter = async (group: FilterGroup = draft) => {
    if (!(await confirmDiscard())) return
    const active = countActiveConditions(group) > 0
    updateTab(tab.id, { filter: active ? group : undefined })
    setOffset(0)
  }

  const setSort = async (next: SortSpec[]) => {
    if (!(await confirmDiscard())) return
    updateTab(tab.id, { sort: next.length ? next : undefined })
  }

  const refresh = async () => {
    if (!(await confirmDiscard())) return
    loadedKey.current = null
    countedKey.current = null
    void load()
    void count()
  }

  // Rows as displayed: originals with edits applied, then inserted rows.
  const fields = result?.fields ?? []
  const fieldIndex = useMemo(() => new Map(fields.map((f, i) => [f.name, i])), [fields])

  // Column layout (order, hidden, widths): the grid shows a view of the fields; positions map back with toField.
  const prefsId = `${tab.connectionId}:${tab.table.schema ?? ''}.${tab.table.name}`
  const [columnPrefs, setColumnPrefs] = useState<ColumnPrefs>(() => loadColumnPrefs(prefsId))
  const updateColumnPrefs = (patch: Partial<ColumnPrefs>) =>
    setColumnPrefs((p) => {
      const next = { ...p, ...patch }
      saveColumnPrefs(prefsId, next)
      return next
    })
  // Widths don't change the view; only order and hidden do.
  const view = useMemo(() => columnView(fields, { order: columnPrefs.order, hidden: columnPrefs.hidden }), [fields, columnPrefs.order, columnPrefs.hidden])
  const toField = (c: number) => view[c] ?? c
  const moveColumn = (name: string, delta: number) => {
    const names = view.map((i) => fields[i]!.name)
    const at = names.indexOf(name)
    const to = at + delta
    if (at < 0 || to < 0 || to >= names.length) return
    names.splice(to, 0, names.splice(at, 1)[0]!)
    updateColumnPrefs({ order: names })
  }
  const displayRows = useMemo(() => {
    if (!result) return []
    const rows = result.rows.map((row, r) => {
      const edits = pending.edits.get(r)
      if (!edits) return row
      const copy = [...row]
      for (const [col, value] of Object.entries(edits)) {
        const i = fieldIndex.get(col)
        if (i !== undefined) copy[i] = value
      }
      return copy
    })
    for (const ins of pending.inserted) rows.push(fields.map((f) => (f.name in ins ? ins[f.name]! : null)))
    return rows
  }, [result, pending, fields, fieldIndex])

  const columnMeta: GridColumnMeta[] = useMemo(
    () =>
      fields.map((f) => {
        const col = table?.columns.find((c) => c.name === f.name)
        const fk = table?.foreignKeys.find((k) => k.columns.length === 1 && k.columns[0] === f.name)
        return {
          dataType: col?.dataType ?? f.dataType,
          isPrimaryKey: col?.isPrimaryKey,
          nullable: col?.nullable,
          comment: col?.comment,
          foreignKey: fk ? `${fk.refTable}.${fk.refColumns[0]}` : undefined,
        }
      }),
    [fields, table],
  )

  const baseCount = result?.rows.length ?? 0
  const viewFields = useMemo(() => view.map((i) => fields[i]!), [view, fields])
  const viewRows = useMemo(() => (view.length === fields.length && view.every((v, i) => v === i) ? displayRows : displayRows.map((r) => view.map((i) => r[i] ?? null))), [view, fields.length, displayRows])
  const viewMeta = useMemo(() => view.map((i) => columnMeta[i]), [view, columnMeta])

  /** Applies one cell edit to pending changes (rows past the loaded ones are inserted rows). */
  const applyEdit = (next: PendingChanges, row: number, col: number, value: string | null) => {
    const name = fields[col]?.name
    if (!name) return
    if (row >= baseCount) {
      next.inserted[row - baseCount] = { ...next.inserted[row - baseCount], [name]: value }
      return
    }
    const original = result!.rows[row]![col] ?? null
    const originalText = original === null ? null : cellToText(original)
    const edits = { ...next.edits.get(row) }
    if (value === originalText) delete edits[name]
    else edits[name] = value
    if (Object.keys(edits).length) next.edits.set(row, edits)
    else next.edits.delete(row)
  }

  const onEdit = (row: number, col: number, value: string | null) => {
    setPending((p) => {
      const next: PendingChanges = { edits: new Map(p.edits), inserted: [...p.inserted], deleted: new Set(p.deleted) }
      applyEdit(next, row, col, value)
      return next
    })
  }

  /** Paste from a spreadsheet: a block lands at the focused cell, one value fills the selection; extra rows are inserted. */
  const onGridPaste = (e: React.ClipboardEvent) => {
    if (!editable || !selection) return
    const target = e.target as HTMLElement
    if (target.closest('input, textarea, [contenteditable="true"]')) return
    const text = e.clipboardData.getData('text/plain')
    if (!text) return
    e.preventDefault()
    const block = parseTsv(text)
    const { r0, r1, c0, c1 } = selectionBounds(selection)
    const cell = (v: string, col: number) => (v === '' && columnMeta[col]?.nullable !== false ? null : v)
    setPending((p) => {
      const next: PendingChanges = { edits: new Map(p.edits), inserted: [...p.inserted], deleted: new Set(p.deleted) }
      if (block.length === 1 && block[0]!.length === 1) {
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) applyEdit(next, r, toField(c), cell(block[0]![0]!, toField(c)))
      } else {
        block.forEach((values, i) => {
          const row = r0 + i
          // Rows past the end of the page (and past already inserted rows) become new rows.
          while (row >= baseCount + next.inserted.length) next.inserted.push({})
          values.forEach((v, j) => {
            if (c0 + j < view.length) applyEdit(next, row, toField(c0 + j), cell(v, toField(c0 + j)))
          })
        })
      }
      return next
    })
    toast({ kind: 'info', message: tp(block.length, { one: 'Pasted {n} row as pending changes', many: 'Pasted {n} rows as pending changes' }) })
  }

  const isCellEdited = useCallback(
    (row: number, col: number) => {
      const name = fields[col]?.name
      if (!name) return false
      if (row >= baseCount) return name in (pending.inserted[row - baseCount] ?? {})
      return !!pending.edits.get(row) && name in pending.edits.get(row)!
    },
    [fields, pending, baseCount],
  )

  const rowState = useCallback(
    (row: number) => (row >= baseCount ? 'inserted' : pending.deleted.has(row) ? 'deleted' : undefined),
    [baseCount, pending.deleted],
  )

  const addRow = (values: Record<string, EditValue> = {}) => {
    setPending((p) => ({ ...p, inserted: [...p.inserted, values] }))
    requestAnimationFrame(() => {
      const row = baseCount + pending.inserted.length
      grid.current?.selectCell({ row, col: 0 })
      grid.current?.focus()
    })
  }

  const selectedRows = (sel: GridSelection | null = selection): number[] => {
    if (!sel) return []
    const { r0, r1 } = selectionBounds(sel)
    return Array.from({ length: r1 - r0 + 1 }, (_, i) => r0 + i)
  }

  const deleteRows = (rows: number[]) => {
    setPending((p) => {
      const next: PendingChanges = { edits: new Map(p.edits), inserted: [...p.inserted], deleted: new Set(p.deleted) }
      const insertedToRemove = new Set<number>()
      for (const r of rows) {
        if (r >= baseCount) insertedToRemove.add(r - baseCount)
        else if (next.deleted.has(r)) next.deleted.delete(r)
        else next.deleted.add(r)
      }
      next.inserted = next.inserted.filter((_, i) => !insertedToRemove.has(i))
      return next
    })
  }

  const cloneRow = (row: number) => {
    const values: Record<string, EditValue> = {}
    fields.forEach((f, i) => {
      const col = table?.columns.find((c) => c.name === f.name)
      if (col?.isIdentity || col?.isGenerated) return
      const v = displayRows[row]?.[i] ?? null
      values[f.name] = v === null ? null : cellToText(v)
    })
    addRow(values)
  }

  const buildChanges = (): RowChange[] => {
    if (!result) return []
    const keyOf = (row: number) =>
      Object.fromEntries(primaryKey.map((k) => [k, normalizeKey(result.rows[row]![fieldIndex.get(k)!] ?? null)]))
    const changes: RowChange[] = []
    for (const [row, values] of pending.edits) {
      if (pending.deleted.has(row)) continue
      changes.push({ type: 'update', key: keyOf(row), values })
    }
    for (const values of pending.inserted) changes.push({ type: 'insert', values })
    for (const row of pending.deleted) changes.push({ type: 'delete', key: keyOf(row) })
    return changes
  }

  const showPreview = async () => {
    try {
      setApplyError(null)
      setPreview(await api.previewChanges(tab.connectionId, tab.table, buildChanges()))
    } catch (err) {
      toast({ kind: 'error', message: t('Could not build SQL'), detail: errorMessage(err) })
    }
  }

  const applyChanges = async () => {
    setSaving(true)
    try {
      const affected = await api.applyChanges(tab.connectionId, tab.table, buildChanges())
      const n = affected.reduce((a, b) => a + b, 0)
      toast({ kind: 'success', message: tp(n, { one: 'Saved · {n} row affected', many: 'Saved · {n} rows affected' }) })
      setPreview(null)
      setPending(emptyPending())
      loadedKey.current = null
      countedKey.current = null
      void load()
      void count()
    } catch (err) {
      // In the open review dialog the reason sits next to the SQL; otherwise a toast says it.
      if (preview !== null) setApplyError(errorMessage(err))
      else toast({ kind: 'error', message: t('Changes were rolled back'), detail: errorMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  const followForeignKey = (row: number, col: number) => {
    if (!schema || !table) return
    const name = fields[col]?.name
    const fk = table.foreignKeys.find((k) => k.columns.includes(name ?? ''))
    if (!fk) return
    const target = referencedTable(schema, table, fk)
    if (!target) return
    const children = fk.columns.map((c, i) => {
      const v = displayRows[row]?.[fieldIndex.get(c) ?? -1] ?? null
      return v === null ? newCondition(fk.refColumns[i]!, 'is_null') : newCondition(fk.refColumns[i]!, 'eq', cellToText(v))
    })
    openTab({
      kind: 'table',
      connectionId: tab.connectionId,
      table: { schema: target.schema, name: target.name },
      title: target.name,
      filter: { kind: 'group', id: newFilterId(), combinator: 'and', children },
    })
  }

  const openReferencing = (row: number, refTableName: string, refSchema: string | undefined, fkColumns: string[], refColumns: string[]) => {
    const children = refColumns.map((rc, i) => {
      const v = displayRows[row]?.[fieldIndex.get(rc) ?? -1] ?? null
      return v === null ? newCondition(fkColumns[i]!, 'is_null') : newCondition(fkColumns[i]!, 'eq', cellToText(v))
    })
    openTab(
      {
        kind: 'table',
        connectionId: tab.connectionId,
        table: { schema: refSchema, name: refTableName },
        title: refTableName,
        filter: { kind: 'group', id: newFilterId(), combinator: 'and', children },
      },
      { reuse: true },
    )
  }

  const quickFilter = (col: number, row: number, mode: 'eq' | 'neq' | 'null' | 'notnull' | 'gt' | 'lt') => {
    const name = fields[col]?.name
    if (!name) return
    const v = displayRows[row]?.[col] ?? null
    const text = v === null ? '' : cellToText(v)
    const cond =
      mode === 'null' || (mode === 'eq' && v === null)
        ? newCondition(name, 'is_null')
        : mode === 'notnull' || (mode === 'neq' && v === null)
          ? newCondition(name, 'is_not_null')
          : newCondition(name, mode, text)
    const group: FilterGroup = { ...draft, children: [...draft.children, cond] }
    setDraft(group)
    setShowFilters(true)
    applyFilter(group)
  }

  /** The value viewer, editing the cell when the table is editable (binary stays read-only). */
  const openValue = (row: number, col: number) => {
    const meta = columnMeta[col]
    const canEdit = editable && !pending.deleted.has(row) && !/binary|blob|bytea|image|raw/i.test(meta?.dataType ?? '')
    openCellViewer(displayRows[row]?.[col] ?? null, fields[col]?.name ?? '', meta?.dataType, canEdit ? (value) => onEdit(row, col, value) : undefined)
  }

  const onContextMenu = (e: React.MouseEvent, pos: { row: number; col: number } | null, sel: GridSelection | null) => {
    if (!pos) {
      openMenu(e, [{ label: t('Add row'), icon: <Plus size={13} />, disabled: !editable, onClick: () => addRow() }])
      return
    }
    if (pos.row === -1) {
      const name = fields[pos.col]?.name ?? ''
      openMenu(e, [
        { label: t('Sort ascending'), onClick: () => setSort([{ column: name, direction: 'asc' }]) },
        { label: t('Sort descending'), onClick: () => setSort([{ column: name, direction: 'desc' }]) },
        { label: t('Clear sort'), disabled: !sort?.length, onClick: () => setSort([]) },
        'separator',
        { label: t('Filter by this column…'), icon: <Filter size={13} />, onClick: () => {
          setDraft((d) => ({ ...d, children: [...d.children, newCondition(name)] }))
          setShowFilters(true)
        } },
        { label: t('Copy column name'), icon: <Copy size={13} />, onClick: () => void copyText(name) },
        'separator',
        { label: t('Hide column'), icon: <EyeOff size={13} />, disabled: view.length <= 1, onClick: () => updateColumnPrefs({ hidden: [...(columnPrefs.hidden ?? []), name] }) },
        { label: t('Pin columns up to here'), icon: <Pin size={13} />, disabled: columnPrefs.pinned === name, onClick: () => updateColumnPrefs({ pinned: name }) },
        ...(columnPrefs.pinned ? [{ label: t('Unpin columns'), icon: <PinOff size={13} />, onClick: () => updateColumnPrefs({ pinned: undefined }) }] : []),
        { label: t('Move left'), disabled: view[0] === pos.col, onClick: () => moveColumn(name, -1) },
        { label: t('Move right'), disabled: view.at(-1) === pos.col, onClick: () => moveColumn(name, 1) },
        { label: t('Copy column values'), onClick: () => sel && void copyText(selectionToTsv(viewFields, viewRows, sel)) },
      ])
      return
    }
    const rows = selectedRows(sel)
    const value = displayRows[pos.row]?.[pos.col] ?? null
    const colName = fields[pos.col]?.name ?? ''
    const fk = table?.foreignKeys.find((k) => k.columns.includes(colName))
    const incoming = schema && table ? incomingReferences(schema, table) : []
    const items: MenuItem[] = [
      {
        label: editable && !pending.deleted.has(pos.row) ? t('Edit value…') : t('View value…'),
        shortcut: '⇧↵',
        onClick: () => openValue(pos.row, pos.col),
      },
      { label: t('Copy'), shortcut: keys('⌘C'), icon: <Copy size={13} />, onClick: () => sel && void copyText(selectionToTsv(viewFields, viewRows, sel, false, '')) },
      { label: t('Copy with headers'), onClick: () => sel && void copyText(selectionToTsv(viewFields, viewRows, sel, true, '')) },
      {
        label: t('Copy rows as'),
        submenu: (['json', 'csv', 'markdown', 'sql'] as const).map((format) => ({
          label: format === 'sql' ? 'SQL INSERT' : format === 'markdown' ? 'Markdown' : format.toUpperCase(),
          onClick: () =>
            void copyText(
              copyRowsAs(format, fields, rows.map((r) => displayRows[r]!), connection?.driver, displayName(schema, tab.table)),
            ),
        })),
      },
      'separator',
      { label: `${t('Filter')}: ${colName} = ${value === null ? 'NULL' : truncate(cellToText(value))}`, icon: <Filter size={13} />, onClick: () => quickFilter(pos.col, pos.row, 'eq') },
      { label: `${t('Filter')}: ${colName} ≠ ${value === null ? 'NULL' : truncate(cellToText(value))}`, onClick: () => quickFilter(pos.col, pos.row, 'neq') },
      {
        label: t('More filters'),
        submenu: [
          { label: `${colName} > ${t('value')}`, onClick: () => quickFilter(pos.col, pos.row, 'gt') },
          { label: `${colName} < ${t('value')}`, onClick: () => quickFilter(pos.col, pos.row, 'lt') },
          { label: t('{column} is NULL', { column: colName }), onClick: () => quickFilter(pos.col, pos.row, 'null') },
          { label: t('{column} is not NULL', { column: colName }), onClick: () => quickFilter(pos.col, pos.row, 'notnull') },
        ],
      },
    ]
    if (fk || incoming.length) items.push('separator')
    if (fk) items.push({ label: t('Open referenced {table}', { table: fk.refTable }), icon: <Network size={13} />, onClick: () => followForeignKey(pos.row, pos.col) })
    if (incoming.length) {
      items.push({
        label: t('Referenced by'),
        icon: <Network size={13} />,
        submenu: incoming.map((ref) => ({
          label: `${ref.table.name} (${ref.foreignKey.columns.join(', ')})`,
          onClick: () => openReferencing(pos.row, ref.table.name, ref.table.schema, ref.foreignKey.columns, ref.foreignKey.refColumns),
        })),
      })
    }
    if (editable) {
      items.push(
        'separator',
        { label: t('Edit cell'), shortcut: '↵', onClick: () => grid.current?.edit() },
        { label: t('Set NULL'), disabled: columnMeta[pos.col]?.nullable === false, onClick: () => rows.forEach((r) => onEdit(r, pos.col, null)) },
        { label: t('Clone row'), icon: <Rows3 size={13} />, onClick: () => cloneRow(pos.row) },
        { label: rows.length > 1 ? tp(rows.length, { one: 'Delete {n} row', many: 'Delete {n} rows' }) : t('Delete row'), icon: <Trash2 size={13} />, danger: true, onClick: () => deleteRows(rows) },
      )
    }
    openMenu(e, items)
  }

  const exportMenu = (anchor: HTMLElement) => {
    const run = async (format: ExportFormat, scope: 'page' | 'all') => {
      try {
        const path =
          scope === 'all'
            ? await api.exportTable({ format, connectionId: tab.connectionId, table: tab.table, filter: appliedFilter, sort })
            : await api.exportResult({
                format,
                defaultName: tab.table.name,
                result: { fields, rows: displayRows },
                tableName: displayName(schema, tab.table),
                connectionId: tab.connectionId,
              })
        if (path) toast({ kind: 'success', message: t('Export finished'), detail: path, action: { label: t('Show in folder'), run: () => void api.showItemInFolder(path) } })
      } catch (err) {
        toast({ kind: 'error', message: t('Export failed'), detail: errorMessage(err) })
      }
    }
    openMenu(anchor, [
      { label: total !== null ? t('All {n} rows (with filter)', { n: formatCount(total) }) : t('All rows (with filter)'), submenu: EXPORT_FORMATS.map((f) => ({ label: f.label, onClick: () => void run(f.id, 'all') })) },
      { label: t('Current page ({n} rows)', { n: formatCount(displayRows.length) }), submenu: EXPORT_FORMATS.map((f) => ({ label: f.label, onClick: () => void run(f.id, 'page') })) },
    ])
  }

  /** The filter bar with a condition ready to fill in (⌘F and the Filter button behave the same). */
  const openFilters = () => {
    if (draft.children.length === 0 && table?.columns[0]) setDraft((d) => ({ ...d, children: [newCondition(table.columns[0]!.name)] }))
    setShowFilters(true)
  }

  useEffect(() => {
    if (!focused) return
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 's' && pendingCount > 0) {
        e.preventDefault()
        void showPreview()
      } else if (mod && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        refresh()
      } else if (mod && e.key.toLowerCase() === 'f' && !e.shiftKey) {
        e.preventDefault()
        openFilters()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const onGridKeyDown = (e: React.KeyboardEvent) => {
    if (!editable) return
    if ((e.key === 'Delete' || e.key === 'Backspace') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      deleteRows(selectedRows())
    }
  }

  const activeFilters = countActiveConditions(appliedFilter)
  const pageEnd = offset + (result?.rows.length ?? 0)
  const lastPage = total !== null ? Math.max(0, Math.ceil(total / limit) - 1) : null
  const currentPage = Math.floor(offset / limit)
  const goTo = async (page: number) => {
    if (!(await confirmDiscard())) return
    setOffset(Math.max(0, page) * limit)
  }

  if (schema && !table) {
    return (
      <EmptyState icon={<Rows3 size={28} />} title={t('Table {name} was not found', { name: tab.table.name })}>
        {t('It may have been renamed or dropped. Refresh the schema to update the sidebar.')}
      </EmptyState>
    )
  }

  const selectedRow = selection ? selection.focus.row : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-2">
        <Button
          size="sm"
          variant={showFilters ? 'subtle' : 'ghost'}
          icon={<Filter size={14} />}
          onClick={() => (showFilters ? setShowFilters(false) : openFilters())}
          title={`${t('Filters')} (${keys('⌘F')})`}
        >
          {t('Filter')}
          {activeFilters > 0 && <Badge tone="accent">{activeFilters}</Badge>}
        </Button>
        <IconButton label={`${t('Refresh')} (${keys('⌘R')})`} size="md" onClick={refresh}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </IconButton>
        <div className="mx-1 h-5 w-px bg-line" />
        {editable ? (
          <>
            <IconButton label={t('Add row')} size="md" onClick={() => addRow()}>
              <Plus size={15} />
            </IconButton>
            <IconButton label={`${t('Delete selected rows')} (${keys('⌘⌫')})`} size="md" disabled={!selection} onClick={() => deleteRows(selectedRows())}>
              <Trash2 size={14} />
            </IconButton>
          </>
        ) : (
          <span className="flex items-center gap-1 px-1 text-[11.5px] text-fg-faint" title={readOnly ? t('Connection is read-only') : table?.type !== 'table' ? t('Views are read-only') : t('Editing needs a primary key')}>
            <KeyRound size={12} />
            {readOnly ? t('Read-only connection') : table?.type !== 'table' ? t('View (read-only)') : t('No primary key: read-only')}
          </span>
        )}
        {pendingCount > 0 && (
          <div className="ml-1 flex items-center gap-1 rounded-md bg-warning-soft py-0.5 pr-0.5 pl-2">
            <span className="text-[12px] font-medium text-warning">{tp(pendingCount, { one: '{n} change', many: '{n} changes' })}</span>
            <Button size="xs" variant="ghost" icon={<Eye size={12} />} onClick={() => void showPreview()}>
              {t('Review')}
            </Button>
            {/* "Save", not "Apply": the filter bar right below has its own Apply. */}
            <Button size="xs" variant="primary" loading={saving} onClick={() => void applyChanges()} title={`${t('Save changes to the database')} (${keys('⌘S')})`}>
              {t('Save')}
            </Button>
            <IconButton label={t('Discard changes')} onClick={() => setPending(emptyPending())}>
              <Undo2 size={13} />
            </IconButton>
          </div>
        )}
        <div className="flex-1" />
        {aiReady && (
          <Input
            inputSize="sm"
            className="w-[300px]"
            placeholder={t('Describe a filter, e.g. paid orders over 1000 this month')}
            value={aiFilter}
            disabled={aiBusy}
            onChange={(e) => setAiFilter(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void suggestFilter()}
            leading={aiBusy ? <Spinner size={12} /> : <Sparkles size={12} className="text-accent" />}
          />
        )}
        <IconButton label={t('Export')} size="md" onClick={(e) => exportMenu(e.currentTarget)}>
          <Download size={14} />
        </IconButton>
        <IconButton
          label={readOnly ? t('Import (read-only connection)') : t('Import CSV / Excel')}
          size="md"
          disabled={readOnly || table?.type !== 'table'}
          onClick={() => setImportOpen(true)}
        >
          <Upload size={14} />
        </IconButton>
        <IconButton
          label={t('Show in diagram')}
          size="md"
          onClick={() =>
            openTab({ kind: 'diagram', connectionId: tab.connectionId, title: t('Diagram: {name}', { name: tab.table.name }), focus: tab.table.name })
          }
        >
          <Network size={14} />
        </IconButton>
        <IconButton
          label={columnPrefs.hidden?.length ? tp(columnPrefs.hidden.length, { one: 'Columns ({n} hidden)', many: 'Columns ({n} hidden)' }) : t('Columns')}
          size="md"
          active={!!columnPrefs.hidden?.length}
          onClick={(e) =>
            openMenu(e.currentTarget, [
              ...fields.map((f) => {
                const hidden = columnPrefs.hidden?.includes(f.name) ?? false
                return {
                  label: f.name,
                  checked: !hidden,
                  disabled: !hidden && view.length <= 1,
                  onClick: () => updateColumnPrefs({ hidden: hidden ? columnPrefs.hidden!.filter((n) => n !== f.name) : [...(columnPrefs.hidden ?? []), f.name] }),
                }
              }),
              'separator',
              { label: t('Reset columns'), disabled: !columnPrefs.order?.length && !columnPrefs.hidden?.length && !columnPrefs.widths, onClick: () => updateColumnPrefs({ order: undefined, hidden: undefined, widths: undefined }) },
            ])
          }
        >
          <Columns3 size={14} />
        </IconButton>
        <IconButton label={t('Row details')} size="md" active={showDetails} onClick={() => setShowDetails((v) => !v)}>
          <PanelRight size={14} />
        </IconButton>
      </div>

      {showFilters && table && (
        <FilterBuilder
          value={draft}
          columns={table.columns}
          supportsRegex={connection?.driver === 'postgres' || connection?.driver === 'mysql' || connection?.driver === 'mariadb'}
          onChange={setDraft}
          onApply={() => applyFilter()}
          onClear={() => {
            const empty: FilterGroup = { ...draft, children: [] }
            setDraft(empty)
            applyFilter(empty)
          }}
        />
      )}

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1" onKeyDown={onGridKeyDown} onPaste={onGridPaste}>
          {error ? (
            <div className="m-3 rounded-md border border-danger/30 bg-danger-soft p-3 font-mono text-[12px] whitespace-pre-wrap text-danger select-text">
              {error}
            </div>
          ) : !result && loading ? (
            <div className="flex h-full items-center justify-center text-fg-faint">
              <Spinner size={18} />
            </div>
          ) : (
            <DataGrid
              ref={grid}
              fields={viewFields}
              rows={viewRows}
              columnMeta={viewMeta}
              pinnedColumns={pinnedCount(view, fields, columnPrefs)}
              columnWidths={columnPrefs.widths}
              onColumnWidthsChange={(widths) => updateColumnPrefs({ widths: { ...columnPrefs.widths, ...widths } })}
              rowNumberOffset={offset}
              sort={sort}
              onSortChange={setSort}
              onEdit={editable ? (row, col, value) => onEdit(row, toField(col), value) : undefined}
              isCellEdited={(row, col) => isCellEdited(row, toField(col))}
              rowState={rowState}
              onContextMenu={(e, pos, sel) => onContextMenu(e, pos ? { ...pos, col: toField(pos.col) } : null, sel)}
              onForeignKeyClick={(pos) => followForeignKey(pos.row, toField(pos.col))}
              onSelectionChange={setSelection}
              onCellActivate={() => setShowDetails(true)}
              onCellOpen={(pos) => openValue(pos.row, toField(pos.col))}
              nullDisplay={settings?.nullDisplay}
              emptyMessage={activeFilters ? t('No rows match the filter') : t('Table is empty')}
            />
          )}
          {loading && result && (
            <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden">
              <div className="h-full w-1/3 animate-[pulse_1s_ease-in-out_infinite] bg-accent" />
            </div>
          )}
        </div>
        {showDetails && (
          <RowDetails
            fields={fields}
            row={selectedRow !== null ? (displayRows[selectedRow] ?? null) : null}
            columns={table?.columns ?? []}
            editable={editable && selectedRow !== null && !pending.deleted.has(selectedRow)}
            onEdit={(col, value) => selectedRow !== null && onEdit(selectedRow, col, value)}
            onClose={() => setShowDetails(false)}
          />
        )}
      </div>

      {/* Footer */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-t border-line bg-subtle px-2 text-[12px] text-fg-muted">
        <span className="truncate" title={lastSql}>
          {result ? (
            <>
              {total !== null ? (
                <>
                  <b className="font-medium text-fg">{formatCount(total)}</b> {tp(total, { one: 'row', many: 'rows' })}
                </>
              ) : counting ? (
                t('Counting…')
              ) : (
                <button type="button" className="hover:text-fg" onClick={() => void count()}>
                  {t('Count rows')}
                </button>
              )}
              {duration !== null && <span className="ml-2 text-fg-faint">{formatDuration(duration)}</span>}
            </>
          ) : null}
        </span>
        <div className="flex-1" />
        <IconButton label={t('First page')} disabled={currentPage === 0} onClick={() => goTo(0)}>
          <ChevronsLeft size={14} />
        </IconButton>
        <IconButton label={t('Previous page')} disabled={currentPage === 0} onClick={() => goTo(currentPage - 1)}>
          <ChevronLeft size={14} />
        </IconButton>
        <span className="min-w-[110px] text-center tabular-nums">
          {result && result.rows.length > 0 ? `${formatCount(offset + 1)}–${formatCount(pageEnd)}` : '0'}
          {total !== null && ` ${t('of')} ${formatCount(total)}`}
        </span>
        <IconButton
          label={t('Next page')}
          disabled={lastPage !== null ? currentPage >= lastPage : (result?.rows.length ?? 0) < limit}
          onClick={() => goTo(currentPage + 1)}
        >
          <ChevronRight size={14} />
        </IconButton>
        <IconButton label={t('Last page')} disabled={lastPage === null || currentPage >= lastPage} onClick={() => lastPage !== null && goTo(lastPage)}>
          <ChevronsRight size={14} />
        </IconButton>
        <Select
          inputSize="sm"
          className="h-6 w-auto min-w-[112px] text-[12px]"
          value={limit}
          onChange={async (e) => {
            const next = Number(e.target.value)
            if (!(await confirmDiscard())) return
            setLimit(next)
            setOffset(0)
          }}
        >
          {[50, 100, 200, 500, 1000, 5000].map((n) => (
            <option key={n} value={n}>
              {t('{n} / page', { n })}
            </option>
          ))}
        </Select>
      </div>

      {table && (
        <ImportModal
          open={importOpen}
          onClose={() => setImportOpen(false)}
          connectionId={tab.connectionId}
          table={tab.table}
          columns={table.columns}
          onImported={() => {
            setPending(emptyPending())
            loadedKey.current = null
            countedKey.current = null
            void load()
            void count()
          }}
        />
      )}
      <Modal
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={t('Review changes')}
        width={720}
        footer={
          <>
            <span className="text-[12px] text-fg-muted">{t('Runs in a single transaction. If any statement fails, nothing is saved.')}</span>
            <div className="flex-1" />
            <Button onClick={() => void copyText((preview ?? []).join(';\n') + ';')}>{t('Copy SQL')}</Button>
            <Button variant="primary" loading={saving} onClick={() => void applyChanges()} data-autofocus>
              {tp(preview?.length ?? 0, { one: 'Apply {n} statement', many: 'Apply {n} statements' })}
            </Button>
          </>
        }
      >
        {applyError && (
          <div role="alert" className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px]">
            <div className="font-medium">{t('Changes were rolled back: nothing was saved.')}</div>
            <div className="mt-0.5 text-fg-muted select-text">{applyError}</div>
          </div>
        )}
        <pre className="max-h-[50vh] overflow-auto rounded-md bg-subtle p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap select-text">
          {(preview ?? []).map((s) => `${s};`).join('\n')}
        </pre>
      </Modal>
    </div>
  )
}

function truncate(text: string, n = 24): string {
  return text.length > n ? `${text.slice(0, n)}…` : text
}

/** Key values go back to the database as text (or the original number) so they match exactly. */
function normalizeKey(v: CellValue): string | number | boolean | null {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v
  return cellToText(v)
}

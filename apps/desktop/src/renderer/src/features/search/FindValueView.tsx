import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, Search, Square } from 'lucide-react'
import { cellToText, matchedColumns, valueSearchConditions, valueSearchFilter, type CellValue, type FilterCondition, type ResultField, type TableInfo, type ValueSearchMode } from '@dbmastermind/core/browser'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge, Checkbox, Input, Segmented, Select } from '@/components/ui/Input'
import { api } from '@/lib/api'
import { tp, useT } from '@/lib/i18n'
import { cn, errorMessage, formatCount, uid } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { useWorkspace, type SearchTab } from '@/store/workspace'

/** Rows shown per table; one more is read to tell "and more". */
const SAMPLE = 5
/** Tables searched at the same time (each is one query on the server). */
const PARALLEL = 2

interface Hit {
  table: TableInfo
  fields: ResultField[]
  rows: CellValue[][]
  more: boolean
  matched: string[]
  conditions: FilterCondition[]
}

/**
 * Finds a value in every table of a connection (or of one schema): one parameterized, filtered read per table,
 * two at a time, each cancellable. A hit opens the ordinary table tab with the ordinary filter.
 */
export function FindValueView({ tab }: { tab: SearchTab }) {
  const t = useT()
  const connection = useConnections((s) => s.list.find((c) => c.id === tab.connectionId))
  const schema = useConnections((s) => s.runtime[tab.connectionId]?.schema)
  const loadSchema = useConnections((s) => s.loadSchema)
  const update = useWorkspace((s) => s.update)
  const openTab = useWorkspace((s) => s.open)
  const [text, setText] = useState(tab.text ?? '')
  const [mode, setMode] = useState<ValueSearchMode>(tab.mode ?? 'exact')
  const [scope, setScope] = useState(tab.schema ?? '')
  const [views, setViews] = useState(false)
  const [hits, setHits] = useState<Hit[]>([])
  const [failures, setFailures] = useState<{ table: string; message: string }[]>([])
  const [progress, setProgress] = useState<{ done: number; total: number; searched: string } | null>(null)
  const [running, setRunning] = useState(false)
  const generation = useRef(0)
  const runIds = useRef(new Set<string>())
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!schema) void loadSchema(tab.connectionId)
  }, [schema, loadSchema, tab.connectionId])
  useEffect(() => input.current?.focus(), [])
  // Stop what runs when the tab closes.
  useEffect(() => () => stop(), [])

  const tables = useMemo(
    () => (schema?.tables ?? []).filter((x) => (x.type === 'table' || (views && x.type !== 'foreign_table')) && (!scope || (x.schema ?? '') === scope)),
    [schema, scope, views],
  )

  function stop() {
    generation.current++
    for (const id of runIds.current) void api.cancelQuery(id)
    runIds.current.clear()
    setRunning(false)
  }

  async function search() {
    const value = text.trim()
    if (!value || !connection) return
    stop()
    const gen = generation.current
    update(tab.id, { text: value, mode, schema: scope || undefined, title: t('Find “{value}”', { value: value.length > 24 ? `${value.slice(0, 24)}…` : value }) })
    setHits([])
    setFailures([])
    const queue = tables.map((table) => ({ table, conditions: valueSearchConditions(table, value, mode, connection.driver) })).filter((x) => x.conditions.length)
    const total = queue.length
    setProgress({ done: 0, total, searched: '' })
    setRunning(true)
    let done = 0
    const worker = async () => {
      for (;;) {
        const next = queue.shift()
        if (!next || generation.current !== gen) return
        const runId = uid('find')
        runIds.current.add(runId)
        try {
          const page = await api.fetchTable({ connectionId: tab.connectionId, table: { schema: next.table.schema, name: next.table.name }, filter: valueSearchFilter(next.conditions), limit: SAMPLE + 1, offset: 0, runId })
          if (generation.current !== gen) return
          const rows = page.result.rows
          if (rows.length) {
            const hit: Hit = { table: next.table, fields: page.result.fields, rows: rows.slice(0, SAMPLE), more: rows.length > SAMPLE, matched: matchedColumns(page.result.fields, rows, next.conditions, value), conditions: next.conditions }
            setHits((h) => [...h, hit])
          }
        } catch (err) {
          if (generation.current === gen) setFailures((f) => [...f, { table: displayTable(next.table), message: errorMessage(err) }])
        } finally {
          runIds.current.delete(runId)
          done++
          if (generation.current === gen) setProgress({ done, total, searched: displayTable(next.table) })
        }
      }
    }
    await Promise.all(Array.from({ length: PARALLEL }, worker))
    if (generation.current === gen) setRunning(false)
  }

  const open = (hit: Hit) => {
    // Only the columns that held the value (all searched ones when it can't tell, e.g. a contains on a number).
    const conditions = hit.matched.length ? hit.conditions.filter((c) => hit.matched.includes(c.column)) : hit.conditions
    openTab({ kind: 'table', connectionId: tab.connectionId, table: { schema: hit.table.schema, name: hit.table.name }, title: hit.table.name, filter: valueSearchFilter(conditions) })
  }

  const schemas = schema?.schemas ?? []
  return (
    <div className="flex h-full min-h-0 flex-col">
      <form
        className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault()
          void search()
        }}
      >
        <Search size={15} className="text-accent" />
        <Input ref={input} inputSize="sm" className="w-72" placeholder={t('Value to find, e.g. an order number or an e-mail')} value={text} onChange={(e) => setText(e.target.value)} data-testid="find-value-input" />
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'exact', label: t('Exact'), title: t('The whole value: fast, uses indexes') },
            { value: 'contains', label: t('Contains'), title: t('Anywhere in text columns: reads every row') },
          ]}
        />
        {schemas.length > 1 && (
          <Select inputSize="sm" className="w-auto max-w-[220px]" value={scope} onChange={(e) => setScope(e.target.value)} aria-label={t('Schema')}>
            <option value="">{t('All schemas')}</option>
            {schemas.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        )}
        <Checkbox checked={views} onChange={setViews} label={t('Views too')} />
        {running ? (
          <Button size="sm" variant="danger" icon={<Square size={11} fill="currentColor" />} onClick={stop}>
            {t('Stop')}
          </Button>
        ) : (
          <Button size="sm" variant="primary" type="submit" disabled={!text.trim() || !schema}>
            {t('Find')}
          </Button>
        )}
        <span className="text-[11.5px] text-fg-faint">{t('Text, number and date columns are searched; documents, binary and spatial columns are not.')}</span>
      </form>
      {progress && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5 text-[12px] text-fg-muted" data-testid="find-value-progress">
          <span>
            {running ? t('Searching… {done} of {total} tables', { done: formatCount(progress.done), total: formatCount(progress.total) }) : t('Searched {total} tables', { total: formatCount(progress.total) })}
          </span>
          <span className="text-fg-faint">·</span>
          <span className={cn(hits.length && 'font-medium text-fg')}>{tp(hits.length, { one: 'found in {n} table', many: 'found in {n} tables' })}</span>
          {running && progress.searched && <span className="truncate text-fg-faint">{progress.searched}</span>}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {!progress ? (
          <EmptyState icon={<Search size={28} />} title={t('Find a value in all tables')}>
            {t('Type a value and press Enter. Each table is searched with one read; nothing is changed.')}
          </EmptyState>
        ) : !running && hits.length === 0 && failures.length === 0 ? (
          <EmptyState icon={<Search size={28} />} title={t('Not found')}>
            {mode === 'exact' ? t('No table holds exactly this value. Try “Contains”.') : t('No table holds this text.')}
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-3">
            {hits.map((hit) => (
              <HitCard key={`${hit.table.schema}.${hit.table.name}`} hit={hit} onOpen={() => open(hit)} />
            ))}
            {failures.length > 0 && (
              <details className="rounded-md border border-line px-3 py-2 text-[12px] text-fg-muted">
                <summary className="cursor-pointer">{tp(failures.length, { one: '{n} table could not be searched', many: '{n} tables could not be searched' })}</summary>
                <ul className="mt-1.5 flex flex-col gap-1">
                  {failures.map((f) => (
                    <li key={f.table}>
                      <span className="font-medium text-fg">{f.table}</span>: {f.message}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const displayTable = (t: Pick<TableInfo, 'schema' | 'name'>) => (t.schema ? `${t.schema}.${t.name}` : t.name)

function HitCard({ hit, onOpen }: { hit: Hit; onOpen: () => void }) {
  const t = useT()
  // The matched columns first, then the key, then a few more: enough to recognise the row.
  const order = useMemo(() => {
    const index = (name: string) => hit.fields.findIndex((f) => f.name === name)
    const first = [...hit.matched, ...hit.table.primaryKey].map(index).filter((i) => i >= 0)
    const rest = hit.fields.map((_, i) => i).filter((i) => !first.includes(i))
    return [...new Set(first), ...rest].slice(0, 7)
  }, [hit])
  return (
    <div className="overflow-hidden rounded-lg border border-line" data-testid="find-value-hit" data-table={hit.table.name}>
      <div className="flex items-center gap-2 border-b border-line bg-subtle px-3 py-1.5">
        <span className="text-[12.5px] font-semibold">{displayTable(hit.table)}</span>
        {hit.matched.map((c) => (
          <Badge key={c} tone="accent">
            {c}
          </Badge>
        ))}
        <span className="text-[11.5px] text-fg-faint">{hit.more ? t('more than {n} rows', { n: SAMPLE }) : tp(hit.rows.length, { one: '{n} row', many: '{n} rows' })}</span>
        <div className="flex-1" />
        <Button size="xs" icon={<ArrowUpRight size={12} />} onClick={onOpen}>
          {t('Open')}
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono text-[11.5px]">
          <thead>
            <tr>
              {order.map((i) => (
                <th key={i} className={cn('border-b border-line px-2 py-1 text-left font-sans font-semibold whitespace-nowrap text-fg-muted', hit.matched.includes(hit.fields[i]!.name) && 'text-accent')}>
                  {hit.fields[i]!.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {hit.rows.map((row, r) => (
              <tr key={r} className="border-b border-line last:border-b-0">
                {order.map((i) => {
                  const v = row[i] ?? null
                  return (
                    <td key={i} className={cn('max-w-[260px] truncate px-2 py-1 whitespace-nowrap', v === null && 'text-null italic', hit.matched.includes(hit.fields[i]!.name) && 'bg-accent-soft/40')}>
                      {v === null ? 'NULL' : cellToText(v)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { closeCompletion } from '@codemirror/autocomplete'
import { format as formatSql, type SqlLanguage } from 'sql-formatter'
import { Activity, BookmarkPlus, Play, PlayCircle, Sparkles, Square, Wand2 } from 'lucide-react'
import { changesSchema, extractParameters, isDangerousStatement, splitStatements, type DriverId, type ExplainResult, type QueryParameter, type StatementOutcome } from '@dbmastermind/core/browser'
import { openMenu } from '@/components/ui/ContextMenu'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Splitter } from '@/components/ui/Splitter'
import { api, modKey } from '@/lib/api'
import { debounce, errorMessage, uid } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { useSettings } from '@/store/settings'
import { askAi, toast } from '@/store/ui'
import { useWorkspace, type QueryTab } from '@/store/workspace'
import { onCommand } from '@/lib/commands'
import { ParamsModal, type ParamValues } from './ParamsModal'
import { PlanView } from './PlanView'
import { ResultsPanel } from './ResultsPanel'
import { SqlEditor, type SqlEditorHandle } from './SqlEditor'
import { useT } from '@/lib/i18n'
import { confirmAction } from '@/components/ui/ConfirmDialog'

const FORMATTER_LANGUAGE: Record<DriverId, SqlLanguage> = {
  postgres: 'postgresql',
  mssql: 'transactsql',
  mysql: 'mysql',
  mariadb: 'mariadb',
  sqlite: 'sqlite',
  oracle: 'plsql',
  duckdb: 'duckdb',
  clickhouse: 'clickhouse',
  bigquery: 'bigquery',
  trino: 'trino',
}


/** "Load all rows": no practical limit (the grid is virtualized; exports stream instead). */
const ALL_ROWS = 10_000_000
export function QueryView({ tab, active }: { tab: QueryTab; active: boolean }) {
  const connection = useConnections((s) => s.list.find((c) => c.id === tab.connectionId))
  const schema = useConnections((s) => s.runtime[tab.connectionId]?.schema)
  const loadSchema = useConnections((s) => s.loadSchema)
  const dark = useSettings((s) => s.dark)
  const settings = useSettings((s) => s.settings)
  const updateTab = useWorkspace((s) => s.update)
  const editor = useRef<SqlEditorHandle>(null)
  const [outcomes, setOutcomes] = useState<StatementOutcome[] | null>(null)
  const [running, setRunning] = useState(false)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [editorHeight, setEditorHeight] = useState(() => Math.round(window.innerHeight * 0.4))
  const [saveOpen, setSaveOpen] = useState(false)
  const [paramPrompt, setParamPrompt] = useState<{ mode: 'current' | 'all'; params: QueryParameter[] } | null>(null)
  const lastParams = useRef<ParamValues>({})
  const [plan, setPlan] = useState<ExplainResult | null>(null)
  const [explaining, setExplaining] = useState(false)
  const runId = useRef<string | null>(null)
  const lastFragmentOffset = useRef(0)
  const driver = connection?.driver ?? 'postgres'
  const t = useT()

  useEffect(() => {
    if (active && !schema) void loadSchema(tab.connectionId)
  }, [active, schema, loadSchema, tab.connectionId])

  // Persist text without re-rendering the tab list on every keystroke.
  const persistSql = useRef(debounce((id: string, sql: string) => updateTab(id, { sql }), 300)).current

  const lastRun = useRef<{ target: { sql: string; offset: number }; parameterValues?: ParamValues }>(undefined)
  const run = useCallback(
    async (mode: 'current' | 'all', parameterValues?: ParamValues, again?: { maxRows: number }) => {
      // A ref, not state: the menu accelerator and the editor keymap can both fire in the same tick.
      if (runId.current) return
      // An open completion list would float over the parameters dialog (and catch its Enter).
      const view = editor.current?.view()
      if (view) closeCompletion(view)
      // "Load all rows" runs the same statement again, wherever the cursor is now.
      const target = again && lastRun.current ? lastRun.current.target : mode === 'all' ? { sql: editor.current?.getValue() ?? '', offset: 0 } : editor.current?.getRunTarget()
      if (again && lastRun.current) parameterValues = lastRun.current.parameterValues
      if (!target || !target.sql.trim()) return
      if (!parameterValues) {
        const params = extractParameters(target.sql, driver)
        if (params.length) {
          setParamPrompt({ mode, params })
          return
        }
      }
      const statements = splitStatements(target.sql, driver)
      const dangerous = statements.filter((s) => isDangerousStatement(s.text))
      const isProd = connection?.environment === 'production'
      // A read-only connection refuses them anyway: no point asking.
      if (dangerous.length && !connection?.readOnly && (settings?.confirmDangerousStatements !== false || isProd)) {
        const ok = await confirmAction({
          title: dangerous.length === 1 ? t('Run a statement that can delete data?') : t('Run statements that can delete data?'),
          items: dangerous.map((d) => d.text.replace(/\s+/g, ' ').slice(0, 200)),
          warning: isProd ? t('PRODUCTION connection') : undefined,
          confirmLabel: t('Run anyway'),
          danger: true,
        })
        if (!ok) return
      }
      const id = uid('run')
      runId.current = id
      lastFragmentOffset.current = target.offset
      lastRun.current = { target, parameterValues }
      setRunning(true)
      setStartedAt(Date.now())
      setOutcomes(null)
      try {
        setPlan(null)
        const result = await api.runQuery({ connectionId: tab.connectionId, sql: target.sql, runId: id, session: tab.id, parameterValues, maxRows: again?.maxRows })
        if (runId.current !== id) return
        setOutcomes(result)
        const failed = result.find((o) => o.error && o.error.code !== 'CANCELLED')
        if (failed?.error) {
          const pos = failed.error.position
          editor.current?.markError(target.offset + failed.start + (pos ? pos - 1 : 0))
        }
        if (result.some((o) => !o.error && changesSchema(o.sql))) void loadSchema(tab.connectionId, true)
      } catch (err) {
        if (runId.current !== id) return
        setOutcomes([{ sql: target.sql, start: 0, end: target.sql.length, error: { message: errorMessage(err) }, durationMs: 0 }])
      } finally {
        if (runId.current === id) {
          runId.current = null
          setRunning(false)
        }
      }
    },
    [driver, connection?.environment, connection?.readOnly, settings?.confirmDangerousStatements, tab.connectionId, tab.id, loadSchema],
  )

  const explain = useCallback(
    async (analyze: boolean) => {
      const target = editor.current?.getRunTarget()
      if (!target?.sql.trim()) return
      setExplaining(true)
      try {
        setPlan(await api.explainQuery(tab.connectionId, target.sql, analyze))
      } catch (err) {
        toast({ kind: 'error', message: t('Could not explain the query'), detail: errorMessage(err) })
      } finally {
        setExplaining(false)
      }
    },
    [tab.connectionId, t],
  )

  const cancel = useCallback(() => {
    if (runId.current) void api.cancelQuery(runId.current)
    // Back to typing: the Cancel button disappears with the run.
    editor.current?.focus()
  }, [])

  const format = useCallback(() => {
    const text = editor.current?.getValue() ?? ''
    try {
      editor.current?.setValue(formatSql(text, { language: FORMATTER_LANGUAGE[driver], keywordCase: 'upper', tabWidth: 2 }))
    } catch (err) {
      toast({ kind: 'error', message: t('Could not format SQL'), detail: errorMessage(err) })
    }
  }, [driver])

  const save = useCallback(async () => {
    if (tab.savedQueryId) {
      const sql = editor.current?.getValue() ?? ''
      await api.saveQuery({ id: tab.savedQueryId, name: tab.title, sql, connectionId: tab.connectionId })
      updateTab(tab.id, { savedSql: sql })
      toast({ kind: 'success', message: t('Saved “{name}”', { name: tab.title }) })
    } else setSaveOpen(true)
  }, [tab, updateTab, t])

  // Inline AI (Cmd/Ctrl+I): describe the SQL, it lands in the editor (replacing the selection, if any).
  const [inline, setInline] = useState<{ prompt: string; busy: boolean } | null>(null)
  const openInline = useCallback(() => setInline((v) => v ?? { prompt: '', busy: false }), [])
  const submitInline = useCallback(async (promptOverride?: string) => {
    const view = editor.current?.view()
    const prompt = (promptOverride ?? inline?.prompt ?? '').trim()
    if (!prompt || !view) return
    const sel = view.state.selection.main
    const selection = sel.empty ? undefined : view.state.sliceDoc(sel.from, sel.to)
    setInline({ prompt, busy: true })
    try {
      const sql = await api.aiWriteSql(tab.connectionId, prompt, view.state.doc.toString(), selection)
      if (!sql) throw new Error(t('The model returned no SQL'))
      const doc = view.state.doc
      let from = sel.from
      let to = sel.to
      let text = sql
      if (sel.empty) {
        // New statement: on its own lines after the current one, or replacing an empty editor.
        const line = doc.lineAt(sel.head)
        if (doc.toString().trim()) {
          from = to = line.to
          text = `${line.text.trim() ? '\n\n' : ''}${sql}`
        } else {
          from = 0
          to = doc.length
        }
      }
      const start = from + (text.length - sql.length)
      view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: start, head: start + sql.length }, scrollIntoView: true })
      setInline(null)
      view.focus()
    } catch (err) {
      setInline((v) => (v ? { ...v, busy: false } : v))
      toast({ kind: 'error', message: t('AI could not write the SQL'), detail: errorMessage(err) })
    }
  }, [inline, tab.connectionId, t])

  useEffect(() => {
    if (!active) return
    return onCommand((command) => {
      if (command === 'run-current') void run('current')
      else if (command === 'run-all') void run('all')
      else if (command === 'cancel-query') cancel()
      else if (command === 'format-sql') format()
      else if (command === 'save-query') void save()
      else if (command === 'focus-editor') editor.current?.focus()
      else if (command === 'inline-ai') openInline()
    })
  }, [active, run, cancel, format, save, openInline])

  useEffect(() => {
    if (active) requestAnimationFrame(() => editor.current?.focus())
  }, [active])

  // Insert text requested from elsewhere (history, AI, sidebar).
  useEffect(() => {
    const onInsert = (e: Event) => {
      const detail = (e as CustomEvent<{ tabId: string; text: string; replace?: boolean; block?: boolean }>).detail
      if (detail.tabId !== tab.id) return
      if (detail.replace) editor.current?.setValue(detail.text)
      else editor.current?.insert(detail.text, { block: detail.block })
    }
    window.addEventListener('editor:insert', onInsert)
    return () => window.removeEventListener('editor:insert', onInsert)
  }, [tab.id])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-2">
        {running ? (
          <Button size="sm" variant="danger" icon={<Square size={12} fill="currentColor" />} onClick={cancel}>
            {t('Cancel')}
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon={<Play size={13} fill="currentColor" />} onClick={() => void run('current')} title={`${t('Run statement or selection')} (${modKey}↵)`}>
            {t('Run')}
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={<PlayCircle size={14} />} disabled={running} onClick={() => void run('all')} title={`${t('Run whole script')} (⇧${modKey}↵)`}>
          {t('Run all')}
        </Button>
        <div className="mx-1 h-5 w-px bg-line" />
        <Button size="sm" variant="ghost" icon={<Wand2 size={14} />} onClick={format} title={`${t('Format SQL')} (⇧${modKey}F)`}>
          {t('Format')}
        </Button>
        <Button size="sm" variant="ghost" icon={<BookmarkPlus size={14} />} onClick={() => void save()} title={`${t('Save query')} (${modKey}S)`}>
          {t('Save')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<Activity size={14} />}
          loading={explaining}
          onClick={(e) =>
            driver === 'postgres'
              ? openMenu(e.currentTarget, [
                  { label: t('Explain (estimate)'), onClick: () => void explain(false) },
                  { label: t('Explain analyze (runs the query)'), onClick: () => void explain(true) },
                ])
              : void explain(false)
          }
          title={t('Show the execution plan of the statement under the cursor')}
        >
          {t('Explain')}
        </Button>
        <Button size="sm" variant="ghost" icon={<Sparkles size={14} />} onClick={openInline} title={`${t('Ask AI')} (${modKey}I)`}>
          {t('Ask AI')}
        </Button>
        <div className="flex-1" />
        {connection?.readOnly && <span className="text-[11.5px] text-fg-faint">{t('read-only')}</span>}
      </div>
      {inline && (
        <form
          className="flex shrink-0 items-center gap-2 border-b border-line bg-accent-soft/40 px-3 py-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            void submitInline()
          }}
        >
          <Sparkles size={14} className="shrink-0 text-accent" />
          <Input
            autoFocus
            inputSize="sm"
            className="flex-1"
            disabled={inline.busy}
            value={inline.prompt}
            placeholder={editor.current?.view()?.state.selection.main.empty === false ? t('How should the selected SQL change?') : t('Describe the query, e.g. top 10 customers by revenue this year')}
            onChange={(e) => setInline({ ...inline, prompt: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setInline(null)
                editor.current?.focus()
              }
            }}
          />
          <Button size="sm" variant="primary" type="submit" loading={inline.busy} disabled={!inline.prompt.trim()}>
            {t('Write SQL')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              askAi({ prompt: inline.prompt })
              setInline(null)
            }}
          >
            {t('Chat instead')}
          </Button>
        </form>
      )}
      <div style={{ height: editorHeight }} className="min-h-[80px] shrink-0">
        <SqlEditor
          ref={editor}
          value={tab.sql}
          driver={driver}
          schema={schema}
          dark={dark}
          onChange={(sql) => persistSql(tab.id, sql)}
          onRun={() => void run('current')}
          onRunAll={() => void run('all')}
          onFormat={format}
          onSave={() => void save()}
          onAskAi={openInline}
        />
      </div>
      <Splitter direction="vertical" size={editorHeight} onResize={setEditorHeight} min={80} max={window.innerHeight - 200} />
      <div className="min-h-0 flex-1 border-t border-line">
        {plan ? (
          <PlanView plan={plan} onClose={() => setPlan(null)} />
        ) : (
        <ResultsPanel
          outcomes={outcomes}
          running={running}
          startedAt={startedAt}
          driver={driver}
          connectionId={tab.connectionId}
          onLoadAll={() => void run('current', undefined, { maxRows: ALL_ROWS })}
          onFixWithAi={(o) => {
            const view = editor.current?.view()
            if (!view || !o.error) return
            const from = lastFragmentOffset.current + o.start
            view.dispatch({ selection: { anchor: from, head: Math.min(view.state.doc.length, from + o.sql.length) }, scrollIntoView: true })
            void submitInline(t('Fix this statement. It failed with: {error}', { error: o.error.message }))
          }}
          onShowStatement={(o) => {
            const view = editor.current?.view()
            if (!view) return
            const from = lastFragmentOffset.current + o.start
            view.dispatch({ selection: { anchor: from, head: Math.min(view.state.doc.length, from + o.sql.length) }, scrollIntoView: true })
            view.focus()
          }}
        />
        )}
      </div>
      <ParamsModal
        params={paramPrompt?.params ?? null}
        initial={lastParams.current}
        onCancel={() => setParamPrompt(null)}
        onRun={(values) => {
          const mode = paramPrompt?.mode ?? 'current'
          lastParams.current = { ...lastParams.current, ...values }
          setParamPrompt(null)
          void run(mode, values)
        }}
      />
      <SaveQueryModal
        open={saveOpen}
        initialName={/^(Query|Dotaz) \d+$/.test(tab.title) ? '' : tab.title}
        onClose={() => setSaveOpen(false)}
        onSave={async (name, folder) => {
          const sql = editor.current?.getValue() ?? ''
          const saved = await api.saveQuery({ name, folder: folder || undefined, sql, connectionId: tab.connectionId })
          updateTab(tab.id, { savedQueryId: saved.id, title: name, savedSql: sql })
          setSaveOpen(false)
          toast({ kind: 'success', message: t('Saved “{name}”', { name }) })
        }}
      />
    </div>
  )
}

function SaveQueryModal({
  open,
  initialName,
  onClose,
  onSave,
}: {
  open: boolean
  initialName: string
  onClose: () => void
  onSave: (name: string, folder: string) => Promise<void>
}) {
  const [name, setName] = useState(initialName)
  const [folder, setFolder] = useState('')
  const t = useT()
  useEffect(() => {
    if (open) setName(initialName)
  }, [open, initialName])
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('Save query')}
      width={420}
      footer={
        <>
          <div className="flex-1" />
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => void onSave(name.trim(), folder.trim())}>
            {t('Save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) void onSave(name.trim(), folder.trim())
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-fg-muted">{t('Name')}</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Monthly revenue by customer')} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-fg-muted">{t('Folder (optional)')}</span>
          <Input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={t('Reports')} />
        </label>
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

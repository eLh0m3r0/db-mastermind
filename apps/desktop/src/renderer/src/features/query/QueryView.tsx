import { useCallback, useEffect, useRef, useState } from 'react'
import { format as formatSql, type SqlLanguage } from 'sql-formatter'
import { BookmarkPlus, Play, PlayCircle, Sparkles, Square, Wand2 } from 'lucide-react'
import { isDangerousStatement, splitStatements, type DriverId, type StatementOutcome } from '@dbmastermind/core/browser'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Splitter } from '@/components/ui/Splitter'
import { api, modKey } from '@/lib/api'
import { debounce, errorMessage, uid } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { useSettings } from '@/store/settings'
import { toast, useUi } from '@/store/ui'
import { useWorkspace, type QueryTab } from '@/store/workspace'
import { onCommand } from '@/lib/commands'
import { ResultsPanel } from './ResultsPanel'
import { SqlEditor, type SqlEditorHandle } from './SqlEditor'

const FORMATTER_LANGUAGE: Record<DriverId, SqlLanguage> = {
  postgres: 'postgresql',
  mssql: 'transactsql',
  mysql: 'mysql',
  mariadb: 'mariadb',
  sqlite: 'sqlite',
}

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
  const runId = useRef<string | null>(null)
  const lastFragmentOffset = useRef(0)
  const driver = connection?.driver ?? 'postgres'

  useEffect(() => {
    if (active && !schema) void loadSchema(tab.connectionId)
  }, [active, schema, loadSchema, tab.connectionId])

  // Persist text without re-rendering the tab list on every keystroke.
  const persistSql = useRef(debounce((id: string, sql: string) => updateTab(id, { sql }), 300)).current

  const run = useCallback(
    async (mode: 'current' | 'all') => {
      // A ref, not state: the menu accelerator and the editor keymap can both fire in the same tick.
      if (runId.current) return
      const target = mode === 'all' ? { sql: editor.current?.getValue() ?? '', offset: 0 } : editor.current?.getRunTarget()
      if (!target || !target.sql.trim()) return
      const statements = splitStatements(target.sql, driver)
      const dangerous = statements.filter((s) => isDangerousStatement(s.text))
      const isProd = connection?.environment === 'production'
      if (dangerous.length && (settings?.confirmDangerousStatements !== false || isProd)) {
        const list = dangerous.map((d) => `• ${d.text.replace(/\s+/g, ' ').slice(0, 120)}`).join('\n')
        const ok = window.confirm(
          `${isProd ? '⚠️ PRODUCTION connection\n\n' : ''}This will run ${dangerous.length === 1 ? 'a statement' : 'statements'} that can delete data:\n\n${list}\n\nContinue?`,
        )
        if (!ok) return
      }
      const id = uid('run')
      runId.current = id
      lastFragmentOffset.current = target.offset
      setRunning(true)
      setStartedAt(Date.now())
      setOutcomes(null)
      try {
        const result = await api.runQuery({ connectionId: tab.connectionId, sql: target.sql, runId: id, session: tab.id })
        if (runId.current !== id) return
        setOutcomes(result)
        const failed = result.find((o) => o.error)
        if (failed?.error) {
          const pos = failed.error.position
          editor.current?.markError(target.offset + failed.start + (pos ? pos - 1 : 0))
        }
        if (result.some((o) => /^\s*(create|alter|drop|rename)\b/i.test(o.sql) && !o.error)) void loadSchema(tab.connectionId, true)
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
    [driver, connection?.environment, settings?.confirmDangerousStatements, tab.connectionId, tab.id, loadSchema],
  )

  const cancel = useCallback(() => {
    if (runId.current) void api.cancelQuery(runId.current)
  }, [])

  const format = useCallback(() => {
    const text = editor.current?.getValue() ?? ''
    try {
      editor.current?.setValue(formatSql(text, { language: FORMATTER_LANGUAGE[driver], keywordCase: 'upper', tabWidth: 2 }))
    } catch (err) {
      toast({ kind: 'error', message: 'Could not format SQL', detail: errorMessage(err) })
    }
  }, [driver])

  const save = useCallback(async () => {
    if (tab.savedQueryId) {
      const sql = editor.current?.getValue() ?? ''
      await api.saveQuery({ id: tab.savedQueryId, name: tab.title, sql, connectionId: tab.connectionId })
      updateTab(tab.id, { savedSql: sql })
      toast({ kind: 'success', message: `Saved “${tab.title}”` })
    } else setSaveOpen(true)
  }, [tab, updateTab])

  const askAi = useCallback(() => {
    useUi.getState().set({ aiPanelVisible: true })
    window.dispatchEvent(new CustomEvent('ai:ask', { detail: { connectionId: tab.connectionId, sql: editor.current?.getRunTarget()?.sql ?? '' } }))
  }, [tab.connectionId])

  useEffect(() => {
    if (!active) return
    return onCommand((command) => {
      if (command === 'run-current') void run('current')
      else if (command === 'run-all') void run('all')
      else if (command === 'cancel-query') cancel()
      else if (command === 'format-sql') format()
      else if (command === 'save-query') void save()
      else if (command === 'focus-editor') editor.current?.focus()
    })
  }, [active, run, cancel, format, save])

  useEffect(() => {
    if (active) requestAnimationFrame(() => editor.current?.focus())
  }, [active])

  // Insert text requested from elsewhere (history, AI, sidebar).
  useEffect(() => {
    const onInsert = (e: Event) => {
      const detail = (e as CustomEvent<{ tabId: string; text: string; replace?: boolean }>).detail
      if (detail.tabId !== tab.id) return
      if (detail.replace) editor.current?.setValue(detail.text)
      else editor.current?.insert(detail.text)
    }
    window.addEventListener('editor:insert', onInsert)
    return () => window.removeEventListener('editor:insert', onInsert)
  }, [tab.id])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-2">
        {running ? (
          <Button size="sm" variant="danger" icon={<Square size={12} fill="currentColor" />} onClick={cancel}>
            Cancel
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon={<Play size={13} fill="currentColor" />} onClick={() => void run('current')} title={`Run statement or selection (${modKey}↵)`}>
            Run
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={<PlayCircle size={14} />} disabled={running} onClick={() => void run('all')} title={`Run whole script (⇧${modKey}↵)`}>
          Run all
        </Button>
        <div className="mx-1 h-5 w-px bg-line" />
        <Button size="sm" variant="ghost" icon={<Wand2 size={14} />} onClick={format} title={`Format SQL (⇧${modKey}F)`}>
          Format
        </Button>
        <Button size="sm" variant="ghost" icon={<BookmarkPlus size={14} />} onClick={() => void save()} title={`Save query (${modKey}S)`}>
          Save
        </Button>
        <Button size="sm" variant="ghost" icon={<Sparkles size={14} />} onClick={askAi} title={`Ask AI (${modKey}I)`}>
          Ask AI
        </Button>
        <div className="flex-1" />
        {connection?.readOnly && <span className="text-[11.5px] text-fg-faint">read-only</span>}
      </div>
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
          onAskAi={askAi}
        />
      </div>
      <Splitter direction="vertical" size={editorHeight} onResize={setEditorHeight} min={80} max={window.innerHeight - 200} />
      <div className="min-h-0 flex-1 border-t border-line">
        <ResultsPanel
          outcomes={outcomes}
          running={running}
          startedAt={startedAt}
          driver={driver}
          connectionId={tab.connectionId}
          onShowStatement={(o) => {
            const view = editor.current?.view()
            if (!view) return
            const from = lastFragmentOffset.current + o.start
            view.dispatch({ selection: { anchor: from, head: Math.min(view.state.doc.length, from + o.sql.length) }, scrollIntoView: true })
            view.focus()
          }}
        />
      </div>
      <SaveQueryModal
        open={saveOpen}
        initialName={tab.title.startsWith('Query ') ? '' : tab.title}
        onClose={() => setSaveOpen(false)}
        onSave={async (name, folder) => {
          const sql = editor.current?.getValue() ?? ''
          const saved = await api.saveQuery({ name, folder: folder || undefined, sql, connectionId: tab.connectionId })
          updateTab(tab.id, { savedQueryId: saved.id, title: name, savedSql: sql })
          setSaveOpen(false)
          toast({ kind: 'success', message: `Saved “${name}”` })
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
  useEffect(() => {
    if (open) setName(initialName)
  }, [open, initialName])
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save query"
      width={420}
      footer={
        <>
          <div className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => void onSave(name.trim(), folder.trim())}>
            Save
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
          <span className="text-[12px] font-medium text-fg-muted">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Monthly revenue by customer" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-fg-muted">Folder (optional)</span>
          <Input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Reports" />
        </label>
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
